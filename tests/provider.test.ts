import { test } from "node:test";
import assert from "node:assert/strict";
import { GroqProvider, ProviderError } from "../server/provider.js";
import { readSSE } from "../shared/sse.js";
import { browserEvidence, collectSources, safeUrl } from "../server/sources.js";

function bodyFrom(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize)
        controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
}
function stream(events: unknown[], done = true): Response {
  return new Response(
    bodyFrom(
      events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") +
        (done ? "data: [DONE]\r\n\r\n" : ""),
    ),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const signal = new AbortController().signal;

test("SSE parser handles split UTF-8, CRLF, comments, and multiline data", async () => {
  const data =
    ": heartbeat\r\n\r\ndata: café\r\ndata: 第二行\r\n\r\ndata: [DONE]\r\n\r\n";
  const frames: string[] = [];
  for await (const frame of readSSE(bodyFrom(data, 1))) frames.push(frame);
  assert.deepEqual(frames, ["café\n第二行", "[DONE]"]);
});
test("only browser search is exposed, reasoning stays hidden, and missing execution metadata stays unknown", async () => {
  let requestBody: Record<string, unknown> = {};
  const fetcher: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init!.body));
    return stream([
      { choices: [{ delta: { reasoning: "private chain of thought" } }] },
      {
        choices: [
          {
            delta: {
              content: "See [official pricing](https://neon.tech/pricing).",
            },
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      },
    ]);
  };
  const deltas: string[] = [];
  const response = await new GroqProvider(
    "secret-for-test",
    undefined,
    undefined,
    fetcher,
  ).answer({
    messages: [{ role: "user", content: "Check pricing" }],
    search: "required",
    signal,
    onDelta: (text) => deltas.push(text),
  });
  assert.deepEqual(requestBody.tools, [{ type: "browser_search" }]);
  assert.equal(requestBody.tool_choice, "required");
  assert.equal(requestBody.include_reasoning, false);
  assert.ok(!deltas.join("").includes("chain of thought"));
  assert.equal(response.executedSearches, null);
  assert.equal(response.sources[0].origin, "answer");
  assert.equal(response.usage?.promptTokens, 12);
});
test("provider metadata stays distinct from model-written links", async () => {
  const fetcher: typeof fetch = async () =>
    stream([
      {
        choices: [
          { delta: { content: "See [pricing](https://example.com/pricing)." } },
        ],
        executed_tools: [
          {
            id: "search-1",
            type: "browser_search",
            results: [
              { url: "https://example.com/pricing", title: "Official pricing" },
            ],
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
  const response = await new GroqProvider(
    "test",
    undefined,
    undefined,
    fetcher,
  ).answer({ messages: [], search: "required", signal, onDelta() {} });
  assert.equal(response.sources.length, 1);
  assert.equal(response.sources[0].origin, "provider");
  assert.equal(response.executedSearches, 1);
});
test("a truncated or unterminated upstream answer is never accepted as complete", async () => {
  for (const [finish, done] of [
    ["length", true],
    ["stop", false],
  ] as const) {
    const fetcher: typeof fetch = async () =>
      stream(
        [
          {
            choices: [
              { delta: { content: "partial answer" }, finish_reason: finish },
            ],
          },
        ],
        done,
      );
    await assert.rejects(
      () =>
        new GroqProvider("test", undefined, undefined, fetcher).answer({
          messages: [],
          search: "off",
          signal,
          onDelta() {},
        }),
      ProviderError,
    );
  }
});
test("429 shows retry guidance without leaking the upstream error body or retrying blindly", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response("private prompt and secret key", {
      status: 429,
      headers: { "Retry-After": "12" },
    });
  };
  await assert.rejects(
    () =>
      new GroqProvider("test", undefined, undefined, fetcher).answer({
        messages: [],
        search: "off",
        signal,
        onDelta() {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /12 seconds/);
      assert.ok(!error.message.includes("secret key"));
      return true;
    },
  );
  assert.equal(calls, 1);
});
test("structured planning explicitly disables all tools and validates the model output", async () => {
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init!.body));
    assert.deepEqual(request.tools, []);
    assert.equal(request.tool_choice, "none");
    assert.equal(request.response_format.type, "json_schema");
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "refresh",
              needsHistory: true,
              queries: ["Postgres hosting"],
              datePhrase: "last Tuesday",
            }),
          },
        },
      ],
    });
  };
  const plan = await new GroqProvider(
    "test",
    undefined,
    undefined,
    fetcher,
  ).plan([], signal);
  assert.equal(plan.datePhrase, "last Tuesday");
});
test("unsafe URLs never become source cards", () => {
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("https://secret:password@example.com"), null);
  assert.equal(
    collectSources("[bad](javascript:alert(1))", [
      { url: "data:text/plain,no" },
    ]).length,
    0,
  );
});

test("actual Groq numbered-result format resolves inline citations and observed line excerpts", () => {
  const tools = [
    {
      name: "browser.search",
      index: 0,
      type: "browser_search",
      output: "L4: 【0†Official pricing†example.com】",
      search_results: {
        results: [
          {
            title: "Official pricing",
            url: "https://example.com/pricing",
            content: "",
          },
        ],
      },
    },
    {
      name: "browser.open",
      index: 1,
      type: "browser.open",
      output:
        "L0: \nL1: URL: https://example.com/pricing\nL2: Official pricing\nL3: Tier A is $10 per seat monthly.\nL4: Updated 2026-11-01.",
    },
  ];
  const result = browserEvidence("Tier A is $10【0†L3-L4】.", tools);
  assert.equal(result.text, "Tier A is $10[1](https://example.com/pricing).");
  assert.equal(result.unresolved, false);
  assert.match(result.evidence[0].text, /Tier A is \$10/);
  assert.equal(result.evidence[0].url, "https://example.com/pricing");
  const missing = browserEvidence("Unsupported【99†L1-L2】", tools);
  assert.equal(missing.unresolved, true);
  assert.match(missing.text, /source reference unavailable/);
});

test("ambiguous browser IDs never become guessed citations", () => {
  const result = browserEvidence(
    "Claim【0†L2】",
    ["a", "b"].map((name) => ({
      output: "【0†Title†host】",
      search_results: {
        results: [{ url: `https://${name}.example`, title: name }],
      },
    })),
  );
  assert.equal(result.unresolved, true);
  assert.ok(!result.text.includes("](https:"));
});

test("oversized requests do not tell the user that waiting will fix the token budget", async () => {
  const fetcher: typeof fetch = async () =>
    Response.json(
      {
        error: {
          message:
            "Request too large for model in organization private-org: Limit 8000, Requested 14000.",
        },
      },
      { status: 429, headers: { "Retry-After": "30" } },
    );
  await assert.rejects(
    () =>
      new GroqProvider("test", undefined, undefined, fetcher).answer({
        messages: [],
        search: "off",
        signal,
        onDelta() {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /waiting alone will not fix/);
      assert.ok(!error.message.includes("private-org"));
      assert.equal(error.retryAfterMs, null);
      return true;
    },
  );
});
