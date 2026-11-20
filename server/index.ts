import "dotenv/config";
import express from "express";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { Store } from "./store.js";
import { GroqProvider } from "./provider.js";
import { validTimezone } from "./time.js";

const apiKey = process.env.GROQ_API_KEY?.trim() ?? "";
const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
if (!["openai/gpt-oss-120b", "openai/gpt-oss-20b"].includes(model))
  throw new Error(
    "GROQ_MODEL must support browser_search: use openai/gpt-oss-120b or openai/gpt-oss-20b.",
  );
const timezone = process.env.APP_TIMEZONE || "UTC";
if (!validTimezone(timezone))
  throw new Error(
    "APP_TIMEZONE must be an IANA timezone such as Asia/Kolkata.",
  );
const timeoutMs = Number(process.env.TURN_TIMEOUT_MS || 180_000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000)
  throw new Error("TURN_TIMEOUT_MS must be between 1000 and 600000.");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const store = new Store(
  resolve(process.env.DATA_DIR || ".data", "minimi.sqlite"),
);
store.recoverInterrupted();
const provider = new GroqProvider(
  apiKey,
  model,
  process.env.GROQ_PLANNER_MODEL || "openai/gpt-oss-20b",
  fetch,
  process.env.GROQ_REVIEW_MODEL || "openai/gpt-oss-20b",
);
const app = createApp(store, provider, {
  configured: Boolean(apiKey),
  timezone,
  timeoutMs,
  host,
});
const server = createServer(app);
let vite:
  Awaited<ReturnType<(typeof import("vite"))["createServer"]>> | undefined;
if (
  process.env.NODE_ENV === "production" ||
  process.argv.includes("--production")
) {
  app.use(express.static(resolve("dist"), { index: false }));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const { createServer: createViteServer } = await import("vite");
  vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
server.listen(port, host, () => {
  console.log(
    `\n  minimi · http://${host}:${port}\n  ${model} · ${apiKey ? "Groq configured" : "Add GROQ_API_KEY to .env to enable chat"}\n`,
  );
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  await vite?.close();
  store.close();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
