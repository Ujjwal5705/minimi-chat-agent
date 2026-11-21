# minimi

A conversational agent that remembers earlier discussions and checks what has changed. Built for the minimi hiring challenge using TypeScript, Node, SQLite, and **Groq GPT-OSS**. Its only model tool is web search.

Read the one-page [DESIGN.md](DESIGN.md) for the architecture and tradeoffs.

## Run

Requires **Node 22.13+** and npm. Node's built-in SQLite avoids native dependency compilation, Node 22 may print an experimental SQLite warning.

```sh
npm install
cp .env.example .env
# Set GROQ_API_KEY in .env
npm run dev
```

Open **http://127.0.0.1:3000**. The app starts without a key so you can inspect the UI and import history, sending messages requires the key. Windows users can copy `.env.example` to `.env` in Explorer or use `Copy-Item .env.example .env` in PowerShell. Restart the server after changing `.env`.

The **only required credential is `GROQ_API_KEY`**, created at [Groq Console](https://console.groq.com/keys). Default main model: `openai/gpt-oss-120b`, history planner and source-excerpt review: `openai/gpt-oss-20b`. For tighter quotas, set `GROQ_MODEL=openai/gpt-oss-20b`. The review model is separately configurable as `GROQ_REVIEW_MODEL`. All configuration is listed in [.env.example](.env.example). Keys stay on the server and are ignored by Git.

Groq offers model access under account-specific quotas. Hosted browser search also has provider pricing and availability: do not assume unlimited or permanently free search. Search is never automatically retried. A tool-free source review may retry once after an explicit `Retry-After` of at most 60 seconds, with visible status and cancellation. Oversized requests and longer quota resets return actionable errors. See [Groq rate limits](https://console.groq.com/docs/rate-limits) and [browser search](https://console.groq.com/docs/tool-use/built-in-tools/browser-search). Only the standard Groq endpoint is used, regional endpoints may not support the search tool.

## Try the memory examples

Every new chat in the **same browser session** shares saved history. Restarting the server preserves it. A different browser/private window gets a separate history. Don't clear the session cookie if you want to keep access to your saved chats.

Use **Import history** to load an earlier conversation as JSON. Imported answers are marked as unverified historical text. There is no hidden preloaded conversation. An example is in [fixtures/example-history.json](fixtures/example-history.json), it contains synthetic discussions, not researched pricing. Its dates are fixed for inspection. For “Monday” or “last Tuesday” tests on another week, change the imported timestamps or use the explicit original date. The app's current date always comes from the server clock, with calendar boundaries interpreted in your browser timezone.

```json
{
  "title": "Earlier CRM discussion",
  "turns": [
    {
      "question": "Shortlist 5 CRM tools for 20 salespeople.",
      "answer": "Consider HubSpot, Pipedrive, Zoho CRM, Salesforce, and Freshsales. Compare annual USD plans.",
      "createdAt": "2026-11-16T10:00:00Z"
    }
  ]
}
```

Then start a new conversation and ask:

- “On 16 November we shortlisted 5 CRM tools for a 20-person sales team. Has any changed pricing or shipped something big since?”
- “What did I ask you on 3 November? Is your answer still correct today?”
- “Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?”

The second and third prompts should acknowledge missing history unless you've actually saved or imported discussions on those dates. Use the other fixture files to supply them. **Export** saves the current conversation's complete questions, answers, and timestamps for later import, it deliberately does not claim to preserve verified source provenance. Delete removes that conversation from both storage and the search index.

## Checks and evaluation

```sh
npm test          # deterministic tests, no key or external network required
npm run check    # strict TypeScript
npm run build    # typecheck + production UI build
npm start        # serve the production build
npm run eval     # real Groq calls, requires key and consumes quota
```

Tests use an explicitly fake provider to check orchestration, calendar boundaries/DST, cross-chat retrieval, session isolation, source provenance, pending/failed states, API validation, idempotency, and split UTF-8 SSE streams. They do **not** prove live search availability or factual answer quality. HTTP integration tests bind an ephemeral loopback port.

The live evaluation seeds an isolated in-memory store, freezes its reference clock to 20 November 2026, and exercises the three challenge examples plus missing history, pure recall, and a deliberately wrong historical claim. It writes answers and traces to the ignored `eval-results/` directory. Actual web evidence remains live, the fixed clock makes conversation references reproducible, not the web. Read [evals/RUBRIC.md](evals/RUBRIC.md) before grading the outputs. Mechanical checks test routing and context, a person must judge factual claims, coverage, and citations. Set `EVAL_CASE` to one case ID to conserve quota.

## Where to look

| File                 | Responsibility                                                     |
| -------------------- | ------------------------------------------------------------------ |
| `server/agent.ts`    | Retrieval, fast paths, context budget, search policy, trace        |
| `server/store.ts`    | SQLite/FTS5, session scopes, transactions, pending/completed state |
| `server/time.ts`     | Calendar interpretation and UTC query intervals                    |
| `server/provider.ts` | Groq-only HTTP adapter, structured planning, streaming, errors     |
| `server/prompts.ts`  | Evidence, comparison, ambiguity, and conversation policy           |
| `server/app.ts`      | HTTP contract, session cookie, origin checks, cancellation         |
| `shared/sse.ts`      | Stream decoder shared by browser and server                        |
| `src/main.tsx`       | Chat, import/export, citations, memory links, execution details    |

Data lives in `.data/minimi.sqlite` plus SQLite WAL files. Back up the whole directory with the server stopped. The cookie is the local session credential, no login or account recovery is included. The server binds to loopback by default and checks request hosts/origins. Keep it local: public hosting would need real authentication, secure deployment, stronger abuse controls, and versioned migrations. Run one server process per database. Neither prompts nor reasoning are logged to the console, complete messages, original answer text, bounded source excerpts, and trace metadata are persisted locally and sent to Groq when relevant.

Known limits: search execution counts and URL mappings may be absent in Groq's response. The interface reports that uncertainty and labels model-written links separately. Refreshes use a second model call to compare the research draft with provider-observed source excerpts, ordinary answers use one pass. This consistency check is not independent factual verification. Excerpts can omit material context. Hosted search does not expose a reliable per-tool-call budget or an archive of every fetched page and may consume tens of thousands of input tokens for a comparison, free quotas can stop a turn. Long or highly paraphrased history may require better retrieval, omitted context is flagged. Provider failure remains a failed or explicitly qualified answer, not silently fresh information.
