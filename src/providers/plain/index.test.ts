import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { it } from "vitest";
import { acceptingAgentValidator } from "../../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../../test-utils/project-configuration.js";
import { OrganizationTriggerStore } from "../../triggers/store.js";
import { createPlainRegistration } from "./index.js";
import { discussionEvent, fixture } from "./test-utils.js";

it("binds signed delivery to the selected organization trigger and verifies API identity", async () => {
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
  const source = registration.sources[0];
  assert.ok(source);
  f.client.identity = async () => ({ workspaceId: "wrong", agentId: f.binding.agentId });
  await assert.rejects(
    source.start(async () => {}),
    /plain_api_identity_mismatch/u,
  );
  const body = JSON.stringify(discussionEvent());
  const request = registration.requests[0];
  assert.ok(request);
  const response = await request.handle(
    new Request("https://hub.example/api/integrations/plain/events", {
      method: "POST",
      body,
      headers: {
        "plain-request-signature": createHmac("sha256", configuration.signingSecret)
          .update(body)
          .digest("hex"),
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(
    (await f.database.pendingPlainEvents({ ...f.binding, projectId: trigger.runtimeProjectId }))
      .length,
    1,
  );
  assert.equal((await f.database.pendingPlainEvents(f.binding)).length, 0);
  await assert.rejects(
    createPlainRegistration({
      database: f.database,
      configuration: { ...configuration, organizationId: "another-org" },
      client: f.client,
    }),
    /plain_hub_trigger_not_found/u,
  );
});
