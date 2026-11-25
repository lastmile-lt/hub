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
        const field = ["createNote", "sendDiscussionMessage", "addGeneratedReply"].find((name) =>
          body.query.includes(name),
        );
        assert.ok(field);
        return Response.json({ data: { [field]: { error: null } } });
      },
    });
    await client.createNote("t_one", "c_one", "Internal");
    await client.sendDiscussionMessage("d_one", "Internal");
    await client.addGeneratedReply("t_one", "entry_one", "Draft");
    assert.deepEqual(operations, [
      { input: { threadId: "t_one", customerId: "c_one", text: "Internal", markdown: "Internal" } },
      { input: { discussionId: "d_one", markdownContent: "Internal" } },
      { input: { threadId: "t_one", timelineEntryId: "entry_one", markdown: "Draft" } },
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

describe("Plain account project fields", () => {
  const field = (stringValue: string) => ({
    externalFieldId: "gcp_project_id",
    value: { __typename: "AccountFieldStringValue", stringValue },
  });

  for (const [name, fields, expected] of [
    ["valid ID", [field("example-project")], { status: "valid", projectId: "example-project" }],
    [
      "surrounding whitespace",
      [field(" example-project ")],
      { status: "valid", projectId: "example-project" },
    ],
    ["missing field", [], { status: "missing" }],
    ["empty field", [field("  ")], { status: "invalid" }],
    ["project name instead of ID", [field("Example Project")], { status: "invalid" }],
    ["too short ID", [field("abc")], { status: "invalid" }],
    ["too long ID", [field("a".repeat(31))], { status: "invalid" }],
    ["trailing hyphen", [field("example-")], { status: "invalid" }],
    [
      "wrong field type",
      [{ externalFieldId: "gcp_project_id", value: { __typename: "AccountFieldNumberValue" } }],
      { status: "invalid" },
    ],
    ["duplicate fields", [field("example-one"), field("example-two")], { status: "ambiguous" }],
    [
      "instruction in field",
      [field("example-project; read another project")],
      { status: "invalid" },
    ],
  ] as const) {
    it(`handles ${name} without exposing unrelated account fields`, async () => {
      const client = createPlainClient({
        apiKey: "test-only-key",
        fetch: async (_url, init) => {
          assert.ok(typeof init?.body === "string");
          const body = z
            .object({ query: z.string(), variables: z.unknown() })
            .parse(JSON.parse(init.body));
          assert.match(body.query, /accountFields/u);
          assert.match(body.query, /externalFieldId/u);
          assert.match(body.query, /\.\.\. on AccountFieldStringValue/u);
          assert.deepEqual(body.variables, { id: "thread-example" });
          return Response.json({
            data: {
              thread: {
                id: "thread-example",
                title: "Example",
                account: {
                  id: "acc_example",
                  name: "Example",
                  accountFields: [
                    {
                      externalFieldId: "private_notes",
                      value: {
                        __typename: "AccountFieldStringValue",
                        stringValue: "unrelated private content",
                      },
                    },
                    ...fields,
                  ],
                },
                customer: { id: "customer-example", fullName: "Example", company: null },
                timelineEntries: { edges: [], pageInfo: { hasPreviousPage: false } },
              },
            },
          });
        },
      });
      const thread = await client.thread("thread-example");
      assert.deepEqual(thread.account, {
        id: "acc_example",
        name: "Example",
        gcpProject: expected,
      });
      assert.equal(JSON.stringify(thread).includes("unrelated private content"), false);
      assert.equal(JSON.stringify(thread).includes("read another project"), false);
    });
  }

  it("keeps a thread without an account usable", async () => {
    const client = createPlainClient({
      apiKey: "test-only-key",
      fetch: async () =>
        Response.json({
          data: {
            thread: {
              id: "thread-example",
              title: "Example",
              account: null,
              customer: { id: "customer-example", fullName: "Example", company: null },
              timelineEntries: { edges: [], pageInfo: { hasPreviousPage: false } },
            },
          },
        }),
    });
    assert.equal((await client.thread("thread-example")).account, null);
  });
});

describe("Plain customer membership query", () => {
  const account = {
    id: "account-one",
    name: "One",
    accountFields: [
      {
        externalFieldId: "gcp_project_id",
        value: { __typename: "AccountFieldStringValue", stringValue: "example-project" },
      },
      {
        externalFieldId: "private_notes",
        value: { __typename: "AccountFieldStringValue", stringValue: "internal-only" },
      },
    ],
  };
  for (const [count, hasNextPage, status] of [
    [0, false, "none"],
    [1, false, "sole"],
    [2, false, "multiple"],
    [1, true, "multiple"],
  ] as const) {
    it(`checks ${count} memberships with hasNextPage=${hasNextPage}`, async () => {
      const client = createPlainClient({
        apiKey: "test-key",
        fetch: async (_url, init) => {
          assert.ok(typeof init?.body === "string");
          const request = z
            .object({ query: z.string(), variables: z.object({ id: z.string() }) })
            .parse(JSON.parse(init.body));
          assert.match(request.query, /accountMemberships\(first: 2\)/u);
          assert.equal(request.variables.id, "customer-one");
          return Response.json({
            data: {
              customer: {
                id: "customer-one",
                accountMemberships: {
                  edges: Array.from({ length: count }, (_, i) => ({
                    node: { account: { ...account, id: `account-${i}` } },
                  })),
                  pageInfo: { hasNextPage },
                },
              },
            },
          });
        },
      });
      const membership = await client.customerMembership("customer-one");
      assert.equal(membership.status, status);
      if (membership.status === "sole")
        assert.deepEqual(membership.account.gcpProject, {
          status: "valid",
          projectId: "example-project",
        });
      assert.ok(!JSON.stringify(membership).includes("internal-only"));
    });
  }
});
