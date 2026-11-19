import { z } from "zod";
import { DurableWorkflowEngine } from "../../workflows/engine.js";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isAcceptedTriggerProviderMatch } from "../../triggers/index.js";
import { createPlainProvider, createPlainReplyExecutor } from "./provider.js";
import { fixture } from "./test-utils.js";

describe("Plain internal investigations", () => {
  it("continues the same discussion, isolates other discussions, and accepts workflow actors", async () => {
    const f = await fixture();
    const provider = createPlainProvider({
      ...f,
      configurationStoreForProject: () => f.store,
      connectionsForProject: () => {
        throw new Error("not needed");
      },
    });
    const matches = await provider.match(f.external);
    assert.ok(typeof matches !== "string");
    const match = matches[0];
    assert.ok(isAcceptedTriggerProviderMatch(match));
    assert.equal(match.conversation?.key, f.event.conversationKey);
    const other = {
      ...f.external,
      payload: { ...f.event, conversationKey: "other", discussionId: "other" },
    };
    const next = await provider.match(other);
    assert.ok(typeof next !== "string");
    assert.notEqual(next[0]?.conversation?.key, match.conversation?.key);
  });
  it("binds replies to the originating discussion and rejects extra routing arguments", async () => {
    const f = await fixture();
    const reply = createPlainReplyExecutor(f);
    const outputContext = { provider: "plain", ...f.binding, event: f.event };
    await reply({
      agentExecutionId: "execution",
      toolType: "plain.reply",
      args: { content: "Internal findings" },
      outputContext,
    });
    assert.deepEqual(f.calls, [["discussion", "d_one", "Internal findings"]]);
    await assert.rejects(
      reply({
        agentExecutionId: "execution",
        toolType: "plain.reply",
        args: { content: "Hi", discussionId: "other" },
        outputContext,
      }),
    );
    await assert.rejects(
      reply({
        agentExecutionId: "execution",
        toolType: "plain.reply",
        args: { content: "Hi" },
        outputContext: { ...outputContext, projectId: "other" },
      }),
    );
    assert.equal(f.calls.length, 1);
  });
  it("writes an internal note for a note investigation", async () => {
    const f = await fixture();
    const reply = createPlainReplyExecutor(f);
    const event = {
      ...f.event,
      source: "plain.note",
      discussionId: null,
      threadId: "t_example",
      customerId: "c_example",
    };
    await reply({
      agentExecutionId: "execution",
      toolType: "plain.reply",
      args: { content: "Findings" },
      outputContext: { provider: "plain", ...f.binding, event },
    });
    assert.deepEqual(f.calls, [["note", "t_example", "c_example", "Findings"]]);
  });
  it("persists stop-before-start suppression and rejects late output while allowing a later turn", async () => {
    const f = await fixture();
    await f.database.persistPlainEvent({
      ...f.external,
      payload: { ...f.event, source: "plain.stop", timestamp: "2026-10-22T10:01:00Z" },
      source: "plain.stop",
      deliveryId: "stop",
      resourceId: f.event.conversationKey,
    });
    const provider = createPlainProvider({
      ...f,
      configurationStoreForProject: () => f.store,
      connectionsForProject: () => {
        throw new Error("not needed");
      },
    });
    assert.equal(await provider.match(f.external), "agent_session_stopped");
    const reply = createPlainReplyExecutor(f);
    await assert.rejects(
      reply({
        agentExecutionId: "execution",
        toolType: "plain.reply",
        args: { content: "Late" },
        outputContext: { provider: "plain", ...f.binding, event: f.event },
      }),
      /stopped_by_user/u,
    );
    const later = await provider.match({
      ...f.external,
      payload: { ...f.event, timestamp: "2026-10-22T10:02:00Z" },
    });
    assert.ok(Array.isArray(later) && later.length === 1);
    assert.deepEqual(f.calls, []);
  });
  it("stops only the matching conversation and older turns", async () => {
    const f = await fixture();
    let selected = 0;
    const provider = createPlainProvider({
      ...f,
      configurationStoreForProject: () => f.store,
      connectionsForProject: () => {
        throw new Error("not needed");
      },
      executions: {
        async stopActive(input) {
          for (const event of [
            f.event,
            { ...f.event, conversationKey: "other" },
            { ...f.event, timestamp: "2026-10-22T10:03:00Z" },
          ]) {
            if (
              input.matches({
                outputContext: { provider: "plain", ...f.binding, event },
                triggerRunId: null,
              })
            )
              selected++;
          }
          return { stopped: selected };
        },
      },
    });
    assert.equal(
      await provider.match({
        ...f.external,
        payload: { ...f.event, source: "plain.stop", timestamp: "2026-10-22T10:01:00Z" },
      }),
      "agent_session_stopped",
    );
    assert.equal(selected, 1);
  });
  it("rejects a resolved or reassigned discussion before posting", async () => {
    const f = await fixture();
    const original = f.client.discussion.bind(f.client);
    f.client.discussion = async (id) => ({
      ...(await original(id)),
      agent: { id: "another_agent" },
    });
    await assert.rejects(
      createPlainReplyExecutor(f)({
        agentExecutionId: "execution",
        toolType: "plain.reply",
        args: { content: "Wrong destination" },
        outputContext: { provider: "plain", ...f.binding, event: f.event },
      }),
      /plain_discussion_unavailable/u,
    );
    assert.deepEqual(f.calls, []);
  });
});

