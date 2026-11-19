import { readFile } from "node:fs/promises";
import { compileTriggerDocument } from "../../triggers/configuration/index.js";
import { projectTriggerForm, triggerFormErrors } from "../../triggers/configuration/editor.js";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { readPlainConfiguration } from "./config.js";
const env = {
  PLAIN_HUB_API_KEY: "test",
  PLAIN_HUB_SIGNING_SECRET: "test",
  PLAIN_HUB_AGENT_ID: "mu_example",
  PLAIN_HUB_WORKSPACE_ID: "ws_example",
  PLAIN_HUB_ORGANIZATION_ID: "org",
  PLAIN_HUB_TRIGGER_ID: "project",
};
describe("Plain operator configuration", () => {
  it("is inert by default and rejects partial or insecure configuration", async () => {
    assert.equal(await readPlainConfiguration({}), undefined);
    assert.equal(await readPlainConfiguration({ PLAIN_API_KEY: "unrelated-tool-key" }), undefined);
    await assert.rejects(
      readPlainConfiguration({ PLAIN_HUB_API_KEY: "test" }),
      /PLAIN_HUB_SIGNING_SECRET/u,
    );
    await assert.rejects(
      readPlainConfiguration({ ...env, PLAIN_HUB_API_URL: "http://example.com" }),
      /HTTPS/u,
    );
  });
  it("loads private account mappings and rejects defaults outside the allowed projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "plain-mapping-"));
    const path = join(root, "mapping.yml");
    try {
      await writeFile(
        path,
        "accounts:\n  acc_example:\n    projects: [example-test]\n    defaultProject: example-test\n",
      );
      assert.equal(
        (await readPlainConfiguration({ ...env, PLAIN_HUB_ACCOUNT_MAPPING_PATH: path }))?.mapping
          ?.accounts["acc_example"]?.defaultProject,
        "example-test",
      );
      await writeFile(
        path,
        "accounts:\n  acc_example:\n    projects: [example-test]\n    defaultProject: other-project\n",
      );
      await assert.rejects(
        readPlainConfiguration({ ...env, PLAIN_HUB_ACCOUNT_MAPPING_PATH: path }),
        /defaultProject/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("compiles the documented two-event trigger with internal replies and no OAuth connection", async () => {
  const doc = await readFile(new URL("../../../docs/plain.md", import.meta.url), "utf8");
  const yaml = doc.split("```yaml\n")[1]?.split("```")[0];
  assert.ok(yaml);
  const compiled = compileTriggerDocument(yaml);
  assert.deepEqual(
    compiled.events.map((event) => event.on),
    ["plain.discussion", "plain.note"],
  );
  for (const event of compiled.events)
    assert.ok(event.steps[0]?.allowOutputs.some((output) => output.type === "plain.reply"));
  const single = yaml.replace(/  plain.note:\n    filters:\n      from_users: \["\*"\]\n/u, "");
  const projection = projectTriggerForm(single);
  assert.ok(projection.status === "editable");
  assert.equal(triggerFormErrors(projection.value).connection, undefined);
});
