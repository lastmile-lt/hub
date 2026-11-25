import { readBoundedRequestBody } from "../../http/request-body.js";
import { z } from "zod";

const id = z.string().min(1);
const pageInfo = z.object({ hasPreviousPage: z.boolean() });
const identitySchema = z.object({
  myMachineUser: z.object({ id }).nullable(),
  myWorkspace: z.object({ id }).nullable(),
});
const discussionSchema = z.object({
  id,
  threadId: id.nullable(),
  type: z.string(),
  status: z.string(),
  agent: z.object({ id }).nullable(),
  messages: z.object({
    edges: z.array(
      z.object({
        node: z.object({
          id,
          text: z.string(),
          type: z.string(),
          createdAt: z.object({ iso8601: z.string() }),
        }),
      }),
    ),
    pageInfo,
  }),
});
const accountFieldSchema = z.object({
  externalFieldId: z.string(),
  value: z.object({ __typename: z.string(), stringValue: z.string().optional() }),
});
type AccountProject =
  | { status: "valid"; projectId: string }
  | { status: "missing" | "invalid" | "ambiguous" };
const accountSchema = z
  .object({ id, name: z.string(), accountFields: z.array(accountFieldSchema) })
  .transform(({ accountFields, ...account }) => ({
    ...account,
    gcpProject: accountProject(accountFields),
  }));
const membershipCustomerSchema = z.object({
  customer: z
    .object({
      id,
      accountMemberships: z.object({
        edges: z.array(z.object({ node: z.object({ account: accountSchema }) })),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      }),
    })
    .nullable(),
});
const accountSelection = `id name accountFields {
  externalFieldId value { __typename ... on AccountFieldStringValue { stringValue } }
}`;
export type PlainMembership =
  | { status: "sole"; account: z.infer<typeof accountSchema> }
  | { status: "none" | "multiple" | "unavailable" };
const threadSchema = z.object({
  id,
  title: z.string(),
  account: accountSchema.nullable(),
  customer: z.object({
    id,
    fullName: z.string(),
    company: z.object({ id, name: z.string() }).nullable(),
  }),
  timelineEntries: z.object({
    edges: z.array(
      z.object({
        node: z.object({
          id,
          actor: z.object({ __typename: z.string() }).optional(),
          entry: z.object({ __typename: z.string() }).optional(),
          llmText: z.string().nullable(),
          timestamp: z.object({ iso8601: z.string() }),
        }),
      }),
    ),
    pageInfo,
  }),
});
export type PlainDiscussion = z.infer<typeof discussionSchema>;
export type PlainThread = z.infer<typeof threadSchema>;
const draftStateSchema = z.object({
  thread: z
    .object({
      id,
      status: z.string(),
      customer: z.object({ id }),
      timelineEntries: z.object({
        edges: z.array(
          z.object({
            node: z.object({
              id,
              timestamp: z.object({ iso8601: z.iso.datetime({ offset: true }) }),
              actor: z.object({ __typename: z.string() }),
            }),
          }),
        ),
      }),
    })
    .nullable(),
  generatedReplies: z.array(
    z.object({
      timelineEntryId: id.nullable(),
      createdBy: z.object({ machineUserId: id.optional() }),
    }),
  ),
});
export interface PlainClient {
  draftState(threadId: string): Promise<z.infer<typeof draftStateSchema>>;
  addGeneratedReply(threadId: string, timelineEntryId: string, markdown: string): Promise<void>;
  identity(): Promise<{ workspaceId: string; agentId: string }>;
  discussion(id: string): Promise<PlainDiscussion>;
  thread(id: string): Promise<PlainThread>;
  customerMembership(customerId: string): Promise<PlainMembership>;
  sendDiscussionMessage(id: string, content: string): Promise<void>;
  createNote(threadId: string, customerId: string, content: string): Promise<void>;
  setStatus(id: string, status: "IN_PROGRESS" | "IDLE"): Promise<void>;
}

