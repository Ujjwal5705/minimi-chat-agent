import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Agent, initialPlan, packHistory } from "../server/agent.js";
import { Store } from "../server/store.js";
import {
  ProviderError,
  type AnswerRequest,
  type Provider,
} from "../server/provider.js";

const now = new Date("2026-11-20T12:00:00.000Z");
function fixture() {
  const store = new Store(":memory:");
  store.importConversation("owner", "Monday CRM", [
    {
      question: "Shortlist 5 CRM tools for 20 salespeople",
      answer:
        "HubSpot, Pipedrive, Zoho CRM, Salesforce, Freshsales. Annual billing in USD.",
      createdAt: "2026-11-16T10:00:00.000Z",
    },
  ]);
  store.importConversation("owner", "Tuesday hosting", [
    {
      question: "Compare Postgres hosting",
      answer: "Neon and Supabase. Compare storage and compute separately.",
      createdAt: "2026-11-17T10:00:00.000Z",
    },
  ]);
  return store;
}
async function run(
  store: Store,
  question: string,
  inspect: (request: AnswerRequest) => void,
  planFails = false,
) {
  let inspected = false;
  const provider: Provider = {
    model: "test-only",
    async plan() {
      if (planFails) throw new Error("quota");
      return {
        mode: "refresh",
        needsHistory: true,
        queries: ["Postgres hosting database"],
        datePhrase: "last Tuesday",
      };
    },
    async answer(request) {
      if (!inspected) {
        inspect(request);
        inspected = true;
      }
      request.onDelta("A test answer.");
      return {
        text: "A test answer.",
        sources: [],
        executedSearches: null,
        usage: null,
      };
    },
  };
  const conversation = store.createConversation("owner");
  const turn = store.beginTurn(
    "owner",
    conversation.id,
    randomUUID(),
    question,
    now.toISOString(),
  );
  return new Agent(store, provider).run({
    owner: "owner",
    turn,
    timezone: "Asia/Kolkata",
    now,
    signal: new AbortController().signal,
    emit() {},
  });
}
test("Monday refresh recovers exactly the original five tools and seat count across chats", async () => {
  const store = fixture();
  try {
    const result = await run(
      store,
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any changed pricing since?",
      (request) => {
        assert.equal(request.search, "required");
        const context = request.messages.find((message) =>
          message.content.startsWith("Application-supplied context"),
        )!.content;
        for (const entity of [
          "HubSpot",
          "Pipedrive",
          "Zoho CRM",
          "Salesforce",
          "Freshsales",
          "20 salespeople",
        ])
          assert.ok(context.includes(entity));
        assert.ok(!context.includes("Compare Postgres hosting"));
      },
    );
    assert.equal(result.status, "complete");
    assert.equal(result.trace?.dateRange?.localDate, "2026-11-16");
  } finally {
    store.close();
  }
});
test("an absent date never substitutes a related conversation from another day", async () => {
  const store = fixture();
  try {
    await run(
      store,
      "What did I ask you on 3 November? Is your answer still correct today?",
      (request) => {
        assert.equal(request.search, "off");
        assert.ok(
          request.messages
            .find((message) =>
              message.content.startsWith("Application-supplied context"),
            )!
            .content.includes('"records":[]'),
        );
        assert.ok(
          request.messages
            .find((message) =>
              message.content.startsWith("Application-supplied context"),
            )!
            .content.includes('"matchingRecordsOnRequestedDate":0'),
        );
      },
    );
  } finally {
    store.close();
  }
});
test("last Tuesday hosting refresh is fresh research; pure recall is search-free", async () => {
  const store = fixture();
  try {
    await run(
      store,
      "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
      (request) => assert.equal(request.search, "required"),
    );
    await run(store, "What did I ask you last Tuesday?", (request) =>
      assert.equal(request.search, "off"),
    );
  } finally {
    store.close();
  }
});
test("planner outage falls back to deterministic date retrieval", async () => {
  const store = fixture();
  try {
    for (let i = 0; i < 12; i++)
      store.importConversation("owner", `Noise ${i}`, [
        {
          question: "unrelated",
          answer: "nothing relevant",
          createdAt: "2026-11-10T10:00:00.000Z",
        },
      ]);
    const result = await run(
      store,
      "Last Tuesday I asked you about Postgres hosting. Has pricing changed since then?",
      (request) => {
        assert.equal(request.search, "required");
        assert.match(
          request.messages.find((message) =>
            message.content.startsWith("Application-supplied context"),
          )!.content,
          /Neon and Supabase/,
        );
      },
      true,
    );
    assert.equal(result.trace?.planner, "fallback");
  } finally {
    store.close();
  }
});
test("context clipping is explicit and original saved text remains intact", () => {
  const store = fixture();
  try {
    const turns = store.recent("owner", 10);
    const result = packHistory(turns, 10);
    assert.equal(result.truncated, true);
    assert.equal(result.turns.length, 0);
    assert.match(store.recent("owner", 10)[0].answer, /Freshsales/);
  } finally {
    store.close();
  }
});
test("new questions do not become memory lookups just because they contain we or last", () => {
  assert.equal(
    initialPlan("We need a new CRM. What do you recommend?").needsHistory,
    false,
  );
  assert.equal(
    initialPlan("Explain last mile network latency").needsHistory,
    false,
  );
  assert.equal(initialPlan("What did I ask you yesterday?").needsHistory, true);
  assert.equal(initialPlan("What did I ask you today?").mode, "recall");
});

