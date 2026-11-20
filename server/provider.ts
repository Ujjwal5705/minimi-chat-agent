import { z } from "zod";
import { readSSE } from "../shared/sse.js";
import type { EvidenceExcerpt, Plan, Source } from "../shared/types.js";
import { browserEvidence, collectSources, record } from "./sources.js";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface AnswerRequest {
  messages: Message[];
  search: "off" | "auto" | "required";
  signal: AbortSignal;
  onDelta: (text: string) => void;
  purpose?: "answer" | "research" | "review";
}
export interface AnswerResult {
  text: string;
  rawText?: string;
  evidence?: EvidenceExcerpt[];
  unresolvedCitations?: boolean;
  sources: Source[];
  executedSearches: number | null;
  usage: { promptTokens: number; completionTokens: number } | null;
}
export interface Provider {
  readonly model: string;
  readonly reviewModel?: string;
  plan(messages: Message[], signal: AbortSignal): Promise<Plan>;
  answer(request: AnswerRequest): Promise<AnswerResult>;
}

const planSchema = z.object({
  mode: z.enum(["answer", "recall", "refresh"]),
  needsHistory: z.boolean(),
  queries: z.array(z.string().max(180)).max(3),
  datePhrase: z.string().max(80).nullable(),
});
const jsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["answer", "recall", "refresh"] },
    needsHistory: { type: "boolean" },
    queries: { type: "array", items: { type: "string" } },
    datePhrase: { type: ["string", "null"] },
  },
  required: ["mode", "needsHistory", "queries", "datePhrase"],
};

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export class GroqProvider implements Provider {
  readonly model: string;
  constructor(
    private readonly apiKey: string,
    model = "openai/gpt-oss-120b",
    private readonly plannerModel = "openai/gpt-oss-20b",
    private readonly fetcher: typeof fetch = fetch,
    readonly reviewModel = "openai/gpt-oss-20b",
  ) {
    this.model = model;
  }

  private async request(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    if (!this.apiKey)
      throw new ProviderError(
        "Add GROQ_API_KEY to .env, then restart npm run dev.",
        503,
      );
    let response: Response;
    try {
      response = await this.fetcher(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ProviderError(
        "Could not reach Groq. Check your internet connection and try again.",
      );
    }
    if (!response.ok) {
      // Never forward a raw upstream body: it can contain prompt text or credentials.
      const errorBody = record(await response.json().catch(() => ({})));
      if (response.status === 429) {
        const detail = record(errorBody.error).message;
        const oversized =
          typeof detail === "string" && /request too large/i.test(detail);
        if (oversized)
          throw new ProviderError(
            "This request exceeds the model’s token-per-minute limit. Narrow the question or reduce the imported history; waiting alone will not fix an oversized request.",
            429,
          );
        const retry = response.headers.get("retry-after");
        const seconds =
          retry && /^\d+(\.\d+)?$/.test(retry)
            ? Math.ceil(Number(retry))
            : null;
        throw new ProviderError(
          `Groq's rate limit was reached.${seconds ? ` Try again in ${seconds} seconds.` : " Wait a moment, then try again."} Free-tier quotas may limit longer searches.`,
          429,
          seconds ? seconds * 1000 : null,
        );
      }
      if (response.status === 401 || response.status === 403)
        throw new ProviderError(
          "Groq rejected this key or model access. Check GROQ_API_KEY and your Groq project permissions.",
          503,
        );
      if (response.status === 400 || response.status === 404)
        throw new ProviderError(
          "Groq rejected the model or browser-search configuration. Use openai/gpt-oss-120b or openai/gpt-oss-20b; check that browser search is enabled for your account.",
          502,
        );
      throw new ProviderError(
        `Groq is temporarily unavailable (HTTP ${response.status}). Try again shortly.`,
      );
    }
    return response;
  }

  async plan(messages: Message[], signal: AbortSignal): Promise<Plan> {
    const response = await this.request(
      {
        model: this.plannerModel,
        messages,
        stream: false,
        tools: [],
        tool_choice: "none",
        reasoning_effort: "low",
        include_reasoning: false,
        max_completion_tokens: 700,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "retrieval_plan",
            strict: true,
            schema: jsonSchema,
          },
        },
      },
      signal,
    );
    const result = record(await response.json());
    const choice = record((result.choices as unknown[])?.[0]);
    const content = record(choice.message).content;
    if (typeof content !== "string")
      throw new ProviderError("No retrieval plan returned.");
    return planSchema.parse(JSON.parse(content));
  }

  async answer({
    messages,
    search,
    signal,
    onDelta,
    purpose,
  }: AnswerRequest): Promise<AnswerResult> {
    const response = await this.request(
      {
        model: purpose === "review" ? this.reviewModel : this.model,
        messages,
        stream: true,
        tools: search === "off" ? [] : [{ type: "browser_search" }],
        tool_choice: search === "off" ? "none" : search,
        reasoning_effort: "low",
        include_reasoning: false,
        max_completion_tokens: purpose === "research" ? 4096 : 2048,
        stream_options: { include_usage: true },
      },
      signal,
    );
    if (!response.body)
      throw new ProviderError("Groq returned an empty response.");
    let text = "";
    let finish: string | null = null;
    let done = false;
    let usage: AnswerResult["usage"] = null;
    const metadata: unknown[] = [];
    const executed = new Map<string, unknown>();
    let executionTraceExposed = false;
    for await (const data of readSSE(response.body)) {
      if (data === "[DONE]") {
        done = true;
        break;
      }
      const event = record(JSON.parse(data));
      if (event.error)
        throw new ProviderError(
          "Groq interrupted the response. Please try again.",
        );
      const choice = record((event.choices as unknown[])?.[0]);
      const delta = record(choice.delta);
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
        throw new ProviderError(
          "Groq returned an unexpected client tool call. Only hosted browser search is supported.",
        );
      if (typeof delta.content === "string") {
        text += delta.content;
        if (text.length > 150_000)
          throw new ProviderError(
            "The response exceeded the answer size limit.",
          );
        onDelta(delta.content);
      }
      if (typeof choice.finish_reason === "string")
        finish = choice.finish_reason;
      const providerUsage = record(event.usage ?? record(event.x_groq).usage);
      if (typeof providerUsage.prompt_tokens === "number") {
        usage = {
          promptTokens: providerUsage.prompt_tokens,
          completionTokens: Number(providerUsage.completion_tokens ?? 0),
        };
      }
      for (const item of [event, delta, record(event.x_groq)]) {
        for (const key of ["citations", "annotations", "executed_tools"]) {
          if (item[key]) metadata.push(item[key]);
        }
        if (Array.isArray(item.executed_tools)) {
          executionTraceExposed = true;
          for (const tool of item.executed_tools) {
            const entry = record(tool);
            executed.set(
              String(entry.id ?? entry.index ?? JSON.stringify(entry)),
              entry,
            );
          }
        }
      }
    }
    if (!done || finish !== "stop" || !text.trim()) {
      throw new ProviderError(
        finish === "length"
          ? "The answer reached Groq’s output limit. Try a narrower question."
          : "The connection ended before the answer was complete. Please try again.",
      );
    }
    const browser = browserEvidence(text, [...executed.values()]);
    return {
      text: browser.text,
      rawText: text,
      evidence: browser.evidence,
      unresolvedCitations: browser.unresolved,
      sources: collectSources(browser.text, metadata),
      usage,
      executedSearches: executionTraceExposed
        ? [...executed.values()].filter((t) =>
            /search|browser/i.test(
              JSON.stringify(record(t).type ?? record(t).name ?? ""),
            ),
          ).length
        : null,
    };
  }
}
