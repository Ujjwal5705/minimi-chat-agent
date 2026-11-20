import express, { type ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Agent } from "./agent.js";
import { ConflictError, NotFoundError, Store } from "./store.js";
import { ProviderError, type Provider } from "./provider.js";
import { validTimezone } from "./time.js";
import type { StreamEvent } from "../shared/types.js";

const uuid = z.uuid();
const turnSchema = z.object({
  conversationId: uuid,
  requestId: uuid,
  question: z.string().trim().min(1).max(12_000),
  timezone: z.string().refine(validTimezone, "Use a valid IANA timezone."),
});
const importSchema = z.object({
  title: z.string().trim().min(1).max(100),
  turns: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(12_000),
        answer: z.string().trim().min(1).max(60_000),
        createdAt: z.iso
          .datetime({ offset: true })
          .refine(
            (value) => Date.parse(value) <= Date.now() + 60_000,
            "History cannot be in the future.",
          ),
      }),
    )
    .min(1)
    .max(100),
});

export function createApp(
  store: Store,
  provider: Provider,
  options: {
    configured: boolean;
    timezone?: string;
    timeoutMs?: number;
    host?: string;
  },
) {
  const app = express();
  const agent = new Agent(store, provider);
  app.disable("x-powered-by");
  app.use("/api", (req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    const hostname = req.hostname;
    const allowed = [
      "localhost",
      "127.0.0.1",
      "[::1]",
      "::1",
      ...(options.host && options.host !== "0.0.0.0" ? [options.host] : []),
    ];
    if (!allowed.includes(hostname))
      return res.status(403).json({
        error: "This local app only accepts requests to its configured host.",
      });
    const origin = req.get("origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}`)
      return res
        .status(403)
        .json({ error: "Cross-origin requests are not allowed." });
    if (req.get("sec-fetch-site") === "cross-site")
      return res
        .status(403)
        .json({ error: "Cross-site requests are not allowed." });
    const cookie = req
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("minimi_session="))
      ?.slice(15);
    const owner = uuid.safeParse(cookie).success ? cookie! : randomUUID();
    if (owner !== cookie)
      res.cookie("minimi_session", owner, {
        httpOnly: true,
        sameSite: "strict",
        secure: req.secure,
        maxAge: 365 * 24 * 60 * 60 * 1000,
      });
    res.locals.owner = owner;
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/config", (_req, res) =>
    res.json({
      configured: options.configured,
      model: provider.model,
      timezone: options.timezone ?? "UTC",
    }),
  );
  app.get("/api/conversations", (_req, res) =>
    res.json(store.listConversations(res.locals.owner)),
  );
  app.post("/api/conversations", (_req, res) =>
    res.status(201).json(store.createConversation(res.locals.owner)),
  );
  app.get("/api/conversations/:id", (req, res) => {
    const id = uuid.parse(req.params.id);
    res.json({
      conversation: store.conversation(res.locals.owner, id),
      turns: store.turns(res.locals.owner, id),
    });
  });
  app.delete("/api/conversations/:id", (req, res) => {
    store.deleteConversation(res.locals.owner, uuid.parse(req.params.id));
    res.status(204).end();
  });
  app.get("/api/conversations/:id/export", (req, res) => {
    const id = uuid.parse(req.params.id);
    const conversation = store.conversation(res.locals.owner, id);
    const turns = store
      .turns(res.locals.owner, id)
      .filter((turn) => turn.status === "complete")
      .map(({ question, answer, createdAt }) => ({
        question,
        answer,
        createdAt,
      }));
    res
      .set(
        "Content-Disposition",
        'attachment; filename="minimi-conversation.json"',
      )
      .json({ title: conversation.title, turns });
  });
  app.post("/api/import", (req, res) => {
    const body = importSchema.parse(req.body);
    const turns = body.turns
      .map((turn) => ({
        ...turn,
        createdAt: new Date(turn.createdAt).toISOString(),
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    res
      .status(201)
      .json(store.importConversation(res.locals.owner, body.title, turns));
  });
  const rate = new Map<string, number[]>();
  app.post("/api/chat", async (req, res, next) => {
    let activeTurn: string | null = null;
    const owner = String(res.locals.owner);
    const controller = new AbortController();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const emit = (event: StreamEvent): void => {
      if (!res.destroyed && !res.writableEnded)
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const onClose = (): void => {
      if (!res.writableEnded)
        controller.abort(new Error("Client disconnected."));
    };
    try {
      const body = turnSchema.parse(req.body);
      store.conversation(owner, body.conversationId);
      const previous = store.byRequest(owner, body.requestId);
      if (previous) {
        if (
          previous.question !== body.question ||
          previous.conversationId !== body.conversationId
        )
          throw new ConflictError(
            "This request ID was already used for a different message.",
          );
        if (previous.status !== "complete")
          throw new ConflictError(
            "This message is already running or was interrupted. Send a new request to retry.",
          );
        res.set({
          "Content-Type": "text/event-stream",
          "X-Accel-Buffering": "no",
        });
        emit({ type: "done", turn: previous });
        return res.end();
      }
      if (!options.configured)
        throw new ProviderError(
          "Add GROQ_API_KEY to .env, then restart npm run dev.",
          503,
        );
      const now = Date.now();
      if (rate.size > 1000)
        for (const [key, values] of rate)
          if (values.at(-1)! < now - 60_000) rate.delete(key);
      const recent = (rate.get(owner) ?? []).filter(
        (time) => time > now - 60_000,
      );
      if (recent.length >= 20)
        throw new ProviderError(
          "Too many messages. Please wait a minute.",
          429,
        );
      rate.set(owner, [...recent, now]);
      const turn = store.beginTurn(
        owner,
        body.conversationId,
        body.requestId,
        body.question,
        new Date(now).toISOString(),
      );
      activeTurn = turn.id;
      res.set({
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      res.on("close", onClose);
      heartbeat = setInterval(() => {
        if (!res.destroyed) res.write(": heartbeat\n\n");
      }, 15_000);
      deadline = setTimeout(
        () =>
          controller.abort(
            new Error("This answer took too long. Try a narrower question."),
          ),
        options.timeoutMs ?? 180_000,
      );
      const complete = await agent.run({
        owner,
        turn,
        timezone: body.timezone,
        now: new Date(now),
        signal: controller.signal,
        emit,
      });
      emit({ type: "done", turn: complete });
      res.end();
    } catch (error) {
      if (activeTurn) store.fail(owner, activeTurn, controller.signal.aborted);
      if (!res.headersSent) return next(error);
      const message = controller.signal.aborted
        ? String(
            (controller.signal.reason as Error)?.message ?? "Answer stopped.",
          )
        : error instanceof ProviderError
          ? error.message
          : "Something went wrong while answering. Please try again.";
      emit({ type: "error", message });
      res.end();
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      res.off("close", onClose);
    }
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof z.ZodError)
      return void res.status(400).json({
        error:
          "Invalid request. Check message length, dates, IDs, and timezone.",
      });
    if (error instanceof NotFoundError)
      return void res.status(404).json({ error: error.message });
    if (error instanceof ConflictError)
      return void res.status(409).json({ error: error.message });
    if (error instanceof ProviderError)
      return void res.status(error.status).json({ error: error.message });
    const status =
      typeof error?.status === "number" &&
      error.status >= 400 &&
      error.status < 500
        ? error.status
        : 500;
    res.status(status).json({
      error:
        status === 413
          ? "Import is too large. Use a JSON file under 2 MB."
          : "The request could not be processed.",
    });
  };
  app.use("/api", errors);
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API route not found." }),
  );
  return app;
}
