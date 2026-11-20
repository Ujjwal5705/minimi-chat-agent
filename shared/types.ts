export interface Source {
  url: string;
  title: string;
  origin: "provider" | "answer";
}

export interface EvidenceExcerpt {
  url: string;
  title: string;
  text: string;
}

export interface DateRange {
  phrase: string;
  start: string;
  end: string;
  localDate: string;
  assumption: string;
}

export interface Plan {
  mode: "answer" | "recall" | "refresh";
  needsHistory: boolean;
  queries: string[];
  datePhrase: string | null;
}

export interface MemoryRef {
  id: string;
  conversationId: string;
  title: string;
  createdAt: string;
  question: string;
}

export interface Trace {
  mode: Plan["mode"];
  model: string;
  memory: MemoryRef[];
  dateRange: DateRange | null;
  historyTruncated: boolean;
  planner: "skipped" | "model" | "fallback";
  search: "off" | "auto" | "required";
  // Null means the provider didn't expose an execution trace. It never means zero.
  executedSearches: number | null;
  sourceStatus: "provider-citations" | "answer-links" | "none";
  elapsedMs: number;
  firstTokenMs: number | null;
  usage: { promptTokens: number; completionTokens: number } | null;
  warning?: string;
  synthesis?: "single-pass" | "evidence-review";
  reviewModel?: string;
  evidence?: EvidenceExcerpt[];
}

export interface Turn {
  id: string;
  conversationId: string;
  requestId: string;
  question: string;
  answer: string;
  createdAt: string;
  completedAt: string | null;
  status: "pending" | "complete" | "interrupted" | "failed";
  sources: Source[];
  trace: Trace | null;
  imported: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type StreamEvent =
  | { type: "status"; message: string }
  | { type: "delta"; text: string }
  | { type: "done"; turn: Turn }
  | { type: "error"; message: string };
