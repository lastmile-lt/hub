import { readFile } from "node:fs/promises";
import { load } from "js-yaml";
import { z } from "zod";

const nonempty = z.string().min(1);
const mappingSchema = z
  .object({
    accounts: z.record(
      nonempty,
      z
        .object({
          name: nonempty.optional(),
          projects: z.array(nonempty).min(1),
          defaultProject: nonempty.optional(),
        })
        .strict()
        .refine(
          (m) => m.defaultProject === undefined || m.projects.includes(m.defaultProject),
          "defaultProject must be in projects",
        ),
    ),
  })
  .strict();
export type PlainAccountMapping = z.infer<typeof mappingSchema>;
export interface PlainConfiguration {
  apiKey: string;
  signingSecret: string;
  workspaceId: string;
  agentId: string;
  organizationId: string;
  triggerId: string;
  endpoint: string;
  mapping?: PlainAccountMapping;
}
export async function readPlainConfiguration(
  env: NodeJS.ProcessEnv,
): Promise<PlainConfiguration | undefined> {
  const names = [
    "PLAIN_HUB_API_KEY",
    "PLAIN_HUB_SIGNING_SECRET",
    "PLAIN_HUB_WORKSPACE_ID",
    "PLAIN_HUB_AGENT_ID",
    "PLAIN_HUB_ORGANIZATION_ID",
    "PLAIN_HUB_TRIGGER_ID",
  ] as const;
  if (
    names.every((name) => !env[name]) &&
    !env["PLAIN_HUB_ACCOUNT_MAPPING_PATH"] &&
    !env["PLAIN_HUB_API_URL"]
  )
    return undefined;
  for (const name of names)
    if (!env[name]?.trim()) throw new Error(`Plain configuration requires ${name}`);
  const endpoint = env["PLAIN_HUB_API_URL"] ?? "https://core-api.uk.plain.com/graphql/v1";
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("PLAIN_HUB_API_URL must be HTTPS without URL credentials");
  let mapping: PlainAccountMapping | undefined;
  if (env["PLAIN_HUB_ACCOUNT_MAPPING_PATH"]) {
    const content = await readFile(env["PLAIN_HUB_ACCOUNT_MAPPING_PATH"], "utf8");
    if (Buffer.byteLength(content) > 1_048_576)
      throw new Error("Plain account mapping exceeds 1 MiB");
    let parsed: unknown;
    try {
      parsed = load(content);
    } catch {
      // YAML parser messages quote the file, which holds private account data.
      throw new Error("Plain account mapping is not valid YAML");
    }
    const result = mappingSchema.safeParse(parsed);
    if (!result.success)
      throw new Error(
        `Plain account mapping is invalid: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    mapping = result.data;
  }
  return {
    apiKey: env["PLAIN_HUB_API_KEY"]!,
    signingSecret: env["PLAIN_HUB_SIGNING_SECRET"]!,
    workspaceId: env["PLAIN_HUB_WORKSPACE_ID"]!,
    agentId: env["PLAIN_HUB_AGENT_ID"]!,
    organizationId: env["PLAIN_HUB_ORGANIZATION_ID"]!,
    triggerId: env["PLAIN_HUB_TRIGGER_ID"]!,
    endpoint,
    ...(mapping === undefined ? {} : { mapping }),
  };
}
