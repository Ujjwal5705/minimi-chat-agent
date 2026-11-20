import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createApp } from "../server/app.js";
import { Store } from "../server/store.js";
import type { Provider } from "../server/provider.js";
import { readSSE } from "../shared/sse.js";
import { setTimeout as delay } from "node:timers/promises";

const fake: Provider = {
  model: "fake-test-provider",
  async plan() {
    throw new Error("not used");
  },
  async answer(request) {
    request.onDelta("Hello.");
    return { text: "Hello.", sources: [], executedSearches: null, usage: null };
  },
};

async function serverFixture(provider = fake, configured = true) {
  const store = new Store(":memory:");
  const server = createServer(createApp(store, provider, { configured }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test server address");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    store,
    url,
    async session() {
      const response = await fetch(`${url}/api/config`);
      return response.headers.get("set-cookie")!.split(";")[0];
    },
    request(path: string, cookie: string, method = "GET", data?: unknown) {
      return fetch(`${url}${path}`, {
        method,
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

test("sessions isolate history and cross-origin mutations are blocked", async () => {
  const fixture = await serverFixture();
  try {
    const alice = await fixture.session();
    const bob = await fixture.session();
    assert.notEqual(alice, bob);
    const conversation = await (
      await fixture.request("/api/conversations", alice, "POST", {})
    ).json();
    assert.equal(
      (await fixture.request(`/api/conversations/${conversation.id}`, bob))
        .status,
      404,
    );
    const blocked = await fetch(`${fixture.url}/api/conversations`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        Cookie: alice,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(blocked.status, 403);
    const body = await (
      await fixture.request("/api/conversations", bob)
    ).json();
    assert.deepEqual(body, []);
  } finally {
    await fixture.close();
  }
});
test("completed request IDs replay the persisted answer without another model call", async () => {
  let calls = 0;
  const fixture = await serverFixture({
    ...fake,
    async answer(request) {
      calls++;
      return fake.answer(request);
    },
  });
  try {
    const cookie = await fixture.session();
    const conversation = await (
      await fixture.request("/api/conversations", cookie, "POST", {})
    ).json();
    const input = {
      conversationId: conversation.id,
      requestId: randomUUID(),
      question: "Hello",
      timezone: "UTC",
    };
    let turnId: string | undefined;
    for (let i = 0; i < 2; i++) {
      const response = await fixture.request(
        "/api/chat",
        cookie,
        "POST",
        input,
      );
      assert.equal(response.status, 200);
      const events: { type: string; turn?: { id: string } }[] = [];
      for await (const frame of readSSE(response.body!))
        events.push(JSON.parse(frame));
      const done = events.find((e) => e.type === "done")!;
      if (i === 0) turnId = done.turn!.id;
      assert.equal(done.turn!.id, turnId);
    }
    assert.equal(calls, 1);
    const conflict = await fixture.request("/api/chat", cookie, "POST", {
      ...input,
      question: "Different question",
    });
    assert.equal(conflict.status, 409);
  } finally {
    await fixture.close();
  }
});
test("history imports validate dates and round-trip content without inventing source provenance", async () => {
  const fixture = await serverFixture();
  try {
    const cookie = await fixture.session();
    const history = {
      title: "Prior discussion",
      turns: [
        {
          question: "What is Postgres?",
          answer: "An SQL database.",
          createdAt: "2026-11-03T15:00:00+05:30",
        },
      ],
    };
    const response = await fixture.request(
      "/api/import",
      cookie,
      "POST",
      history,
    );
    assert.equal(response.status, 201);
    const conversation = await response.json();
    const saved = await (
      await fixture.request(`/api/conversations/${conversation.id}`, cookie)
    ).json();
    assert.equal(saved.turns[0].imported, true);
    assert.equal(saved.turns[0].createdAt, "2026-11-03T09:30:00.000Z");
    assert.deepEqual(saved.turns[0].sources, []);
    const exported = await (
      await fixture.request(
        `/api/conversations/${conversation.id}/export`,
        cookie,
      )
    ).json();
    assert.equal(exported.turns[0].answer, history.turns[0].answer);
    const invalid = await fixture.request("/api/import", cookie, "POST", {
      ...history,
      turns: [{ ...history.turns[0], createdAt: "2099-11-03T10:00:00Z" }],
    });
    assert.equal(invalid.status, 400);
  } finally {
    await fixture.close();
  }
});
test("missing credentials return an actionable error before saving a pending message", async () => {
  const fixture = await serverFixture(fake, false);
  try {
    const cookie = await fixture.session();
    const conversation = await (
      await fixture.request("/api/conversations", cookie, "POST", {})
    ).json();
    const response = await fixture.request("/api/chat", cookie, "POST", {
      conversationId: conversation.id,
      requestId: randomUUID(),
      question: "Hello",
      timezone: "UTC",
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /GROQ_API_KEY/);
    const saved = await (
      await fixture.request(`/api/conversations/${conversation.id}`, cookie)
    ).json();
    assert.deepEqual(saved.turns, []);
  } finally {
    await fixture.close();
  }
});
test("upstream failure is saved as failed and cannot become a historical answer", async () => {
  const fixture = await serverFixture({
    ...fake,
    async answer() {
      throw new Error("private internal detail");
    },
  });
  try {
    const cookie = await fixture.session();
    const conversation = await (
      await fixture.request("/api/conversations", cookie, "POST", {})
    ).json();
    const response = await fixture.request("/api/chat", cookie, "POST", {
      conversationId: conversation.id,
      requestId: randomUUID(),
      question: "Hello",
      timezone: "UTC",
    });
    const text = await response.text();
    assert.ok(text.includes('"type":"error"'));
    assert.ok(!text.includes("private internal detail"));
    const saved = await (
      await fixture.request(`/api/conversations/${conversation.id}`, cookie)
    ).json();
    assert.equal(saved.turns[0].status, "failed");
    assert.equal(saved.turns[0].answer, "");
  } finally {
    await fixture.close();
  }
});

test("concurrent requests conflict and a client disconnect interrupts the pending turn", async () => {
  const waiting: Provider = {
    ...fake,
    answer(request) {
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        );
        if (request.signal.aborted) reject(request.signal.reason);
      });
    },
  };
  const fixture = await serverFixture(waiting);
  try {
    const cookie = await fixture.session();
    const conversation = await (
      await fixture.request("/api/conversations", cookie, "POST", {})
    ).json();
    const input = {
      conversationId: conversation.id,
      requestId: randomUUID(),
      question: "Wait for a long search",
      timezone: "UTC",
    };
    const first = await fixture.request("/api/chat", cookie, "POST", input);
    assert.equal(first.status, 200);
    const second = await fixture.request("/api/chat", cookie, "POST", {
      ...input,
      requestId: randomUUID(),
    });
    assert.equal(second.status, 409);
    await first.body!.cancel();
    let status = "pending";
    for (let i = 0; i < 100 && status === "pending"; i++) {
      await delay(10);
      const saved = await (
        await fixture.request(`/api/conversations/${conversation.id}`, cookie)
      ).json();
      status = saved.turns[0].status;
    }
    assert.equal(status, "interrupted");
  } finally {
    await fixture.close();
  }
});
