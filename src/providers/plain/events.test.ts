import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { normalizePlainEvent } from "./events.js";
import { discussionEvent } from "./test-utils.js";
describe("Plain event routing", () => {
  it("accepts standalone and workflow discussions, deduplicating on message rather than delivery", () => {
    const e = discussionEvent();
    const first = normalizePlainEvent(e, "ws_example", "mu_example")!;
    assert.equal(first.threadId, null);
    assert.equal(first.actorId, "system");
    e.id = "ev_retry";
    assert.equal(normalizePlainEvent(e, "ws_example", "mu_example")!.deliveryId, first.deliveryId);
  });
  it("rejects other workspaces, other agents, resolved discussions, and own replies", () => {
    assert.equal(normalizePlainEvent(discussionEvent(), "ws_other", "mu_example"), undefined);
    assert.equal(normalizePlainEvent(discussionEvent(), "ws_example", "mu_other"), undefined);
    const resolved = discussionEvent();
    resolved.payload.discussion.status = "RESOLVED";
    assert.equal(normalizePlainEvent(resolved, "ws_example", "mu_example"), undefined);
    const own = discussionEvent();
    own.payload.message.type = "INBOUND";
    assert.equal(normalizePlainEvent(own, "ws_example", "mu_example"), undefined);
  });
  it("rejects mismatched envelope and payload event types", () => {
    const e = discussionEvent();
    e.payload.eventType = "thread.note_mention_created";
    assert.throws(() => normalizePlainEvent(e, "ws_example", "mu_example"));
  });
});

it("accepts a note mention added by an edit, strips mention tokens, and ignores self-authored notes", () => {
  const event = {
    id: "ev_note",
    type: "thread.note_mention_created",
    workspaceId: "ws_example",
    timestamp: "2026-10-22T10:00:00Z",
    payload: {
      eventType: "thread.note_mention_created",
      thread: { id: "t_one", customer: { id: "c_one" } },
      mentions: [{ id: "mu_example" }],
      note: {
        id: "n_one",
        text: "Investigate",
        markdown: "<@mu_example> Investigate",
        createdBy: { actorType: "user", userId: "u_one" },
        updatedBy: { actorType: "user", userId: "u_two" },
        updatedAt: "2026-10-22T10:00:00Z",
        deletedAt: null,
      },
    },
  };
  const parsed = normalizePlainEvent(event, "ws_example", "mu_example")!;
  assert.equal(parsed.actorId, "u_two");
  assert.equal(parsed.source, "plain.note");
  assert.equal(parsed.text.trim(), "Investigate");
  const edited = normalizePlainEvent(
    {
      ...event,
      payload: {
        ...event.payload,
        note: { ...event.payload.note, updatedAt: "2026-10-22T10:01:00Z" },
      },
    },
    "ws_example",
    "mu_example",
  )!;
  assert.notEqual(edited.deliveryId, parsed.deliveryId);
  assert.equal(edited.conversationKey, parsed.conversationKey);
  assert.equal(
    normalizePlainEvent(
      {
        ...event,
        payload: {
          ...event.payload,
          note: {
            ...event.payload.note,
            createdBy: { actorType: "machineUser", machineUserId: "mu_example" },
          },
        },
      },
      "ws_example",
      "mu_example",
    ),
    undefined,
  );
});
