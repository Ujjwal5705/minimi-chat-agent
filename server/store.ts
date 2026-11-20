import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Conversation,
  DateRange,
  Source,
  Trace,
  Turn,
} from "../shared/types.js";

type Row = Record<string, unknown>;

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

function turnFrom(row: Row): Turn {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    requestId: String(row.request_id),
    question: String(row.question),
    answer: String(row.answer),
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    status: row.status as Turn["status"],
    sources: JSON.parse(String(row.sources)),
    trace: row.trace ? JSON.parse(String(row.trace)) : null,
    imported: Boolean(row.imported),
  };
}

function conversationFrom(row: Row): Conversation {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const stopwords = new Set(
  "a an and are as at be been but by can changed did do does for from had has have how i in is it last me my of on or our pricing said same since still that the them then these they this those to tools today us was we were what when which with would you your yesterday asked ask about answer shortlisted".split(
    " ",
  ),
);

/** User input is tokenized and quoted; it is never accepted as FTS query syntax. */
export function ftsQuery(query: string): string | null {
  const words = [
    ...new Set(
      (query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(
        (w) => !stopwords.has(w),
      ),
    ),
  ].slice(0, 16);
  return words.length ? words.map((w) => `"${w}"*`).join(" OR ") : null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_owner ON conversations(owner, updated_at);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        owner TEXT NOT NULL, request_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, completed_at TEXT, status TEXT NOT NULL,
        sources TEXT NOT NULL DEFAULT '[]', trace TEXT, imported INTEGER NOT NULL DEFAULT 0, raw_answer TEXT NOT NULL DEFAULT '',
        UNIQUE(owner, request_id)
      );
      CREATE INDEX IF NOT EXISTS turn_history ON turns(owner, status, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_per_owner ON turns(owner) WHERE status = 'pending';
      CREATE VIRTUAL TABLE IF NOT EXISTS turn_fts USING fts5(question, answer, content='turns', content_rowid='rowid', tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS turn_ai AFTER INSERT ON turns BEGIN
        INSERT INTO turn_fts(rowid, question, answer) VALUES(new.rowid, new.question, new.answer);
      END;
      CREATE TRIGGER IF NOT EXISTS turn_ad AFTER DELETE ON turns BEGIN
        INSERT INTO turn_fts(turn_fts, rowid, question, answer) VALUES('delete', old.rowid, old.question, old.answer);
      END;
      CREATE TRIGGER IF NOT EXISTS turn_au AFTER UPDATE ON turns BEGIN
        INSERT INTO turn_fts(turn_fts, rowid, question, answer) VALUES('delete', old.rowid, old.question, old.answer);
        INSERT INTO turn_fts(rowid, question, answer) VALUES(new.rowid, new.question, new.answer);
      END;
    `);
    // Additive upgrade for databases created during early development; never discard history.
    if (
      !this.db
        .prepare("PRAGMA table_info(turns)")
        .all()
        .some((column) => column.name === "raw_answer")
    ) {
      this.db.exec(
        "ALTER TABLE turns ADD COLUMN raw_answer TEXT NOT NULL DEFAULT ''",
      );
      this.db.exec("UPDATE turns SET raw_answer=answer");
    }
  }

  recoverInterrupted(): void {
    // One Node process owns this local database. Run once at server startup, never per request.
    this.db
      .prepare("UPDATE turns SET status='interrupted' WHERE status='pending'")
      .run();
  }

  createConversation(
    owner: string,
    title = "New conversation",
    now = new Date().toISOString(),
  ): Conversation {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?)")
      .run(id, owner, title, now, now);
    return { id, title, createdAt: now, updatedAt: now };
  }

  listConversations(owner: string): Conversation[] {
    return this.db
      .prepare(
        "SELECT * FROM conversations WHERE owner=? ORDER BY updated_at DESC",
      )
      .all(owner)
      .map(conversationFrom);
  }

  conversation(owner: string, id: string): Conversation {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE owner=? AND id=?")
      .get(owner, id);
    if (!row) throw new NotFoundError("Conversation not found.");
    return conversationFrom(row);
  }

  turns(owner: string, id: string): Turn[] {
    this.conversation(owner, id);
    return this.db
      .prepare(
        "SELECT * FROM turns WHERE owner=? AND conversation_id=? ORDER BY created_at, rowid",
      )
      .all(owner, id)
      .map(turnFrom);
  }

  getTurn(owner: string, id: string): Turn {
    const row = this.db
      .prepare("SELECT * FROM turns WHERE owner=? AND id=?")
      .get(owner, id);
    if (!row) throw new NotFoundError("Turn not found.");
    return turnFrom(row);
  }

  byRequest(owner: string, requestId: string): Turn | null {
    const row = this.db
      .prepare("SELECT * FROM turns WHERE owner=? AND request_id=?")
      .get(owner, requestId);
    return row ? turnFrom(row) : null;
  }

  beginTurn(
    owner: string,
    conversationId: string,
    requestId: string,
    question: string,
    now: string,
  ): Turn {
    this.conversation(owner, conversationId);
    const id = randomUUID();
    try {
      this.db
        .prepare(
          "INSERT INTO turns(id, conversation_id, owner, request_id, question, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
        )
        .run(id, conversationId, owner, requestId, question, now);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint"))
        throw new ConflictError(
          "Another answer is running. Wait for it to finish or stop it first.",
        );
      throw error;
    }
    this.db
      .prepare(
        "UPDATE conversations SET title=CASE WHEN title='New conversation' THEN ? ELSE title END, updated_at=? WHERE id=? AND owner=?",
      )
      .run(question.slice(0, 64), now, conversationId, owner);
    return this.getTurn(owner, id);
  }

  complete(
    owner: string,
    id: string,
    answer: string,
    sources: Source[],
    trace: Trace | null,
    options: { now?: string; rawAnswer?: string } = {},
  ): Turn {
    const now = options.now ?? new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE turns SET answer=?, raw_answer=?, sources=?, trace=?, completed_at=?, status='complete' WHERE owner=? AND id=? AND status='pending'",
      )
      .run(
        answer,
        options.rawAnswer ?? answer,
        JSON.stringify(sources),
        trace ? JSON.stringify(trace) : null,
        now,
        owner,
        id,
      );
    if (result.changes !== 1)
      throw new ConflictError("This turn is no longer pending.");
    return this.getTurn(owner, id);
  }

  fail(owner: string, id: string, interrupted: boolean): void {
    this.db
      .prepare(
        "UPDATE turns SET status=? WHERE owner=? AND id=? AND status='pending'",
      )
      .run(interrupted ? "interrupted" : "failed", owner, id);
  }

  recent(owner: string, limit: number, conversationId?: string): Turn[] {
    const rows = conversationId
      ? this.db
          .prepare(
            "SELECT * FROM turns WHERE owner=? AND conversation_id=? AND status='complete' ORDER BY created_at DESC, rowid DESC LIMIT ?",
          )
          .all(owner, conversationId, limit)
      : this.db
          .prepare(
            "SELECT * FROM turns WHERE owner=? AND status='complete' ORDER BY created_at DESC, rowid DESC LIMIT ?",
          )
          .all(owner, limit);
    return rows.map(turnFrom).reverse();
  }

  count(owner: string): number {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM turns WHERE owner=? AND status='complete'",
        )
        .get(owner)!.n,
    );
  }

  search(
    owner: string,
    queries: string[],
    range: DateRange | null,
    limit = 24,
  ): { turns: Turn[]; truncated: boolean } {
    // A stated day is a hard constraint, never a small ranking bonus.
    if (range) {
      const rows = this.db
        .prepare(
          "SELECT * FROM turns WHERE owner=? AND status='complete' AND created_at>=? AND created_at<? ORDER BY created_at, rowid LIMIT ?",
        )
        .all(owner, range.start, range.end, limit + 1);
      return {
        turns: rows.slice(0, limit).map(turnFrom),
        truncated: rows.length > limit,
      };
    }
    // Reciprocal rank fusion combines independently rewritten lexical queries.
    const scores = new Map<string, { turn: Turn; score: number }>();
    for (const query of [...new Set(queries)].slice(0, 4)) {
      const expression = ftsQuery(query);
      if (!expression) continue;
      const rows = this.db
        .prepare(
          `SELECT turns.* FROM turn_fts JOIN turns ON turns.rowid=turn_fts.rowid
        WHERE turn_fts MATCH ? AND turns.owner=? AND turns.status='complete'
        ORDER BY bm25(turn_fts, 2.0, 1.0) LIMIT ?`,
        )
        .all(expression, owner, limit + 1);
      rows.forEach((row, index) => {
        const turn = turnFrom(row);
        const hit = scores.get(turn.id) ?? { turn, score: 0 };
        hit.score += 1 / (60 + index);
        scores.set(turn.id, hit);
      });
    }
    const ranked = [...scores.values()].sort((a, b) => b.score - a.score);
    return {
      turns: ranked.slice(0, limit).map((hit) => hit.turn),
      truncated: ranked.length > limit,
    };
  }

  importConversation(
    owner: string,
    title: string,
    turns: { question: string; answer: string; createdAt: string }[],
  ): Conversation {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const first = turns[0].createdAt;
      const conversation = this.createConversation(owner, title, first);
      for (const turn of turns) {
        this.db
          .prepare(
            `INSERT INTO turns(id, conversation_id, owner, request_id, question, answer, raw_answer, created_at, completed_at, status, imported)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', 1)`,
          )
          .run(
            randomUUID(),
            conversation.id,
            owner,
            randomUUID(),
            turn.question,
            turn.answer,
            turn.answer,
            turn.createdAt,
            turn.createdAt,
          );
      }
      this.db
        .prepare("UPDATE conversations SET updated_at=? WHERE id=?")
        .run(turns.at(-1)!.createdAt, conversation.id);
      this.db.exec("COMMIT");
      return this.conversation(owner, conversation.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteConversation(owner: string, id: string): void {
    this.conversation(owner, id);
    if (
      this.db
        .prepare(
          "SELECT 1 FROM turns WHERE owner=? AND conversation_id=? AND status='pending'",
        )
        .get(owner, id)
    ) {
      throw new ConflictError(
        "Stop the running answer before deleting this conversation.",
      );
    }
    this.db
      .prepare("DELETE FROM conversations WHERE owner=? AND id=?")
      .run(owner, id);
  }

  close(): void {
    this.db.close();
  }
}
