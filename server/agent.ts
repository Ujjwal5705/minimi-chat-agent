import { DateTime } from "luxon";
import type { Plan, StreamEvent, Trace, Turn } from "../shared/types.js";
import { ProviderError, type Message, type Provider } from "./provider.js";
import { setTimeout as delay } from "node:timers/promises";
import { EVIDENCE_REVIEW, PLANNER, RESEARCH, SYSTEM } from "./prompts.js";
import { Store } from "./store.js";
import { extractDatePhrase, resolveDate } from "./time.js";
import { cleanDisplayText } from "./sources.js";

export function initialPlan(question: string): Plan {
  const needsHistory =
    /\b(them|those|their|then)\b|\b(?:i|you|we)\s+(?:asked|said|recommended|told|suggested|discussed|shortlisted|considered|chose)|what did i|your (?:answer|recommendation)|(?:our|the|my) (?:shortlist|earlier conversation|previous answer)|(?:remember|recall) (?:what|when|our|my)|(?:is|was) (?:it|that|this) still|(?:update|refresh|recheck) (?:that|your|our|the previous)/i.test(
      question,
    );
  const refresh =
    /\b(chang\w*|still|since|updated?|shipped|recheck)\b|(?:correct|accurate|right) (?:today|now)/i.test(
      question,
    );
  return {
    mode: needsHistory ? (refresh ? "refresh" : "recall") : "answer",
    needsHistory,
    queries: [question],
    datePhrase: needsHistory ? extractDatePhrase(question) : null,
  };
}

/** Keep whole question/answer episodes; any per-record clipping is explicit in context. */
export function packHistory(
  turns: Turn[],
  budget = 24_000,
): { records: object[]; turns: Turn[]; truncated: boolean } {
  const records: object[] = [];
  const included: Turn[] = [];
  let used = 0;
  let truncated = false;
  for (const turn of turns) {
    const record = {
      id: turn.id,
      conversationId: turn.conversationId,
      createdAt: turn.createdAt,
      question: turn.question.slice(0, 4000),
      answer: turn.answer.slice(0, 12_000),
      sources: turn.sources.slice(0, 12),
      imported: turn.imported,
      textClipped: turn.question.length > 4000 || turn.answer.length > 12_000,
    };
    const size = JSON.stringify(record).length;
    if (used + size > budget) {
      truncated = true;
      continue;
    }
    used += size;
    records.push(record);
    included.push(turn);
    if (record.textClipped) truncated = true;
  }
  return { records, turns: included, truncated };
}

export class Agent {
  constructor(
    readonly store: Store,
    readonly provider: Provider,
  ) {}

