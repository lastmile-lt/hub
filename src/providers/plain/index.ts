import { logger } from "../../logger.js";
import type { TriggerHandler } from "../../triggers/index.js";
import type { Database } from "../../db/types.js";
import type { ProviderRegistration } from "../registration.js";
import { outputContextProvider } from "../../execution-capabilities/outputs.js";
import { createPlainClient, type PlainClient } from "./client.js";
import { readPlainConfiguration, type PlainConfiguration } from "./config.js";
import { createPlainProvider, createPlainReplyExecutor, plainReplyTool } from "./provider.js";
import { createPlainWebhookSource } from "./webhook.js";

/**
 * Plain must not stop the rest of Hub from starting. A configuration error or a missing
 * trigger disables only Plain until the configuration is fixed and Hub restarts.
 */
export async function loadPlainRegistration(options: {
  database: Database;
  env: NodeJS.ProcessEnv;
}): Promise<ProviderRegistration | undefined> {
  try {
    const configuration = await readPlainConfiguration(options.env);
    if (configuration === undefined) return undefined;
    return await createPlainRegistration({ database: options.database, configuration });
  } catch (error) {
    logger.error(
      {
        provider: "plain",
        operation: "plain.startup",
        reason: error instanceof Error ? error.message : "unknown",
      },
      "Plain is disabled because its configuration could not be loaded",
    );
    return undefined;
  }
}

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
  let running = false;
  let verified = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking: Promise<void> | undefined;
  const requireVerified = () => {
    if (!verified) throw new Error("plain_unavailable");
  };
  // Recovery can invoke provider hooks and outputs before the source starts. Gate every
  // API operation as well as webhook intake until the configured identity is verified.
  const verifiedClient: PlainClient = {
    identity: () => client.identity(),
    discussion: (id) => {
      requireVerified();
      return client.discussion(id);
    },
    thread: (id) => {
      requireVerified();
      return client.thread(id);
    },
    sendDiscussionMessage: (id, content) => {
      requireVerified();
      return client.sendDiscussionMessage(id, content);
    },
    createNote: (threadId, customerId, content) => {
      requireVerified();
      return client.createNote(threadId, customerId, content);
    },
    setStatus: (id, status) => {
      requireVerified();
      return client.setStatus(id, status);
    },
  };
  const scheduleVerification = (handler: TriggerHandler, delay: number) => {
    timer = setTimeout(() => {
      checking = (async () => {
        try {
          const identity = await client.identity();
          if (identity.workspaceId !== binding.workspaceId || identity.agentId !== binding.agentId)
            throw new Error("plain_api_identity_mismatch");
          if (!running) return;
          await source.start(handler);
          verified = running;
        } catch {
          // Do not log upstream error bodies, which may contain sensitive data.
          logger.warn(
            { provider: "plain", operation: "plain.identity.verify" },
            "Plain is unavailable; identity verification will retry",
          );
          if (running) scheduleVerification(handler, 30_000);
        }
      })().finally(() => {
        checking = undefined;
      });
    }, delay);
    timer.unref();
  };
  return {
    connection: {
      name: "plain",
      status: () => ({ status: verified ? "configured" : "unavailable" }),
      actions: {},
    },
    sources: [
      {
        async start(handler) {
          if (running) return;
          running = true;
          scheduleVerification(handler, 0);
        },
        async stop() {
          running = false;
          verified = false;
          clearTimeout(timer);
          await checking;
          await source.stop();
        },
      },
    ],
    triggerProviders: [
      (resources) =>
        createPlainProvider({
          ...resources,
          database,
          client: verifiedClient,
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
        execute: createPlainReplyExecutor({ database, client: verifiedClient, binding }),
      },
    ],
    requests: [
      {
        name: "plain.events",
        handle: async (request) =>
          verified
            ? source.handle(request)
            : Response.json({ error: "plain_unavailable" }, { status: 503 }),
      },
    ],
  };
}
