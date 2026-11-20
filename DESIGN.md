# minimi: keep the thread, check the world

**A fresh search cannot tell us which five products we discussed, or whether yesterday’s answer was wrong.** The durable unit is a timestamped question–answer exchange with its sources. History establishes what was said; current evidence establishes what is true.

## How it works

Latest message + clock/timezone → retrieve history → GPT-OSS + web search → stream and persist.

Node/TypeScript serves React and Express on one port. SQLite WAL stores complete original exchanges, UTC timestamps, links, and traces; FTS5 indexes the text. A random HttpOnly session cookie scopes every operation across conversations. Retrieval is automatic context, leaving **web search as the only model tool**. Groq’s hosted [browser_search](https://console.groq.com/docs/tool-use/built-in-tools/browser-search) runs directly on GPT-OSS 120B with one GROQ_API_KEY. Code execution and other tools are disabled.

Small histories go directly into bounded context. With more than twelve saved exchanges, history references trigger GPT-OSS 20B to rewrite up to three lexical queries. An eight-second deadline falls back to deterministic retrieval. Reciprocal-rank fusion combines FTS results; a reserved current-thread budget preserves corrections and pronouns. Calendar references resolve in the browser’s IANA timezone, including DST, into half-open UTC intervals. An explicit date is a hard baseline filter. Yearless dates use their most recent past occurrence; “last Tuesday” excludes today. The interpretation is visible. Originals remain intact; omitted or clipped context is flagged within a 24,000-character history budget.

Explicit refreshes and volatile questions require search; pure recall and missing baselines disable it. Other questions allow search. For refreshes, research runs before answer generation: Groq’s numbered references map to actual tool-returned URLs, and cited line ranges select bounded source excerpts. A second, tool-free call checks the draft against those excerpts before streaming the final answer. This extra latency addresses unsupported prices and false “unchanged” conclusions observed in live single-pass trials. Instructions require matched tier/currency/seats/billing and separate outcomes: confirmed change, earlier-answer correction, no change found, or unknown. Historical text and web pages are untrusted data; public queries should exclude private transcript details.

## Speed and reliability

Ordinary turns need one call; refreshes add a 20B excerpt review, and larger histories add planning. Review receives at most 8,000 source characters and 4,000 history characters. Streaming, output limits, cancellation, and a three-minute deadline bound work. Hosted search owns its loop, so tool-call count and fetched tokens cannot be capped. No stale-answer cache. Search never retries; tool-free review retries once only for an explicit reset within 60 seconds. Oversized requests fail with actionable guidance.

Pending questions persist before generation; only complete answers enter memory. Unique request IDs replay completed results. One pending turn per session prevents baseline races. Disconnects and restarts preserve questions without promoting partial answers. Raw HTML and remote images are disabled. Provider source metadata is distinguished from model-written links; absent execution counts stay unknown. A requested search is not reported as observed execution. Citations still require factual scrutiny.

## Tradeoffs and another week

I rejected lossy summaries as the authority, a vector database before measuring lexical misses, and multiple agent roles or an always-on verifier without demonstrated quality gains. These add latency, quotas, and failure modes. Lexical recall can miss paraphrases; heuristic routing can misclassify unfamiliar phrasing; citation entailment and injection resistance remain model-dependent. This is a local single-process app, not an authenticated hosting service.

Tests cover dates/DST, retrieval/isolation, persistence, native citation mapping, streaming failures, and API contracts. A live runner records answers, latency, sources, and mechanical checks for human review, not a quality score. Another week: measure adversarial temporal/claim-entailment accuracy, p50/p95 and cost; add semantic candidates where recall fails; improve passage selection and effective-date extraction; compare the review pass against independent verification; add authenticated deployment and versioned migrations before hosting.
