import assert from "node:assert/strict";
import { createApplicationRuntime } from "../../application-runtime.js";
import { createUnlimitedEntitlementsService } from "../../entitlements/test-utils.js";
import { createHmac } from "node:crypto";
import { afterEach, it, vi } from "vitest";
import { acceptingAgentValidator } from "../../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../../test-utils/project-configuration.js";
import { OrganizationTriggerStore } from "../../triggers/store.js";
import { createPlainRegistration } from "./index.js";
import { discussionEvent, fixture } from "./test-utils.js";

async function registrationFixture() {
  const f = await fixture();
  await enrollTestDaemon(f.database, f.binding.organizationId);
  const trigger = await new OrganizationTriggerStore(
    f.database,
    f.binding.organizationId,
    acceptingAgentValidator(),
  ).save({
    yaml: `name: plain-internal
on:
  plain.discussion:
    filters: { from_users: ["*"] }
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Investigate
`,
    userId: null,
  });
  const configuration = {
    apiKey: "test-only-key",
    signingSecret: "test-only-secret",
    workspaceId: f.binding.workspaceId,
    agentId: f.binding.agentId,
    organizationId: f.binding.organizationId,
    triggerId: trigger.id,
    endpoint: "https://plain.example/graphql",
  };
  const registration = await createPlainRegistration({
    database: f.database,
    configuration,
    client: f.client,
  });
  return { ...f, registration, configuration, trigger };
}
function signedRequest(secret: string) {
  const body = JSON.stringify(discussionEvent());
  return new Request("https://hub.example/api/integrations/plain/events", {
    method: "POST",
    body,
    headers: { "plain-request-signature": createHmac("sha256", secret).update(body).digest("hex") },
  });
}
afterEach(() => vi.useRealTimers());

it.each(["unavailable", "wrong_identity"])(
  "isolates %s from Hub startup, gates requests and outputs, and recovers",
  async (failure) => {
    vi.useFakeTimers();
    const f = await registrationFixture();
    let healthy = false;
    f.client.identity = async () => {
      if (!healthy && failure === "unavailable") throw new Error("plain_http_503");
      return { workspaceId: healthy ? f.binding.workspaceId : "wrong", agentId: f.binding.agentId };
    };
    const source = f.registration.sources[0]!;
    const request = f.registration.requests[0]!;
    await source.start(async () => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      assert.deepEqual(
        f.registration.connection.status(
          await f.database.organizationConnectionUsage(f.binding.organizationId),
        ),
        { status: "unavailable" },
      );
      assert.equal(
        (await request.handle(signedRequest(f.configuration.signingSecret))).status,
        503,
      );
      await assert.rejects(
        f.registration.outputs[0]!.execute({
          agentExecutionId: "execution",
          toolType: "plain.reply",
          args: { content: "Not yet" },
          outputContext: {
            provider: "plain",
            ...f.binding,
            projectId: f.trigger.runtimeProjectId,
            event: f.event,
          },
        }),
        /plain_unavailable/u,
      );
      assert.deepEqual(f.calls, []);
      healthy = true;
      await vi.advanceTimersByTimeAsync(30_000);
      assert.deepEqual(
        f.registration.connection.status(
          await f.database.organizationConnectionUsage(f.binding.organizationId),
        ),
        { status: "configured" },
      );
      assert.equal(
        (await request.handle(signedRequest(f.configuration.signingSecret))).status,
        200,
      );
      assert.equal(
        (
          await f.database.pendingPlainEvents({
            ...f.binding,
            projectId: f.trigger.runtimeProjectId,
          })
        ).length,
        1,
      );
      assert.equal((await f.database.pendingPlainEvents(f.binding)).length, 0);
    } finally {
      await source.stop();
    }
    assert.equal((await request.handle(signedRequest(f.configuration.signingSecret))).status, 503);
  },
);

it("does not wait for a slow identity request at startup or activate after stop", async () => {
  vi.useFakeTimers();
  const f = await registrationFixture();
  let resolveIdentity!: (value: { workspaceId: string; agentId: string }) => void;
  f.client.identity = () =>
    new Promise((resolve) => {
      resolveIdentity = resolve;
    });
  const source = f.registration.sources[0]!;
  await source.start(async () => {
    throw new Error("must not dispatch");
  });
  await vi.advanceTimersByTimeAsync(0);
  const stopping = source.stop();
  resolveIdentity(f.binding);
  await stopping;
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(
    (await f.registration.requests[0]!.handle(signedRequest(f.configuration.signingSecret))).status,
    503,
  );
  assert.equal(vi.getTimerCount(), 0);
});

it("rejects a trigger outside the configured organization", async () => {
  const f = await registrationFixture();
  await assert.rejects(
    createPlainRegistration({
      database: f.database,
      configuration: { ...f.configuration, organizationId: "another-org" },
      client: f.client,
    }),
    /plain_hub_trigger_not_found/u,
  );
});

it("keeps the shared Hub runtime and another provider available during a Plain outage", async () => {
  vi.useFakeTimers();
  const f = await registrationFixture();
  f.client.identity = async () => {
    throw new Error("plain_http_503");
  };
  let otherStarted = false;
  const runtime = await createApplicationRuntime({
    database: f.database,
    auth: null,
    billing: null,
    entitlements: createUnlimitedEntitlementsService(),
    registrations: [
      f.registration,
      {
        connection: { name: "other", status: () => ({ status: "configured" }), actions: {} },
        triggerProviders: [],
        outputs: [],
        sources: [
          {
            start: async () => {
              otherStarted = true;
            },
            stop: async () => {},
          },
        ],
        requests: [{ name: "other.events", handle: async () => new Response("OK") }],
      },
    ],
    close: async () => {},
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(otherStarted, true);
    assert.equal(
      (await runtime.providerRequest("other.events", new Request("https://hub.example"))).status,
      200,
    );
    assert.equal(
      (await runtime.providerRequest("plain.events", signedRequest(f.configuration.signingSecret)))
        .status,
      503,
    );
  } finally {
    await runtime.stop();
  }
});
