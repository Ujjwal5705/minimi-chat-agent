# Verification record — 20 November 2026

The deterministic suite and production build pass locally. The UI was checked in installed Chrome at desktop and mobile sizes: prompt selection, history import, reopening after reload, export, navigation, no horizontal overflow, and no browser page errors.

Live Groq checks used synthetic history and real provider calls:

| Check                            | Observed result                                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 120B pure recall                 | Retrieved both original questions on 3 November; about 0.8 seconds                                                                                                |
| Initial 120B Postgres comparison | Search completed in about 11.5 seconds; execution metadata exposed browser operations and source URLs                                                             |
| Initial 120B CRM comparison      | Search completed in about 24.3 seconds and retained all five names; review found unsupported conclusions and plan/billing mismatches                              |
| Citation diagnostic              | Real browser output supplied numbered search results and line-numbered pages; this format now has deterministic mapping tests                                     |
| 20B tool-free excerpt review     | Completed against an actual previously fetched PostgreSQL passage in about 0.4 seconds                                                                            |
| Revised full comparison path     | Later attempts encountered 120B quota exhaustion, 20B rate limits, and an upstream stream interruption; a successful complete live rerun has not been established |

The initial comparison outputs were **not** accepted as quality evidence: their mistakes motivated the excerpt-review phase, stricter treatment of historical uncertainty, and explicit citation mapping. The final orchestration is covered by deterministic tests using an explicitly fake provider. This record does not claim the revised model policy eliminates factual errors, or that live comparison quality is verified. Run `npm run eval` with available quota and apply [RUBRIC.md](RUBRIC.md). Private raw results and local evidence are ignored by Git.