/** Deliberately exposes no customer reply, impersonation, assignment, or resolution mutations. */
export function createPlainClient(options: {
  apiKey: string;
  endpoint?: string;
  fetch?: typeof fetch;
}): PlainClient {
  const endpoint = options.endpoint ?? "https://core-api.uk.plain.com/graphql/v1";
  const transport = options.fetch ?? fetch;
  async function query(
    document: string,
    variables: Record<string, unknown> = {},
  ): Promise<unknown> {
    const response = await transport(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query: document, variables }),
    });
    // Never expose response bodies (customer data) or credentials in error messages/logs.
    if (!response.ok) throw new Error(`plain_http_${response.status}`);
    const body = await readBoundedRequestBody(response, 2_097_152);
    if (body instanceof Response) throw new Error("plain_response_too_large");
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new Error("plain_response_invalid");
    }
    const result = z
      .object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() })
      .parse(payload);
    if (result.errors?.length || result.data === undefined || result.data === null)
      throw new Error("plain_graphql_error");
    return result.data;
  }
  async function mutate(
    name: string,
    inputType: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    const data = await query(
      `mutation($input: ${inputType}!) { ${name}(input: $input) { error { code } } }`,
      { input },
    );
    const result = z.record(z.string(), z.object({ error: z.unknown().nullable() })).parse(data)[
      name
    ];
    if (result === undefined || result.error !== null) throw new Error("plain_mutation_error");
  }
  return {
    async draftState(threadId) {
      // Plain returns suggestions for the latest inbound message. Read only their provenance.
      return draftStateSchema.parse(
        await query(
          `query($id: ID!) {
          thread(threadId: $id) { id status customer { id }
            timelineEntries(last: 1, filters: { isMessage: true }) {
              edges { node { id timestamp { iso8601 } actor { __typename } } }
            }
          }
          generatedReplies(threadId: $id) {
            timelineEntryId createdBy { ... on MachineUserActor { machineUserId } }
          }
        }`,
          { id: threadId },
        ),
      );
    },
    addGeneratedReply: (threadId, timelineEntryId, markdown) =>
      mutate("addGeneratedReply", "AddGeneratedReplyInput", {
        threadId,
        timelineEntryId,
        markdown,
      }),
    async identity() {
      const data = identitySchema.parse(
        await query("query { myMachineUser { id } myWorkspace { id } }"),
      );
      if (data.myMachineUser === null || data.myWorkspace === null)
        throw new Error("plain_machine_user_required");
      return { workspaceId: data.myWorkspace.id, agentId: data.myMachineUser.id };
    },
    async discussion(discussionId) {
      const data = await query(
        `query($id: ID!) { discussion(discussionId: $id) { id threadId type status agent { id }
        messages(last: 50) { edges { node { id text type createdAt { iso8601 } } } pageInfo { hasPreviousPage } } } }`,
        { id: discussionId },
      );
      return z.object({ discussion: discussionSchema }).parse(data).discussion;
    },
    async thread(threadId) {
      const data = await query(
        `query($id: ID!) { thread(threadId: $id) { id title account { ${accountSelection} } customer { id fullName company { id name } }
        timelineEntries(last: 50) { edges { node { id actor { __typename } entry { __typename } llmText timestamp { iso8601 } } } pageInfo { hasPreviousPage } } } }`,
        { id: threadId },
      );
      return z.object({ thread: threadSchema }).parse(data).thread;
    },
    async customerMembership(customerId) {
      const data = await query(
        `query($id: ID!) { customer(customerId: $id) { id accountMemberships(first: 2) {
          edges { node { account { ${accountSelection} } } } pageInfo { hasNextPage }
        } } }`,
        { id: customerId },
      );
      const { customer } = membershipCustomerSchema.parse(data);
      if (customer?.id !== customerId) return { status: "unavailable" };
      const { edges, pageInfo: pagination } = customer.accountMemberships;
      if (pagination.hasNextPage || edges.length > 1) return { status: "multiple" };
      const first = edges[0];
      return first ? { status: "sole", account: first.node.account } : { status: "none" };
    },
    sendDiscussionMessage: (discussionId, markdownContent) =>
      mutate("sendDiscussionMessage", "SendDiscussionMessageInput", {
        discussionId,
        markdownContent,
      }),
    createNote: (threadId, customerId, content) =>
      mutate("createNote", "CreateNoteInput", {
        threadId,
        customerId,
        text: content,
        markdown: content,
      }),
    setStatus: (discussionId, agentStatus) =>
      mutate("updateDiscussionAgentStatus", "UpdateDiscussionAgentStatusInput", {
        discussionId,
        agentStatus,
      }),
  };
}

function accountProject(fields: z.infer<typeof accountFieldSchema>[]): AccountProject {
  const matches = fields.filter((field) => field.externalFieldId === "gcp_project_id");
  const [field] = matches;
  if (field === undefined) return { status: "missing" };
  if (matches.length !== 1) return { status: "ambiguous" };
  const value = field.value;
  const projectId = value.stringValue?.trim();
  if (
    value.__typename !== "AccountFieldStringValue" ||
    projectId === undefined ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(projectId)
  )
    return { status: "invalid" };
  return { status: "valid", projectId };
}
