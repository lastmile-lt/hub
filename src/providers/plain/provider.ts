import type { CompiledTrigger } from "../../config/compiler.js";
import { z } from "zod";
import type { Database, PlainEventBinding } from "../../db/types.js";
import type { TriggerProviderResources } from "../registration.js";
import type { TriggerProvider, TriggerProviderMatch } from "../../triggers/index.js";
import { matchesInputFilters, parseInvocation } from "../../triggers/invocation.js";
import type { OutputExecutor, OutputToolDefinition } from "../../execution-capabilities/outputs.js";
import type { PlainClient, PlainDiscussion, PlainThread } from "./client.js";
import type { PlainAccountMapping } from "./config.js";
import { PlainEventSchema, type PlainEvent } from "./events.js";

const outputSchema = z.object({
  provider: z.literal("plain"),
  organizationId: z.string(),
  projectId: z.string(),
  event: PlainEventSchema,
});
type Output = z.infer<typeof outputSchema>;
interface Context {
  provider: "plain";
  target: Output;
  event: { plain: PlainEvent };
}
export interface PlainProviderOptions extends TriggerProviderResources {
  isEnabled(): Promise<boolean>;
  database: Database;
  client: PlainClient;
  binding: PlainEventBinding;
  mapping?: PlainAccountMapping;
}

