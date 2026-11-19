import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it, vi } from "vitest";
import { discussionEvent, fixture } from "./test-utils.js";
import {
  createPlainWebhookSource,
  PLAIN_MAX_DISPATCH_ATTEMPTS,
  plainRetryDelay,
} from "./webhook.js";
const secret = "test-only-secret";
function request(value: unknown, key = secret) {
  const body = JSON.stringify(value);
  return new Request("https://hub.example/api/integrations/plain/events", {
    method: "POST",
    body,
    headers: {
      "plain-request-signature": createHmac("sha256", key).update(body).digest("hex"),
    },
  });
}
describe("Plain signed durable webhook", () => {
  it("rejects invalid signatures and oversized bodies without persisting anything", async () => {
    const f = await fixture();
    const source = createPlainWebhookSource({ ...f, signingSecret: secret });
    assert.equal((await source.handle(request(discussionEvent(), "wrong"))).status, 401);
    assert.equal(
      (
        await source.handle(
          new Request("https://hub.example", {
            method: "POST",
            body: "x",
            headers: { "plain-request-signature": "0".repeat(64), "content-length": "1048577" },
          }),
        )
      ).status,
      413,
    );
    assert.deepEqual(await f.database.pendingPlainEvents(f.binding, new Date()), []);
  });
  it("acknowledges before agent work, survives a source restart, and deduplicates semantic messages", async () => {
    const f = await fixture();
    const options = { ...f, signingSecret: secret };
    const first = createPlainWebhookSource(options);
    assert.equal((await first.handle(request(discussionEvent()))).status, 200);
    const retry = discussionEvent();
    retry.id = "ev_second";
    assert.equal((await first.handle(request(retry))).status, 200);
    assert.equal((await f.database.pendingPlainEvents(f.binding, new Date())).length, 1);
    const restarted = createPlainWebhookSource(options);
    const processed: string[] = [];
    await restarted.start(async (event) => {
      processed.push(event.deliveryId);
    });
    try {
      await restarted.drain();
      await restarted.drain();
    } finally {
      await restarted.stop();
    }
    assert.deepEqual(processed, [f.event.deliveryId]);
    assert.deepEqual(await f.database.pendingPlainEvents(f.binding, new Date()), []);
    assert.equal((await first.handle(request(retry))).status, 200);
    assert.deepEqual(await f.database.pendingPlainEvents(f.binding, new Date()), []);
  });
  it("backs off a failing dispatch without blocking newer events, then drops it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await fixture();
    let now = Date.parse("2026-10-22T10:00:00Z");
    const source = createPlainWebhookSource({ ...f, signingSecret: secret, now: () => now });
    await source.handle(request(discussionEvent()));
    const failing = f.event.deliveryId;
    const dispatched: string[] = [];
    await source.start(async (event) => {
      dispatched.push(event.deliveryId);
      if (event.deliveryId === failing) throw new Error("permanent_dispatch_failure");
    });
    const failures = () => dispatched.filter((id) => id === failing).length;
    try {
      await source.drain();
      assert.equal(failures(), 1);
      const newer = discussionEvent();
      newer.id = "ev_newer";
      newer.payload.message.id = "m_newer";
      assert.equal((await source.handle(request(newer))).status, 200);
      await source.drain();
      assert.equal(dispatched.length, 2);
      assert.notEqual(dispatched[1], failing);
      await source.drain();
      assert.equal(dispatched.length, 2);
      for (let attempt = 1; attempt < PLAIN_MAX_DISPATCH_ATTEMPTS; attempt++) {
        now += plainRetryDelay(attempt) - 1;
        await source.drain();
        assert.equal(failures(), attempt);
        now += 1;
        await source.drain();
        assert.equal(failures(), attempt + 1);
      }
      now += 3_600_000;
      await source.drain();
      assert.equal(failures(), PLAIN_MAX_DISPATCH_ATTEMPTS);
      assert.deepEqual(await f.database.pendingPlainEvents(f.binding, new Date(now)), []);
    } finally {
      await source.stop();
      vi.useRealTimers();
    }
  });
  it("returns 503 if persistence fails", async () => {
    const f = await fixture();
    const source = createPlainWebhookSource({ ...f, signingSecret: secret });
    f.database.persistPlainEvent = async () => {
      throw new Error("unavailable");
    };
    assert.equal((await source.handle(request(discussionEvent()))).status, 503);
  });
  it("does not accept a signed event for a different workspace", async () => {
    const f = await fixture();
    const e = discussionEvent();
    e.workspaceId = "ws_other";
    const source = createPlainWebhookSource({ ...f, signingSecret: secret });
    assert.equal((await source.handle(request(e))).status, 200);
    assert.equal((await f.database.pendingPlainEvents(f.binding, new Date())).length, 0);
  });
});
