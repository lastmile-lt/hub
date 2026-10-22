import { z } from "zod";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createPlainClient } from "./client.js";
describe("Plain internal API client", () => {
  it("sends internal-only mutations with credentials outside the model", async () => {
    const operations: unknown[] = [];
    const client = createPlainClient({
      apiKey: "test-only-key",
      fetch: async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only-key");
        assert.ok(typeof init?.body === "string");
        const body = z
          .object({ query: z.string(), variables: z.unknown() })
          .parse(JSON.parse(init.body));
        operations.push(body.variables);
        assert.equal(/replyToThread|sendEmail|impersonation/u.test(body.query), false);
        const field = body.query.includes("createNote") ? "createNote" : "sendDiscussionMessage";
        return Response.json({ data: { [field]: { error: null } } });
      },
    });
    await client.createNote("t_one", "c_one", "Internal");
    await client.sendDiscussionMessage("d_one", "Internal");
    assert.deepEqual(operations, [
      { input: { threadId: "t_one", customerId: "c_one", text: "Internal", markdown: "Internal" } },
      { input: { discussionId: "d_one", markdownContent: "Internal" } },
    ]);
  });
  it("treats GraphQL and mutation errors as failures without leaking their bodies", async () => {
    for (const response of [
      { errors: [{ message: "sensitive customer content" }] },
      { data: { createNote: { error: { code: "FORBIDDEN", message: "sensitive" } } } },
    ]) {
      const client = createPlainClient({
        apiKey: "secret",
        fetch: async () => Response.json(response),
      });
      await assert.rejects(
        client.createNote("t", "c", "body"),
        (error: Error) =>
          error.message.startsWith("plain_") && !error.message.includes("sensitive"),
      );
    }
  });
  it("does not retry ambiguous mutation failures", async () => {
    let attempts = 0;
    const client = createPlainClient({
      apiKey: "secret",
      fetch: async () => {
        attempts++;
        throw new Error("network failed");
      },
    });
    await assert.rejects(client.sendDiscussionMessage("d", "response"));
    assert.equal(attempts, 1);
  });
});

it("does not expose malformed response text in parsing errors", async () => {
  const client = createPlainClient({
    apiKey: "secret",
    fetch: async () => new Response("sensitive customer content"),
  });
  await assert.rejects(client.identity(), { message: "plain_response_invalid" });
});