it("does not launch disabled triggers", async () => {
  const f = await fixture();
  const provider = createPlainProvider({
    ...f,
    isEnabled: async () => false,
    configurationStoreForProject: () => f.store,
    connectionsForProject: () => {
      throw new Error("unused");
    },
  });
  assert.equal(await provider.match(f.external), "configuration_unavailable");
});
it("materializes bounded account context only on request and excludes later messages", async () => {
  const f = await fixture();
  const event = { ...f.event, threadId: "t_example" };
  const original = f.client.discussion.bind(f.client);
  f.client.discussion = async (id) => ({
    ...(await original(id)),
    threadId: "t_example",
    messages: {
      edges: [
        {
          node: {
            id: "old",
            text: "x".repeat(5000),
            type: "OUTBOUND",
            createdAt: { iso8601: "2026-10-22T09:59:00Z" },
          },
        },
        {
          node: {
            id: "future",
            text: "later request",
            type: "OUTBOUND",
            createdAt: { iso8601: "2026-10-22T10:01:00Z" },
          },
        },
      ],
      pageInfo: { hasPreviousPage: false },
    },
  });
  const provider = createPlainProvider({
    ...f,
    mapping: {
      accounts: { acc_example: { projects: ["example-test"], defaultProject: "example-test" } },
    },
    configurationStoreForProject: () => f.store,
    connectionsForProject: () => {
      throw new Error("unused");
    },
  });
  const matches = await provider.match({ ...f.external, payload: event });
  assert.ok(typeof matches !== "string");
  const match = matches[0];
  assert.ok(isAcceptedTriggerProviderMatch(match));
  const context = z
    .object({
      discussion: z.object({
        messages: z.object({ edges: z.array(z.object({ node: z.object({ text: z.string() }) })) }),
      }),
      projectMapping: z.object({ status: z.string(), defaultProject: z.string() }),
      contextLimits: z.object({ complete: z.boolean() }),
    })
    .parse(
      await provider.materializeContext!({
        executionId: "execution",
        ...f.external,
        triggerContext: match.triggerContext,
      }),
    );
  assert.equal(context.discussion.messages.edges.length, 1);
  assert.equal(context.discussion.messages.edges[0]?.node.text.length, 4000);
  assert.equal(context.contextLimits.complete, false);
  assert.equal(context.projectMapping.status, "mapped");
  assert.equal(context.projectMapping.defaultProject, "example-test");
});

it("replaying an inbox receipt after a crash creates only one durable workflow run", async () => {
  const f = await fixture();
  const provider = createPlainProvider({
    ...f,
    configurationStoreForProject: () => f.store,
    connectionsForProject: () => {
      throw new Error("unused");
    },
  });
  const receipt = await f.database.persistPlainEvent({
    ...f.external,
    resourceId: f.event.conversationKey,
  });
  assert.equal(receipt.status, "accepted");
  if (receipt.status !== "accepted") throw new Error("missing receipt");
  const engine = new DurableWorkflowEngine({
    database: f.database,
    entitlements: null,
    providers: [provider],
  });
  await engine.enqueue(receipt.event);
  await engine.enqueue(receipt.event);
  assert.equal((await f.database.listTriggerRunsForProject(f.project.id, 10)).length, 1);
});

it("does not update status after reassignment, but still stops the local execution", async () => {
  const f = await fixture();
  const original = f.client.discussion.bind(f.client);
  f.client.discussion = async (id) => ({ ...(await original(id)), agent: { id: "other" } });
  let cancelled = false;
  const provider = createPlainProvider({
    ...f,
    configurationStoreForProject: () => f.store,
    connectionsForProject: () => {
      throw new Error("unused");
    },
    executions: {
      async stopActive() {
        cancelled = true;
        return { stopped: 1 };
      },
    },
  });
  const matches = await provider.match(f.external);
  assert.ok(typeof matches !== "string");
  const match = matches[0];
  assert.ok(isAcceptedTriggerProviderMatch(match));
  await assert.rejects(
    provider.onAgentExecutionStarted!(match.triggerContext, match.outputContext),
    /plain_discussion_unavailable/u,
  );
  await provider.match({ ...f.external, payload: { ...f.event, source: "plain.stop" } });
  assert.equal(cancelled, true);
  assert.deepEqual(f.calls, []);
});

it.each(["failed", "no_response"])(
  "retries %s status failures without duplicating the internal notice",
  async (outcome) => {
    const f = await fixture();
    let statusAttempts = 0;
    f.client.setStatus = async () => {
      statusAttempts++;
      if (statusAttempts === 1) throw new Error("plain_http_503");
      f.calls.push(["status", "IDLE"]);
    };
    const provider = createPlainProvider({
      ...f,
      configurationStoreForProject: () => f.store,
      connectionsForProject: () => {
        throw new Error("unused");
      },
    });
    const matches = await provider.match(f.external);
    assert.ok(typeof matches !== "string");
    const match = matches[0];
    assert.ok(isAcceptedTriggerProviderMatch(match));
    const notify = () =>
      outcome === "failed"
        ? provider.onAgentExecutionFailed!(match.triggerContext, match.outputContext, "failed")
        : provider.onAgentExecutionCompleted!(match.triggerContext, match.outputContext, {
            status: "succeeded",
            outputEmissions: {},
          });
    await assert.rejects(notify(), /plain_http_503/u);
    assert.equal(f.calls.length, 0);
    await notify();
    assert.equal(statusAttempts, 2);
    assert.equal(f.calls.filter(([kind]) => kind === "discussion").length, 1);
  },
);