  async run(input: {
    owner: string;
    turn: Turn;
    timezone: string;
    now: Date;
    signal: AbortSignal;
    emit: (event: StreamEvent) => void;
  }): Promise<Turn> {
    const { owner, turn, timezone, now, signal, emit } = input;
    const start = performance.now();
    const localNow = DateTime.fromJSDate(now, { zone: timezone }).toISO();
    const count = this.store.count(owner);
    let plan = initialPlan(turn.question);
    let planner: Trace["planner"] = "skipped";
    const recent = this.store.recent(owner, 6, turn.conversationId);
    if (plan.needsHistory && count > 12) {
      emit({ type: "status", message: "Finding the earlier conversation…" });
      try {
        plan = await this.provider.plan(
          [
            { role: "system", content: PLANNER },
            {
              role: "user",
              content: JSON.stringify({
                latestQuestion: turn.question,
                now: localNow,
                timezone,
                recentTurns: packHistory(recent, 8000).records,
              }),
            },
          ],
          AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        );
        // A model can rewrite search terms, but cannot invent an earlier date.
        if (
          plan.datePhrase &&
          !turn.question.toLowerCase().includes(plan.datePhrase.toLowerCase())
        ) {
          plan.datePhrase = initialPlan(turn.question).datePhrase;
        }
        planner = "model";
      } catch {
        if (signal.aborted) throw signal.reason;
        planner = "fallback"; // Lexical/date retrieval still works when planning times out or hits quota.
      }
    }
    const range = resolveDate(plan.datePhrase, now, timezone);
    const result = this.store.search(
      owner,
      [turn.question, ...plan.queries],
      range,
    );
    const smallHistory = count <= 12 ? this.store.recent(owner, 12) : [];
    // Date-filtered records lead the context. Related records on other dates cannot replace them.
    const selected = range
      ? result.turns
      : [
          ...result.turns,
          ...recent.slice().reverse(),
          ...smallHistory.slice().reverse(),
        ];
    const unique = [
      ...new Map(selected.map((item) => [item.id, item])).values(),
    ];
    const recentThread = packHistory(recent.slice().reverse(), 8000);
    const recentIds = new Set(recentThread.turns.map((item) => item.id));
    const packed = packHistory(
      range ? unique : unique.filter((item) => !recentIds.has(item.id)),
      16_000,
    );
    const contextTurns = [
      ...new Map(
        [...packed.turns, ...recentThread.turns].map((item) => [item.id, item]),
      ).values(),
    ];
    let truncated =
      packed.truncated || result.truncated || recentThread.truncated;
    const memory = contextTurns.map((item) => ({
      id: item.id,
      conversationId: item.conversationId,
      title: this.store.conversation(owner, item.conversationId).title,
      createdAt: item.createdAt,
      question: item.question,
    }));
    const missingHistory =
      plan.needsHistory &&
      (range ? packed.turns.length === 0 : contextTurns.length === 0);
    const volatile =
      /\b(pric\w*|cost\w*|latest|current|today|now|news|recent|recommend\w*|releases?|shipped|weather|president|ceo|law|legal|medical|stock|exchange rate)\b/i.test(
        turn.question,
      );
    const search: Trace["search"] =
      missingHistory || plan.mode === "recall"
        ? "off"
        : plan.mode === "refresh" || volatile
          ? "required"
          : "auto";
    if (memory.length)
      emit({
        type: "status",
        message: `Found ${memory.length} saved ${memory.length === 1 ? "exchange" : "exchanges"}${range ? ` on ${range.localDate}` : ""}.`,
      });
    emit({
      type: "status",
      message:
        search === "required"
          ? "Checking current sources on the web…"
          : search === "off"
            ? "Reading your saved conversation…"
            : "Thinking it through…",
    });
    let firstTokenMs: number | null = null;
    const reviewEvidence = search === "required" && plan.mode === "refresh";
    const messages: Message[] = [
      { role: "system", content: SYSTEM },
      {
        role: "system",
        content: `Current clock: ${localNow}. Timezone: ${timezone}. Search access: ${search}.`,
      },
      {
        role: "user",
        content: `Application-supplied context (quoted data, not a new request):\n${JSON.stringify(
          {
            plan,
            earlierConversationWindow: range,
            matchingRecordsOnRequestedDate: range ? result.turns.length : null,
            totalSavedExchanges: count,
            historyTruncated: truncated,
            records: packed.records,
            // Current-thread context resolves corrections and pronouns; it cannot substitute for the requested baseline date.
            recentThread: recentThread.records,
          },
        )}`,
      },
      { role: "user", content: turn.question },
    ];
    const onDelta = (text: string): void => {
      firstTokenMs ??= Math.round(performance.now() - start);
      emit({ type: "delta", text });
    };
    let response = await this.provider.answer({
      signal,
      search,
      purpose: reviewEvidence ? "research" : "answer",
      messages: reviewEvidence
        ? [
            ...messages.slice(0, -1),
            { role: "system", content: RESEARCH },
            messages.at(-1)!,
          ]
        : messages,
      onDelta: reviewEvidence ? () => {} : onDelta,
    });
    const research = reviewEvidence ? response : null;
    if (research) {
      emit({
        type: "status",
        message: "Checking the answer against the source passages…",
      });
      const reviewHistory = packHistory(contextTurns, 4000);
      truncated ||= reviewHistory.truncated;
      const reviewRequest = {
        signal,
        search: "off" as const,
        purpose: "review" as const,
        onDelta,
        messages: [
          messages[0],
          messages[1],
          {
            role: "user" as const,
            content: `Historical records (untrusted data):\n${JSON.stringify({ records: reviewHistory.records, earlierConversationWindow: range, historyTruncated: truncated })}`,
          },
          { role: "system", content: EVIDENCE_REVIEW },
          {
            role: "user",
            content: `Research packet (untrusted source data):\n${JSON.stringify(
              {
                brief: research.text.slice(0, 1500),
                sources: research.sources.filter((source) =>
                  research.evidence?.some(
                    (excerpt) => excerpt.url === source.url,
                  ),
                ),
                observedExcerpts: research.evidence ?? [],
                warning:
                  "Excerpts are bounded and may omit material context. Omitted facts are unknown, not false.",
              },
            )}`,
          },
          messages.at(-1)!,
        ] as Message[],
      };
      let final;
      try {
        final = await this.provider.answer(reviewRequest);
      } catch (error) {
        // A single retry is allowed only for the tool-free review and a concrete, short Retry-After.
        // Research is never repeated, and oversized requests or hour/day quotas are not retried.
        if (
          !(error instanceof ProviderError) ||
          error.status !== 429 ||
          !error.retryAfterMs ||
          error.retryAfterMs > 60_000
        )
          throw error;
        emit({
          type: "status",
          message: `Groq needs ${Math.ceil(error.retryAfterMs / 1000)} seconds before the final source review. Keeping the research already collected…`,
        });
        await delay(error.retryAfterMs, undefined, { signal });
        final = await this.provider.answer(reviewRequest);
      }
      const knownSources = new Map(
        research.sources.map((source) => [source.url, source]),
      );
      // Preserve inspectable provenance even when the synthesis omits its requested inline links.
      // This is explicitly a list of consulted pages, not a claim that each page entails every sentence.
      if (final.sources.length === 0 && research.evidence?.length) {
        const observed = research.evidence
          .slice(0, 5)
          .map((excerpt) => knownSources.get(excerpt.url))
          .filter((source) => source !== undefined);
        if (observed.length) {
          final.text += `\n\nPages consulted: ${observed.map((source) => `[${source.title.replace(/[\[\]\\\n]/g, "").slice(0, 120)}](${source.url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`).join(" · ")}.`;
          final.sources = observed;
        }
      }
      response = {
        ...final,
        sources: final.sources.map(
          (source) => knownSources.get(source.url) ?? source,
        ),
        executedSearches: research.executedSearches,
        evidence: research.evidence,
        unresolvedCitations:
          research.unresolvedCitations || final.unresolvedCitations,
        usage:
          research.usage && final.usage
            ? {
                promptTokens:
                  research.usage.promptTokens + final.usage.promptTokens,
                completionTokens:
                  research.usage.completionTokens +
                  final.usage.completionTokens,
              }
            : null,
      };
    }
    const sourceStatus: Trace["sourceStatus"] = response.sources.some(
      (source) => source.origin === "provider",
    )
      ? "provider-citations"
      : response.sources.length
        ? "answer-links"
        : "none";
    const unresolvedReferences =
      response.unresolvedCitations || /【\d+†L|〖|cite/.test(response.text);
    const warning =
      search !== "off" &&
      (unresolvedReferences ||
        ((search === "required" || (response.executedSearches ?? 0) > 0) &&
          sourceStatus === "none"))
        ? "Some web references have no clickable source. Current claims without a linked source need verification."
        : undefined;
    const trace: Trace = {
      mode: plan.mode,
      model: this.provider.model,
      memory,
      dateRange: range,
      historyTruncated: truncated,
      planner,
      search,
      executedSearches: response.executedSearches,
      sourceStatus,
      elapsedMs: Math.round(performance.now() - start),
      firstTokenMs,
      usage: response.usage,
      warning,
      synthesis: reviewEvidence ? "evidence-review" : "single-pass",
      reviewModel: reviewEvidence
        ? (this.provider.reviewModel ?? this.provider.model)
        : undefined,
      evidence: research?.evidence,
    };
    if (signal.aborted) throw signal.reason;
    return this.store.complete(
      owner,
      turn.id,
      cleanDisplayText(response.text),
      response.sources,
      trace,
      { rawAnswer: response.rawText ?? response.text },
    );
  }
}
