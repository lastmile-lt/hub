import { z } from "zod";

const SlackIdSchema = z.string().min(1).max(255);
const SlackTimestampSchema = z.string().regex(/^\d+\.\d+$/u);
const SlackAttachmentMetadataSchema = z.object({
  id: SlackIdSchema,
  filename: z.string().min(1).max(255),
  contentType: z.string().max(255).nullable(),
  size: z.number().int().nonnegative().nullable(),
});
export const SlackUrlVerificationSchema = z
  .object({
    type: z.literal("url_verification"),
    challenge: z.string().min(1),
    api_app_id: SlackIdSchema.optional(),
  })
  .passthrough();

export const SlackEventCallbackSchema = z
  .object({
    type: z.literal("event_callback"),
    team_id: SlackIdSchema,
    api_app_id: SlackIdSchema,
    event_id: SlackIdSchema,
    event_time: z.number().int().nonnegative(),
    event: z.unknown(),
  })
  .passthrough();

const SlackMessageFields = {
  user: SlackIdSchema,
  channel: SlackIdSchema,
  text: z.string(),
  ts: SlackTimestampSchema,
  event_ts: SlackTimestampSchema,
  thread_ts: SlackTimestampSchema.optional(),
  bot_id: SlackIdSchema.optional(),
  subtype: z.string().optional(),
  files: z
    .array(
      z
        .object({
          id: SlackIdSchema,
          name: z.string().min(1).max(255).optional(),
          title: z.string().min(1).max(255).optional(),
          mimetype: z.string().max(255).optional(),
          size: z.number().int().nonnegative().optional(),
        })
        .passthrough(),
    )
    .optional(),
};

const SlackAppMentionSchema = z
  .object({ type: z.literal("app_mention"), ...SlackMessageFields })
  .passthrough();

// Slack never sends `app_mention` for a message in the app's own DM, only `message.im`.
const SlackDirectMessageSchema = z
  .object({
    type: z.literal("message"),
    channel_type: z.literal("im"),
    ...SlackMessageFields,
  })
  .passthrough();

const SlackMessageEventSchema = z.discriminatedUnion("type", [
  SlackAppMentionSchema,
  SlackDirectMessageSchema,
]);

export const NormalizedSlackEventSchema = z.object({
  type: z.enum(["mention", "direct_message"]),
  id: SlackIdSchema,
  teamId: SlackIdSchema,
  appId: SlackIdSchema,
  channelId: SlackIdSchema,
  messageTs: SlackTimestampSchema,
  threadTs: SlackTimestampSchema.nullable(),
  eventTs: SlackTimestampSchema,
  eventTime: z.number().int().nonnegative(),
  content: z.string(),
  author: z.object({
    id: SlackIdSchema,
    username: z.string().min(1).max(255).optional(),
  }),
  createdAt: z.string(),
  attachments: z.array(SlackAttachmentMetadataSchema).default([]),
});

export type NormalizedSlackEvent = z.infer<typeof NormalizedSlackEventSchema>;

export function slackEventSource(
  event: Pick<NormalizedSlackEvent, "type">,
): "slack.mention" | "slack.direct_message" {
  return event.type === "mention" ? "slack.mention" : "slack.direct_message";
}

export function normalizeSlackEvent(
  envelope: z.infer<typeof SlackEventCallbackSchema>,
): NormalizedSlackEvent | undefined {
  const parsed = SlackMessageEventSchema.safeParse(envelope.event);
  if (!parsed.success) return undefined;
  const message = parsed.data;
  if (message.bot_id !== undefined || message.subtype === "bot_message") return undefined;
  // Edits, deletions, joins and other DM subtypes are not something a person asked for.
  if (
    message.type === "message" &&
    message.subtype !== undefined &&
    message.subtype !== "file_share"
  )
    return undefined;

  return NormalizedSlackEventSchema.parse({
    type: message.type === "app_mention" ? "mention" : "direct_message",
    id: envelope.event_id,
    teamId: envelope.team_id,
    appId: envelope.api_app_id,
    channelId: message.channel,
    messageTs: message.ts,
    threadTs: message.thread_ts ?? null,
    eventTs: message.event_ts,
    eventTime: envelope.event_time,
    content: message.text,
    author: { id: message.user },
    createdAt: new Date(Number(message.ts) * 1_000).toISOString(),
    attachments: (message.files ?? []).map((file) => ({
      id: file.id,
      filename: file.name ?? file.title ?? file.id,
      contentType: file.mimetype ?? null,
      size: file.size ?? null,
    })),
  });
}
