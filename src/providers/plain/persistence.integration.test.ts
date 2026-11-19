import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, it } from "vitest";
import { createDatabase } from "../../db/pg.js";
import { embeddedDatabaseRuntime, postgresDatabaseRuntime } from "../../db/runtime/index.js";
import { normalizePlainEvent } from "./events.js";
import { discussionEvent } from "./test-utils.js";

describe("Plain inbox persistence", () => {
  it.each(["embedded", "postgres"] as const)(
    "deduplicates, recovers and retains cancellation in %s",
    async (engine) => {
      const root = await mkdtemp(join(tmpdir(), "hub-plain-test-"));
      const container =
        engine === "postgres"
          ? await new PostgreSqlContainer("postgres:17-alpine").start()
          : undefined;
      const open = () =>
        container === undefined
          ? embeddedDatabaseRuntime(join(root, "data"))
          : postgresDatabaseRuntime(container.getConnectionUri());
      let bundle = await open();
      try {
        await bundle.runtime.migrate();
        await bundle.runtime.query(
          `insert into organization (id, name, slug) values ('plain-test-org', 'Plain test', 'plain-test-org');`,
        );
        await bundle.runtime.query(
          `insert into projects (id, organization_id, name, slug) values ('10000000-0000-4000-8000-000000000123', 'plain-test-org', 'Plain', 'plain');`,
        );
        let database = createDatabase(bundle.runtime, bundle.locks);
        const binding = {
          organizationId: "plain-test-org",
          projectId: "10000000-0000-4000-8000-000000000123",
          workspaceId: "ws_example",
          agentId: "mu_example",
        };
        const revision = await database.insertProjectConfigurationRevision({
          projectId: binding.projectId,
          sourceKind: "manual",
          sourceEvidence: { kind: "test" },
          normalizedConfiguration: { environments: [], triggers: [] },
          contentHash: "plain-test",
        });
        await database.activateProjectConfigurationRevision(binding.projectId, revision.id);
        const event = normalizePlainEvent(discussionEvent(), binding.workspaceId, binding.agentId)!;
        const input = {
          ...binding,
          source: event.source,
          payload: event,
          deliveryId: event.deliveryId,
          resourceId: event.conversationKey,
          receivedAt: new Date(),
        };
        await Promise.all(Array.from({ length: 5 }, () => database.persistPlainEvent(input)));
        assert.equal((await database.pendingPlainEvents(binding, new Date())).length, 1);
        assert.equal(
          (await database.pendingPlainEvents({ ...binding, workspaceId: "other" }, new Date()))
            .length,
          0,
        );
        assert.equal(
          (await database.pendingPlainEvents({ ...binding, organizationId: "other" }, new Date()))
            .length,
          0,
        );
        await database.persistPlainEvent({
          ...input,
          source: "plain.stop",
          deliveryId: "plain-stop",
          payload: { ...event, source: "plain.stop", timestamp: "2026-10-22T10:01:00Z" },
        });
        await bundle.runtime.close();
        bundle = await open();
        database = createDatabase(bundle.runtime, bundle.locks);
        const recovered = await database.pendingPlainEvents(binding, new Date());
        assert.equal(recovered.length, 2);
        assert.equal(recovered[0]?.source, "plain.stop");
        const message = recovered[1]!;
        assert.equal(message.plainAttempts, 0);
        const retryAt = new Date(Date.now() + 60_000);
        await database.deferPlainEvent(message.providerEventReceiptId, { attempts: 1, retryAt });
        assert.deepEqual(
          (await database.pendingPlainEvents(binding, new Date())).map((item) => item.source),
          ["plain.stop"],
        );
        const due = await database.pendingPlainEvents(binding, retryAt);
        assert.equal(due.length, 2);
        assert.equal(due[1]?.plainAttempts, 1);
        const turn = {
          ...binding,
          conversationKey: event.conversationKey,
          timestamp: event.timestamp,
        };
        assert.equal(await database.isPlainTurnStopped(turn), true);
        assert.equal(
          await database.isPlainTurnStopped({ ...turn, timestamp: "2026-10-22T10:02:00Z" }),
          false,
        );
        assert.equal(
          await database.isPlainTurnStopped({
            ...turn,
            projectId: "20000000-0000-4000-8000-000000000123",
          }),
          false,
        );
        for (const item of recovered)
          await database.markPlainEventProcessed(item.providerEventReceiptId);
        await database.persistPlainEvent(input);
        assert.equal((await database.pendingPlainEvents(binding, retryAt)).length, 0);
        assert.equal(await database.isPlainTurnStopped(turn), true);
      } finally {
        await bundle.runtime.close();
        await container?.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
