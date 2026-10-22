import type { Database } from "../../db/types.js";
import type { ProviderRegistration } from "../registration.js";
import { outputContextProvider } from "../../execution-capabilities/outputs.js";
import { createPlainClient, type PlainClient } from "./client.js";
import type { PlainConfiguration } from "./config.js";
import { createPlainProvider, createPlainReplyExecutor, plainReplyTool } from "./provider.js";
import { createPlainWebhookSource } from "./webhook.js";

export async function createPlainRegistration(options: {
  database: Database;
  configuration: PlainConfiguration;
  client?: PlainClient;
}): Promise<ProviderRegistration> {
  const { database, configuration } = options;
  const client =
    options.client ??
    createPlainClient({ apiKey: configuration.apiKey, endpoint: configuration.endpoint });
  const resolveTrigger = async () =>
    (await database.listOrganizationTriggers(configuration.organizationId)).find(
      (trigger) => trigger.id === configuration.triggerId,
    );
  const trigger = await resolveTrigger();
  if (trigger === undefined) throw new Error("plain_hub_trigger_not_found");
  const binding = {
    organizationId: configuration.organizationId,
    projectId: trigger.runtimeProjectId,
    workspaceId: configuration.workspaceId,
    agentId: configuration.agentId,
  };
  const source = createPlainWebhookSource({
    database,
    binding,
    signingSecret: configuration.signingSecret,
  });
  return {
    connection: { name: "plain", status: () => ({ status: "configured" }), actions: {} },
    sources: [
      {
        async start(handler) {
          const identity = await client.identity();
          if (identity.workspaceId !== binding.workspaceId || identity.agentId !== binding.agentId)
            throw new Error("plain_api_identity_mismatch");
          await source.start(handler);
        },
        stop: () => source.stop(),
      },
    ],
    triggerProviders: [
      (resources) =>
        createPlainProvider({
          ...resources,
          database,
          client,
          binding,
          isEnabled: async () => (await resolveTrigger())?.enabled === true,
          ...(configuration.mapping === undefined ? {} : { mapping: configuration.mapping }),
        }),
    ],
    outputs: [
      {
        type: "plain.reply",
        tool: plainReplyTool,
        available: outputContextProvider("plain"),
        execute: createPlainReplyExecutor({ database, client, binding }),
      },
    ],
    requests: [{ name: "plain.events", handle: (request) => source.handle(request) }],
  };
}
