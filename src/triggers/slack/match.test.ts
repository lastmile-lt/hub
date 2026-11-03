import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/index.js";
import type { NormalizedSlackEvent } from "./events.js";
import { matchSlackTriggers, readSlackPromptBody } from "./match.js";

describe("Slack trigger matching", () => {
  it("allows exact, case-sensitive Slack usernames as well as user IDs", () => {
    const config = configForUsers(["operator", "U2"]);

    assert.equal(matchSlackTriggers(config, mention({ username: "operator" }), "UBOT").length, 1);
    assert.equal(matchSlackTriggers(config, mention({ username: "Operator" }), "UBOT").length, 0);
    assert.equal(matchSlackTriggers(config, mention({ authorId: "U2" }), "UBOT").length, 1);
  });

  it("allows every human author only when the wildcard is explicit", () => {
    const config = configForUsers(["*"]);

    assert.equal(matchSlackTriggers(config, mention({ authorId: "stranger" }), "UBOT").length, 1);
  });

  it("requires the compiled trigger filters and bot mention", () => {
    const config = compileHubConfig({
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "slack-run",
          on: "slack.mention",
          max_runtime: "2h",
          filters: {
            workspace: "T1",
            channels: ["C1"],
            from_users: ["U1"],
            pattern: "run",
          },
          steps: [
            {
              id: "run",
              environment: "runner",
              max_runtime: "1h",
              idle_timeout: "5m",
              agent: { provider: "opencode", mode: "default" },
              prompt: [{ text: "Run the request" }],
            },
          ],
        },
      ],
    });
    const event = mention();

    assert.equal(matchSlackTriggers(config, event, "UBOT").length, 1);
    assert.equal(readSlackPromptBody(event, "UBOT"), "run tests");
    assert.equal(
      matchSlackTriggers(config, { ...event, author: { id: "UBOT" } }, "UBOT").length,
      0,
    );
    assert.equal(matchSlackTriggers(config, { ...event, teamId: "T2" }, "UBOT").length, 0);
    assert.equal(matchSlackTriggers(config, { ...event, channelId: "C2" }, "UBOT").length, 0);
    assert.equal(
      matchSlackTriggers(config, { ...event, content: "<@UBOT> please run tests" }, "UBOT").length,
      0,
    );
    assert.equal(matchSlackTriggers(config, { ...event, content: "run tests" }, "UBOT").length, 0);
  });

  it("matches direct messages only to slack.direct_message triggers, without a bot mention", () => {
    const mentions = configForUsers(["*"]);
    const directMessages = configForUsers(["*"], "slack.direct_message", "D1");
    const dm: NormalizedSlackEvent = {
      ...mention(),
      type: "direct_message",
      channelId: "D1",
      content: "check the totals",
    };

    assert.equal(matchSlackTriggers(directMessages, dm, "UBOT").length, 1);
    assert.equal(readSlackPromptBody(dm, "UBOT"), "check the totals");
    assert.equal(matchSlackTriggers(mentions, { ...dm, channelId: "C1" }, "UBOT").length, 0);
    assert.equal(
      matchSlackTriggers(directMessages, { ...mention(), channelId: "D1" }, "UBOT").length,
      0,
    );
    assert.equal(
      matchSlackTriggers(directMessages, { ...dm, author: { id: "UBOT" } }, "UBOT").length,
      0,
    );
  });
});

function configForUsers(fromUsers: string[], on = "slack.mention", channel = "C1") {
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "slack-run",
        on,
        max_runtime: "2h",
        filters: { workspace: "T1", channels: [channel], from_users: fromUsers },
        steps: [
          {
            id: "run",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "opencode", mode: "default" },
            prompt: [{ text: "Run the request" }],
          },
        ],
      },
    ],
  });
}

function mention(overrides: { authorId?: string; username?: string } = {}): NormalizedSlackEvent {
  return {
    type: "mention",
    id: "Ev1",
    teamId: "T1",
    appId: "A1",
    channelId: "C1",
    messageTs: "1700000000.000001",
    threadTs: "1700000000.000001",
    eventTs: "1700000000.000001",
    eventTime: 1_700_000_001,
    content: "hello <@UBOT> run tests",
    author: {
      id: overrides.authorId ?? "U1",
      ...(overrides.username === undefined ? {} : { username: overrides.username }),
    },
    createdAt: new Date(1_700_000_000_000).toISOString(),
    attachments: [],
  };
}
