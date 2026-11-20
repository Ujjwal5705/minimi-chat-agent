import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "../server/agent.js";
import { Store } from "../server/store.js";
import { GroqProvider } from "../server/provider.js";

const key = process.env.GROQ_API_KEY?.trim();
if (!key) {
  console.error(
    "Set GROQ_API_KEY in .env before running live evaluation. No calls were made.",
  );
  process.exit(1);
}
const now = new Date("2026-11-20T12:00:00.000Z");
const cases = [
  {
    id: "crm-change",
    question:
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    baseline: "crm",
    expectedSearch: "required",
    expectedMemory: 1,
  },
  {
    id: "november-recall-refresh",
    question:
      "What did I ask you on 3 November? Is your answer still correct today?",
    baseline: "november",
    expectedSearch: "required",
    expectedMemory: 2,
  },
  {
    id: "hosting-change",
    question:
      "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    baseline: "hosting",
    expectedSearch: "required",
    expectedMemory: 1,
  },
  {
    id: "missing-history",
    question:
      "What did I ask you on 3 November? Is your answer still correct today?",
    baseline: null,
    expectedSearch: "off",
    expectedMemory: 0,
  },
  {
    id: "pure-recall",
    question: "What did I ask you on 3 November?",
    baseline: "november",
    expectedSearch: "off",
    expectedMemory: 2,
  },
  {
    id: "old-answer-error",
    question:
      "Last Tuesday I asked you about Neon. Is your answer still correct today?",
    baseline: "wrong",
    expectedSearch: "required",
    expectedMemory: 1,
  },
];
const fixtures = {
  crm: [
    {
      question:
        "Shortlist 5 CRM tools for 20 salespeople on annual USD billing.",
      answer:
        "HubSpot, Pipedrive, Zoho CRM, Salesforce, and Freshsales. We have no exact historical prices.",
      createdAt: "2026-11-16T10:00:00.000Z",
    },
  ],
  november: [
    {
      question: "Which Postgres hosts should a small SaaS compare?",
      answer:
        "Compare Neon, Supabase, and Render. Check compute, storage, backups and usage separately. Historical prices were not recorded.",
      createdAt: "2026-11-03T09:00:00.000Z",
    },
    {
      question: "What does serializable isolation mean?",
      answer:
        "Transactions behave as if they ran in some serial order, but applications can need to retry serialization failures.",
      createdAt: "2026-11-03T11:00:00.000Z",
    },
  ],
  hosting: [
    {
      question:
        "Compare Postgres hosting from Neon, Supabase, and Render on monthly USD billing.",
      answer:
        "Compare Neon, Supabase, and Render. Separate compute, storage, transfer and backup costs. Historical prices are unknown.",
      createdAt: "2026-11-17T09:00:00.000Z",
    },
  ],
  wrong: [
    {
      question: "Does Neon have any paid plans?",
      answer:
        "No, Neon has no paid plans. (Deliberately incorrect synthetic historical answer for evaluation.)",
      createdAt: "2026-11-17T09:00:00.000Z",
    },
  ],
};
const outputDir = resolve(
  "eval-results",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const selectedCases = cases.filter(
  (c) => !process.env.EVAL_CASE || c.id === process.env.EVAL_CASE,
);
if (!selectedCases.length) {
  console.error("Unknown EVAL_CASE. No calls were made.");
  process.exit(1);
}
mkdirSync(outputDir, { recursive: true });
let failed = false;
for (const example of selectedCases) {
  const store = new Store(":memory:");
  const owner = randomUUID();
  try {
    if (example.baseline)
      store.importConversation(
        owner,
        "Synthetic evaluation history",
        fixtures[example.baseline as keyof typeof fixtures],
      );
    const conversation = store.createConversation(owner);
    const turn = store.beginTurn(
      owner,
      conversation.id,
      randomUUID(),
      example.question,
      now.toISOString(),
    );
    const provider = new GroqProvider(
      key,
      process.env.GROQ_MODEL || "openai/gpt-oss-120b",
      process.env.GROQ_PLANNER_MODEL || "openai/gpt-oss-20b",
      fetch,
      process.env.GROQ_REVIEW_MODEL || "openai/gpt-oss-20b",
    );
    const answer = await new Agent(store, provider).run({
      owner,
      turn,
      timezone: "Asia/Kolkata",
      now,
      signal: AbortSignal.timeout(180_000),
      emit() {},
    });
    const mechanicalChecks = {
      expectedSearchPolicy: answer.trace?.search === example.expectedSearch,
      expectedBaselineCount:
        answer.trace?.memory.length === example.expectedMemory,
      completeAnswer: answer.status === "complete",
      hasInlineLinksWhenResearchRequested:
        example.expectedSearch !== "required" ||
        /\[[^\]]+\]\(https?:\/\//.test(answer.answer),
      hasNoUnresolvedCitationTokens: !/【\d+†L|〖|cite/.test(answer.answer),
    };
    const passed = Object.values(mechanicalChecks).every(Boolean);
    if (!passed) failed = true;
    writeFileSync(
      resolve(outputDir, `${example.id}.json`),
      JSON.stringify(
        {
          case: example.id,
          referenceClock: now.toISOString(),
          actualRunAt: new Date().toISOString(),
          syntheticHistory: true,
          mechanicalChecks,
          answer,
        },
        null,
        2,
      ),
    );
    console.log(
      `${example.id}: ${passed ? "mechanical checks passed" : "mechanical checks failed"}; ${(answer.trace!.elapsedMs / 1000).toFixed(1)}s; human review required`,
    );
  } catch (error) {
    failed = true;
    console.error(
      `${example.id}: live call failed: ${(error as Error).message}`,
    );
    writeFileSync(
      resolve(outputDir, `${example.id}.json`),
      JSON.stringify(
        { case: example.id, error: (error as Error).message },
        null,
        2,
      ),
    );
  } finally {
    store.close();
  }
}
console.log(
  `Results: ${outputDir}\nApply evals/RUBRIC.md; these checks are not an answer-quality benchmark.`,
);
if (failed) process.exitCode = 1;