test("the current thread survives a hard baseline-date filter for corrections and pronouns", async () => {
  const store = fixture();
  try {
    const conversation = store.createConversation("owner");
    const correction = store.beginTurn(
      "owner",
      conversation.id,
      randomUUID(),
      "Correction: replace Salesforce with Attio in our shortlist.",
      "2026-11-20T10:00:00.000Z",
    );
    store.complete(
      "owner",
      correction.id,
      "Understood: Attio replaces Salesforce.",
      [],
      null,
    );
    const turn = store.beginTurn(
      "owner",
      conversation.id,
      randomUUID(),
      "On Monday we shortlisted 5 CRM tools. Has anything changed since then?",
      now.toISOString(),
    );
    const provider: Provider = {
      model: "test-only",
      async plan() {
        throw new Error("not needed");
      },
      async answer(request) {
        if (request.search === "off")
          return {
            text: "Test answer.",
            sources: [],
            usage: null,
            executedSearches: null,
          };
        const context = JSON.parse(
          request.messages
            .find((message) =>
              message.content.startsWith("Application-supplied context"),
            )!
            .content.split("\n")
            .slice(1)
            .join("\n"),
        );
        assert.equal(context.records[0].createdAt, "2026-11-16T10:00:00.000Z");
        assert.match(
          context.recentThread[0].question,
          /replace Salesforce with Attio/,
        );
        return {
          text: "Test answer.",
          sources: [],
          usage: null,
          executedSearches: null,
        };
      },
    };
    await new Agent(store, provider).run({
      owner: "owner",
      turn,
      now,
      timezone: "UTC",
      signal: new AbortController().signal,
      emit() {},
    });
  } finally {
    store.close();
  }
});

test("refresh answers review actual source excerpts and never stream the unreviewed research draft", async () => {
  const store = fixture();
  const events: string[] = [];
  let calls = 0;
  try {
    const conversation = store.createConversation("owner");
    const turn = store.beginTurn(
      "owner",
      conversation.id,
      randomUUID(),
      "Last Tuesday I asked you about Postgres hosting. Has pricing changed since then?",
      now.toISOString(),
    );
    const provider: Provider = {
      model: "test-only",
      async plan() {
        throw new Error("not needed");
      },
      async answer(request) {
        calls++;
        if (calls === 1) {
          assert.equal(request.search, "required");
          request.onDelta("An unsupported research-draft conclusion.");
          return {
            text: "An unsupported research-draft conclusion.",
            sources: [
              {
                url: "https://example.com/pricing",
                title: "Official pricing",
                origin: "provider",
              },
            ],
            evidence: [
              {
                url: "https://example.com/pricing",
                title: "Official pricing",
                text: "L3: Current tier is $10. No historical price is provided.",
              },
            ],
            executedSearches: 2,
            usage: null,
          };
        }
        assert.equal(request.search, "off");
        assert.ok(
          request.messages.some((message) =>
            message.content.includes("L3: Current tier is $10."),
          ),
        );
        const text =
          "The historical delta is unknown. [Official pricing](https://example.com/pricing).";
        request.onDelta(text);
        return {
          text,
          sources: [
            {
              url: "https://example.com/pricing",
              title: "Official pricing",
              origin: "answer",
            },
          ],
          executedSearches: null,
          usage: null,
        };
      },
    };
    const answer = await new Agent(store, provider).run({
      owner: "owner",
      turn,
      now,
      timezone: "UTC",
      signal: new AbortController().signal,
      emit(event) {
        if (event.type === "delta") events.push(event.text);
      },
    });
    assert.equal(calls, 2);
    assert.ok(!events.join("").includes("unsupported research"));
    assert.equal(answer.sources[0].origin, "provider");
    assert.equal(answer.trace?.synthesis, "evidence-review");
    assert.equal(answer.trace?.executedSearches, 2);
    assert.equal(answer.trace?.evidence?.length, 1);
  } finally {
    store.close();
  }
});

test("a short explicit rate-limit retry repeats only tool-free review, never web research", async () => {
  const store = fixture();
  let searches = 0;
  let reviews = 0;
  try {
    const conversation = store.createConversation("owner");
    const turn = store.beginTurn(
      "owner",
      conversation.id,
      randomUUID(),
      "Last Tuesday I asked you about Postgres hosting. Has pricing changed since then?",
      now.toISOString(),
    );
    const provider: Provider = {
      model: "test-only",
      async plan() {
        throw new Error("not needed");
      },
      async answer(request) {
        if (request.search !== "off") {
          searches++;
          return {
            text: "Research brief.",
            sources: [],
            evidence: [],
            executedSearches: 1,
            usage: null,
          };
        }
        reviews++;
        if (reviews === 1) throw new ProviderError("Rate limited.", 429, 1);
        return {
          text: "The historical delta is unknown.",
          sources: [],
          executedSearches: null,
          usage: null,
        };
      },
    };
    await new Agent(store, provider).run({
      owner: "owner",
      turn,
      now,
      timezone: "UTC",
      signal: new AbortController().signal,
      emit() {},
    });
    assert.equal(searches, 1);
    assert.equal(reviews, 2);
  } finally {
    store.close();
  }
});
