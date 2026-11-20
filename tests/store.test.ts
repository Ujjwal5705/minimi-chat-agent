import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConflictError, Store, ftsQuery } from "../server/store.js";
import { resolveDate } from "../server/time.js";

test("history and evidence survive a database restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "minimi-store-"));
  const path = join(dir, "history.sqlite");
  let store = new Store(path);
  try {
    const conversation = store.createConversation("alice");
    const turn = store.beginTurn(
      "alice",
      conversation.id,
      randomUUID(),
      "Compare Postgres hosts",
      "2026-11-17T09:00:00.000Z",
    );
    store.complete(
      "alice",
      turn.id,
      "Neon and Supabase",
      [
        {
          url: "https://neon.tech/pricing",
          title: "Pricing",
          origin: "provider",
        },
      ],
      null,
      { rawAnswer: "Neon and Supabase【0†L1】" },
    );
    store.close();
    store = new Store(path);
    const saved = store.turns("alice", conversation.id);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].answer, "Neon and Supabase");
    assert.equal(
      store.db.prepare("SELECT raw_answer FROM turns WHERE id=?").get(turn.id)
        ?.raw_answer,
      "Neon and Supabase【0†L1】",
    );
    assert.equal(saved[0].sources[0].url, "https://neon.tech/pricing");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("retrieval crosses conversations but never owner boundaries", () => {
  const store = new Store(":memory:");
  try {
    store.importConversation("alice", "CRM shortlist", [
      {
        question: "CRM for 20 seats",
        answer: "HubSpot, Pipedrive, Zoho, Salesforce, Freshsales",
        createdAt: "2026-11-16T10:00:00.000Z",
      },
    ]);
    store.importConversation("bob", "Secret CRM", [
      {
        question: "CRM for us",
        answer: "Secret internal vendor",
        createdAt: "2026-11-16T10:00:00.000Z",
      },
    ]);
    const hits = store.search("alice", ["CRM sales software"], null).turns;
    assert.equal(hits.length, 1);
    assert.match(hits[0].answer, /Freshsales/);
    assert.throws(() => store.turns("bob", hits[0].conversationId));
    store.deleteConversation("alice", hits[0].conversationId);
    assert.equal(store.search("alice", ["CRM"], null).turns.length, 0);
  } finally {
    store.close();
  }
});
test("date retrieval includes all topics on the day and excludes midnight at the end", () => {
  const store = new Store(":memory:");
  try {
    store.importConversation("alice", "Mixed", [
      {
        question: "before",
        answer: "a",
        createdAt: "2026-11-16T18:29:59.999Z",
      },
      {
        question: "Postgres",
        answer: "b",
        createdAt: "2026-11-16T18:30:00.000Z",
      },
      {
        question: "Gardening",
        answer: "c",
        createdAt: "2026-11-17T18:29:59.999Z",
      },
      { question: "after", answer: "d", createdAt: "2026-11-17T18:30:00.000Z" },
    ]);
    const range = resolveDate(
      "last Tuesday",
      new Date("2026-11-20T12:00:00Z"),
      "Asia/Kolkata",
    );
    assert.deepEqual(
      store.search("alice", ["Postgres"], range).turns.map((t) => t.question),
      ["Postgres", "Gardening"],
    );
  } finally {
    store.close();
  }
});
test("pending and failed answers never become recall baselines; one active request per owner", () => {
  const store = new Store(":memory:");
  try {
    const conversation = store.createConversation("alice");
    const id = randomUUID();
    const turn = store.beginTurn(
      "alice",
      conversation.id,
      id,
      "Postgres",
      new Date().toISOString(),
    );
    assert.equal(store.byRequest("alice", id)?.id, turn.id);
    assert.throws(
      () =>
        store.beginTurn(
          "alice",
          conversation.id,
          randomUUID(),
          "Another",
          new Date().toISOString(),
        ),
      ConflictError,
    );
    assert.equal(store.count("alice"), 0);
    store.fail("alice", turn.id, false);
    assert.equal(store.search("alice", ["Postgres"], null).turns.length, 0);
    assert.throws(
      () => store.complete("alice", turn.id, "late answer", [], null),
      ConflictError,
    );
    store.beginTurn(
      "alice",
      conversation.id,
      randomUUID(),
      "Pending at crash",
      new Date().toISOString(),
    );
    store.recoverInterrupted();
    assert.equal(
      store.turns("alice", conversation.id).at(-1)?.status,
      "interrupted",
    );
  } finally {
    store.close();
  }
});
test("FTS syntax is quoted and safe", () => {
  assert.equal(ftsQuery("what did I ask you today"), null);
  const store = new Store(":memory:");
  try {
    assert.doesNotThrow(() =>
      store.search("alice", ["\" OR * NEAR postgres -'"], null),
    );
  } finally {
    store.close();
  }
});