export function createPlainProvider(
  options: PlainProviderOptions,
): TriggerProvider<"plain", Context, Output> {
  const stopped = (event: PlainEvent) =>
    options.database.isPlainTurnStopped({
      ...options.binding,
      conversationKey: event.conversationKey,
      timestamp: event.timestamp,
    });
  const status = async (event: PlainEvent, value: "IN_PROGRESS" | "IDLE") => {
    if (event.discussionId === null || (await stopped(event))) return;
    const current = await options.client.discussion(event.discussionId);
    assertCurrentDiscussion(current, event);
    if (!(await stopped(event))) await options.client.setStatus(event.discussionId, value);
  };
  const failure = async (event: PlainEvent, reason: string) => {
    if (reason === "stopped_by_user" || (await stopped(event))) return;
    // Finish retryable status work before posting a non-idempotent notice.
    await status(event, "IDLE");
    await deliver(
      options,
      event,
      "I couldn’t complete this investigation. Please ask a human support agent to review it.",
    );
  };
  return {
    name: "plain",
    eventNames: ["plain.discussion", "plain.note", "plain.stop"],
    async match(external) {
      const event = PlainEventSchema.parse(external.payload);
      if (
        external.organizationId !== options.binding.organizationId ||
        external.projectId !== options.binding.projectId ||
        event.workspaceId !== options.binding.workspaceId ||
        event.agentId !== options.binding.agentId
      )
        return "configuration_unavailable";
      if (event.source === "plain.stop") {
        await stopDiscussion(options, event);
        return "agent_session_stopped";
      }
      if (await stopped(event)) return "agent_session_stopped";
      if (!(await options.isEnabled())) return "configuration_unavailable";
      const stored = await options
        .configurationStoreForProject(external.projectId)
        .getRevision(external.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      const candidates = stored.configuration.triggers.filter(
        (trigger) => trigger.on === event.source,
      );
      if (candidates.length === 0) return "no_trigger_for_source";
      const matches: TriggerProviderMatch<Context, Output>[] = [];
      for (const trigger of candidates) {
        const filters = trigger.filters;
        if (!matchesPlainFilters(event, filters)) continue;
        const invocation = parseInvocation(event.text, trigger.inputs);
        if (
          invocation.status === "accepted" &&
          !matchesInputFilters(invocation.inputs, filters?.inputs)
        )
          continue;
        const target: Output = {
          provider: "plain",
          organizationId: external.organizationId,
          projectId: external.projectId,
          event,
        };
        const match = {
          triggerName: trigger.name,
          triggerContext: { provider: "plain" as const, target, event: { plain: event } },
          outputContext: target,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
          conversation: {
            key: event.conversationKey,
            label: event.discussionId === null ? "Plain thread investigation" : "Plain discussion",
          },
        };
        if (invocation.status === "accepted") matches.push({ ...match, invocation });
        else matches.push({ ...match, invocation });
      }
      return matches.length === 0 ? "trigger_filters_rejected" : matches;
    },
    async materializeLaunch({ triggerContext }) {
      if (await stopped(triggerContext.event.plain)) throw new Error("stopped_by_user");
      return {};
    },
    async materializeContext({ triggerContext }) {
      const event = triggerContext.event.plain;
      if (await stopped(event)) throw new Error("stopped_by_user");
      // Read only the triggering discussion and its linked support thread. Customer-authored
      // content remains data; workflow authors explicitly opt in via paseo.context.
      const discussion =
        event.discussionId === null ? null : await options.client.discussion(event.discussionId);
      if (discussion !== null) assertCurrentDiscussion(discussion, event);
      const thread = event.threadId === null ? null : await options.client.thread(event.threadId);
      const cutoff = Date.parse(event.timestamp);
      let shortened = false;
      if (discussion !== null)
        discussion.messages.edges = discussion.messages.edges
          .filter(({ node }) => Date.parse(node.createdAt.iso8601) <= cutoff)
          .map(({ node }) => {
            shortened ||= node.text.length > 4000;
            return { node: { ...node, text: node.text.slice(0, 4000) } };
          });
      if (thread !== null)
        thread.timelineEntries.edges = thread.timelineEntries.edges
          .filter(({ node }) => Date.parse(node.timestamp.iso8601) <= cutoff)
          .map(({ node }) => {
            shortened ||= (node.llmText?.length ?? 0) > 4000;
            return { node: { ...node, llmText: node.llmText?.slice(0, 4000) ?? null } };
          });
      return {
        plain: event,
        discussion,
        thread,
        projectMapping: await resolveMapping(options, thread),
        contextLimits: {
          entriesPerConversation: 50,
          complete:
            !shortened &&
            !(
              discussion?.messages.pageInfo.hasPreviousPage ||
              thread?.timelineEntries.pageInfo.hasPreviousPage
            ),
          attachmentContents: "not_loaded",
          instruction:
            "Attached file metadata does not include file contents. Ask for relevant text when needed.",
        },
      };
    },
    async onAgentExecutionStarted(context) {
      await status(context.event.plain, "IN_PROGRESS");
    },
    async onAgentExecutionCompleted(context, _output, result) {
      const event = context.event.plain;
      if (await stopped(event)) return;
      if (result.status === "failed") {
        await failure(event, "failed");
        return;
      }
      await status(event, "IDLE");
      if (
        result.outputEmissions !== undefined &&
        (result.outputEmissions["plain.reply"] ?? 0) === 0
      ) {
        await deliver(
          options,
          event,
          "The investigation ended without an internal response. Please ask a human support agent to review it.",
        );
      }
    },
    async onAgentExecutionFailed(context, _output, reason) {
      await failure(context.event.plain, reason);
    },
  };
}
async function resolveMapping(
  { client, mapping }: PlainProviderOptions,
  thread: PlainThread | null,
) {
  if (thread === null) return { status: "unmapped" as const };
  if (thread.account !== null) return accountMapping(mapping, thread.account);

  // Only the source customer can supply membership evidence. Never use the legacy company
  // or select a membership because it happens to be the only one with a project field.
  const membership = await client
    .customerMembership(thread.customer.id)
    .catch(() => ({ status: "unavailable" as const }));
  if (membership.status !== "sole") {
    return {
      status: "unmapped" as const,
      reason: `customer_membership_${membership.status}`,
      nextAction: "ask_support_before_customer_data",
    };
  }
  const account = membership.account;
  if (account.gcpProject.status !== "valid")
    return {
      status: "unmapped" as const,
      reason: `${account.gcpProject.status}_gcp_project_id`,
      nextAction: "ask_support_before_customer_data",
    };
  const resolved = accountMapping(mapping, account);
  if (resolved.status !== "mapped") return resolved;
  // Existing prompts that accept only mapped/defaultProject must fail closed.
  return {
    status: "candidate" as const,
    source: "sole_customer_membership",
    accountId: account.id,
    name: account.name,
    candidateProject: account.gcpProject.projectId,
    beforeCustomerDataRead:
      "Verify the customer's request concerns this account. If it concerns another company or the scope is unclear, ask support to confirm the account before reading customer data.",
  };
}
function accountMapping(
  mapping: PlainAccountMapping | undefined,
  account: NonNullable<PlainThread["account"]>,
) {
  const accountId = account.id;
  const match = mapping?.accounts[accountId];
  const field = account.gcpProject;
  if (field.status === "invalid" || field.status === "ambiguous")
    return { status: "unmapped" as const, accountId, reason: `${field.status}_gcp_project_id` };
  if (field.status === "valid") {
    // A configured private mapping remains the boundary for allowed projects.
    if (mapping !== undefined && !match?.projects.includes(field.projectId))
      return { status: "unmapped" as const, accountId, reason: "project_mapping_conflict" };
    return {
      status: "mapped" as const,
      source: "plain_account_field" as const,
      accountId,
      name: account.name,
      projects: [field.projectId],
      defaultProject: field.projectId,
    };
  }
  return match === undefined
    ? { status: "unmapped" as const }
    : { status: "mapped" as const, accountId, ...match };
}
async function deliver(
  options: Pick<PlainProviderOptions, "client" | "database" | "binding">,
  event: PlainEvent,
  content: string,
): Promise<void> {
  if (event.discussionId !== null) {
    const discussion = await options.client.discussion(event.discussionId);
    assertCurrentDiscussion(discussion, event);
    await assertNotStopped(options, event);
    await options.client.sendDiscussionMessage(event.discussionId, content);
  } else if (event.threadId !== null && event.customerId !== null) {
    const thread = await options.client.thread(event.threadId);
    if (thread.customer.id !== event.customerId) throw new Error("plain_thread_customer_mismatch");
    await assertNotStopped(options, event);
    await options.client.createNote(event.threadId, event.customerId, content);
  } else throw new Error("plain_reply_target_missing");
}
export const plainReplyTool: OutputToolDefinition = {
  name: "reply",
  description:
    "Posts an INTERNAL reply to the originating Plain discussion or thread note. Never sends a customer message.",
  inputSchema: {
    type: "object",
    properties: { content: { type: "string", minLength: 1, maxLength: 10000 } },
    required: ["content"],
    additionalProperties: false,
  },
};
export function createPlainReplyExecutor(
  options: Pick<PlainProviderOptions, "database" | "client" | "binding">,
): OutputExecutor {
  return async (input) => {
    const { content } = z
      .object({ content: z.string().min(1).max(10000) })
      .strict()
      .parse(input.args);
    const context = outputSchema.parse(input.outputContext);
    if (
      context.organizationId !== options.binding.organizationId ||
      context.projectId !== options.binding.projectId ||
      context.event.workspaceId !== options.binding.workspaceId ||
      context.event.agentId !== options.binding.agentId
    )
      throw new Error("plain_reply_binding_mismatch");
    if (
      await options.database.isPlainTurnStopped({
        ...options.binding,
        conversationKey: context.event.conversationKey,
        timestamp: context.event.timestamp,
      })
    )
      throw new Error("stopped_by_user");
    await deliver(options, context.event, content);
  };
}

async function assertNotStopped(
  options: Pick<PlainProviderOptions, "database" | "binding">,
  event: PlainEvent,
): Promise<void> {
  if (
    await options.database.isPlainTurnStopped({
      ...options.binding,
      conversationKey: event.conversationKey,
      timestamp: event.timestamp,
    })
  )
    throw new Error("stopped_by_user");
}

async function stopDiscussion(options: PlainProviderOptions, event: PlainEvent): Promise<void> {
  if (options.executions === undefined) throw new Error("plain_execution_control_unavailable");
  await options.executions.stopActive({
    projectId: options.binding.projectId,
    reason: "stopped_by_user",
    matches: (work) => {
      const parsed = outputSchema.safeParse(work.outputContext);
      return (
        parsed.success &&
        parsed.data.event.conversationKey === event.conversationKey &&
        Date.parse(parsed.data.event.timestamp) <= Date.parse(event.timestamp)
      );
    },
  });
  if (event.discussionId !== null) {
    const current = await options.client.discussion(event.discussionId);
    // The run has been cancelled even if ownership changed in Plain. Do not update
    // another agent's status or keep this stop receipt retrying forever.
    if (!isCurrentDiscussion(current, event)) return;
    if (
      !current.messages.edges.some(
        ({ node }) =>
          node.type === "OUTBOUND" &&
          Date.parse(node.createdAt.iso8601) > Date.parse(event.timestamp),
      )
    ) {
      await options.client.setStatus(event.discussionId, "IDLE");
    }
  }
}

function matchesPlainFilters(event: PlainEvent, filters: CompiledTrigger["filters"]): boolean {
  if (
    Object.keys(filters ?? {}).some(
      (key) => !["from_users", "workspace", "contains", "inputs"].includes(key),
    )
  )
    return false;
  if (filters?.workspace !== undefined && filters.workspace !== event.workspaceId) return false;
  if (!filters?.from_users?.some((user) => user === "*" || user === event.actorId)) return false;
  return filters.contains === undefined || event.text.includes(filters.contains);
}

function isCurrentDiscussion(discussion: PlainDiscussion, event: PlainEvent): boolean {
  return (
    discussion.id === event.discussionId &&
    discussion.agent?.id === event.agentId &&
    discussion.type === "AGENT_SESSION" &&
    discussion.status === "OPEN" &&
    discussion.threadId === event.threadId
  );
}
function assertCurrentDiscussion(discussion: PlainDiscussion, event: PlainEvent): void {
  if (!isCurrentDiscussion(discussion, event)) throw new Error("plain_discussion_unavailable");
}
