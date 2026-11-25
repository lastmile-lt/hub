import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import type { PlainClient } from "./client.js";
import { normalizePlainEvent } from "./events.js";
export function discussionEvent() {
  return {
    id: "ev_one",
    type: "discussion.message_created",
    workspaceId: "ws_example",
    timestamp: "2026-10-22T10:00:00Z",
    payload: {
      eventType: "discussion.message_created",
      discussion: {
        id: "d_one",
        type: "AGENT_SESSION",
        status: "OPEN",
        agent: { id: "mu_example" },
        threadId: null,
      },
      message: {
        id: "m_one",
        type: "OUTBOUND",
        markdown: "Investigate",
        createdAt: "2026-10-22T10:00:00Z",
        createdBy: { actorType: "system" },
      },
    },
  };
}
export async function fixture() {
  const database = createMemoryDatabase();
  const active = await createActiveProjectConfiguration(database, {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "plain-support",
        on: "plain.discussion",
        max_runtime: "10m",
        filters: { from_users: ["*"] },
        steps: [
          {
            id: "investigate",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "${{ paseo.prompt }}" }],
          },
        ],
      },
    ],
  });
  const binding = {
    organizationId: active.project.organizationId,
    projectId: active.project.id,
    workspaceId: "ws_example",
    agentId: "mu_example",
  };
  const event = normalizePlainEvent(discussionEvent(), binding.workspaceId, binding.agentId)!;
  const calls: unknown[][] = [];
  const client: PlainClient = {
    async identity() {
      return { workspaceId: binding.workspaceId, agentId: binding.agentId };
    },
    async discussion(id) {
      return {
        id,
        threadId: null,
        type: "AGENT_SESSION",
        status: "OPEN",
        agent: { id: binding.agentId },
        messages: { edges: [], pageInfo: { hasPreviousPage: false } },
      };
    },
    async thread(id) {
      return {
        id,
        title: "Example thread",
        account: { id: "acc_example", name: "Example", gcpProject: { status: "missing" } },
        customer: { id: "c_example", fullName: "Example customer", company: null },
        timelineEntries: { edges: [], pageInfo: { hasPreviousPage: false } },
      };
    },
    async draftState() {
      throw new Error("unexpected draft lookup");
    },
    async addGeneratedReply(...args) {
      calls.push(["suggestion", ...args]);
    },
    async customerMembership() {
      throw new Error("unexpected membership lookup for a linked or standalone investigation");
    },
    async sendDiscussionMessage(...args) {
      calls.push(["discussion", ...args]);
    },
    async createNote(...args) {
      calls.push(["note", ...args]);
    },
    async setStatus(...args) {
      calls.push(["status", ...args]);
    },
  };
  const external = {
    providerEventReceiptId: "00000000-0000-4000-8000-000000000001",
    organizationId: binding.organizationId,
    projectId: binding.projectId,
    configurationRevisionId: active.revision.id,
    source: event.source,
    deliveryId: event.deliveryId,
    receivedAt: new Date(),
    payload: event,
  };
  return {
    database,
    binding,
    event,
    external,
    client,
    calls,
    isEnabled: async () => true,
    ...active,
  };
}
