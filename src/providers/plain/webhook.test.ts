import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "vitest";
import { discussionEvent, fixture } from "./test-utils.js";
import { createPlainWebhookSource } from "./webhook.js";
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
    assert.deepEqual(await f.database.pendingPlainEvents(f.binding), []);
  });
  it("acknowledges before agent work, survives a source restart, and deduplicates semantic messages", async () => {
    const f = await fixture();
    const options = { ...f, signingSecret: secret };
    const first = createPlainWebhookSource(options);
    assert.equal((await first.handle(request(discussionEvent()))).status, 200);
    const retry = discussionEvent();
    retry.id = "ev_second";
    assert.equal((await first.handle(request(retry))).status, 200);
    assert.equal((await f.database.pendingPlainEvents(f.binding)).length, 1);
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
    assert.deepEqual(await f.database.pendingPlainEvents(f.binding), []);
    assert.equal((await first.handle(request(retry))).status, 200);
    assert.deepEqual(await f.database.pendingPlainEvents(f.binding), []);
  });
  it("retains failed dispatches for retry and returns 503 if persistence fails", async () => {
    const f = await fixture();
    const source = createPlainWebhookSource({ ...f, signingSecret: secret });
    await source.handle(request(discussionEvent()));
    await source.start(async () => {
      throw new Error("temporary_dispatch_failure");
    });
    try {
      await source.drain();
    } finally {
      await source.stop();
    }
    assert.equal((await f.database.pendingPlainEvents(f.binding)).length, 1);
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
    assert.equal((await f.database.pendingPlainEvents(f.binding)).length, 0);
  });
});
