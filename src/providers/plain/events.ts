import { z } from "zod";

const id = z.string().min(1);
const date = z.iso.datetime({ offset: true });
const actor = z.object({
  actorType: z.string(),
  userId: id.optional(),
  machineUserId: id.optional(),
});
const discussion = z.object({
  id,
  type: z.string(),
  status: z.string(),
  agent: z.object({ id }).nullable(),
  threadId: id.nullable(),
});
const file = z.object({
  id,
  fileName: z.string(),
  fileSizeBytes: z.number().nonnegative(),
  fileMimeType: z.string(),
});
const envelope = z.object({
  id,
  type: z.string(),
  workspaceId: id,
  timestamp: date,
  payload: z.unknown(),
});
const message = z.object({
  eventType: z.literal("discussion.message_created"),
  discussion,
  message: z.object({
    id,
    type: z.string(),
    markdown: z.string(),
    createdBy: actor,
    createdAt: date,
    workspaceFiles: z.array(file).default([]),
  }),
});
const stop = z.object({
  eventType: z.literal("discussion.turn_stop_requested"),
  discussion,
  requestedAt: date,
});
const note = z.object({
  eventType: z.literal("thread.note_mention_created"),
  thread: z.object({ id, customer: z.object({ id }) }),
  mentions: z.array(z.object({ id })),
  note: z.object({
    id,
    text: z.string(),
    markdown: z.string().nullable(),
    createdBy: actor,
    updatedBy: actor,
    updatedAt: date,
    deletedAt: date.nullable(),
  }),
});

export const PlainEventSchema = z.object({
  workspaceId: id,
  agentId: id,
  eventId: id,
  deliveryId: id,
  source: z.enum(["plain.discussion", "plain.note", "plain.stop"]),
  conversationKey: id,
  timestamp: date,
  actorId: id,
  text: z.string(),
  discussionId: id.nullable(),
  threadId: id.nullable(),
  customerId: id.nullable(),
  files: z.array(file),
});
export type PlainEvent = z.infer<typeof PlainEventSchema>;

/** Parse only signed bodies. Headers are not authoritative routing evidence. */
export function normalizePlainEvent(
  body: unknown,
  workspaceId: string,
  agentId: string,
): PlainEvent | undefined {
  const e = envelope.parse(body);
  if (e.workspaceId !== workspaceId) return undefined;
  const common = { workspaceId, agentId, eventId: e.id };
  if (e.type === "discussion.message_created") {
    const p = message.parse(e.payload);
    if (
      !ours(p.discussion, agentId) ||
      p.discussion.status !== "OPEN" ||
      p.message.type !== "OUTBOUND" ||
      isSelf(p.message.createdBy, agentId)
    )
      return undefined;
    return {
      ...common,
      source: "plain.discussion",
      deliveryId: JSON.stringify(["plain", workspaceId, agentId, "message", p.message.id]),
      conversationKey: key(workspaceId, agentId, "discussion", p.discussion.id),
      timestamp: p.message.createdAt,
      actorId: actorId(p.message.createdBy),
      text: p.message.markdown,
      discussionId: p.discussion.id,
      threadId: p.discussion.threadId,
      customerId: null,
      files: p.message.workspaceFiles,
    };
  }
  if (e.type === "discussion.turn_stop_requested") {
    const p = stop.parse(e.payload);
    if (!ours(p.discussion, agentId)) return undefined;
    return {
      ...common,
      source: "plain.stop",
      deliveryId: JSON.stringify(["plain", workspaceId, agentId, "stop", e.id]),
      conversationKey: key(workspaceId, agentId, "discussion", p.discussion.id),
      timestamp: p.requestedAt,
      actorId: "system",
      text: "",
      discussionId: p.discussion.id,
      threadId: p.discussion.threadId,
      customerId: null,
      files: [],
    };
  }
  if (e.type === "thread.note_mention_created") {
    const p = note.parse(e.payload);
    if (
      !p.mentions.some((m) => m.id === agentId) ||
      isSelf(p.note.createdBy, agentId) ||
      isSelf(p.note.updatedBy, agentId) ||
      p.note.deletedAt !== null
    )
      return undefined;
    return {
      ...common,
      source: "plain.note",
      // One investigation per note: later edits of a note that mentions the agent are
      // duplicates. A mention first added by an edit still starts one.
      deliveryId: JSON.stringify(["plain", workspaceId, agentId, "note", p.note.id]),
      conversationKey: key(workspaceId, agentId, "thread", p.thread.id),
      timestamp: p.note.updatedAt,
      actorId: actorId(p.note.updatedBy),
      text: (p.note.markdown ?? p.note.text).replace(/<@(?:mu|u)_[^>]+>/gu, ""),
      discussionId: null,
      threadId: p.thread.id,
      customerId: p.thread.customer.id,
      files: [],
    };
  }
  return undefined;
}
function ours(d: z.infer<typeof discussion>, agentId: string): boolean {
  return d.type === "AGENT_SESSION" && d.agent?.id === agentId;
}
function isSelf(a: z.infer<typeof actor>, agentId: string): boolean {
  return a.actorType === "machineUser" && a.machineUserId === agentId;
}
function actorId(a: z.infer<typeof actor>): string {
  return a.userId ?? a.machineUserId ?? a.actorType;
}
function key(workspace: string, agent: string, kind: string, targetId: string): string {
  return JSON.stringify(["plain", workspace, agent, kind, targetId]);
}
