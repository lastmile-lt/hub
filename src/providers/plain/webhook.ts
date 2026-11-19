import { createHmac, timingSafeEqual } from "node:crypto";
import type { Database, PendingPlainEvent, PlainEventBinding } from "../../db/types.js";
import { readBoundedRequestBody } from "../../http/request-body.js";
import { logger } from "../../logger.js";
import type { TriggerHandler, TriggerSource } from "../../triggers/index.js";
import { normalizePlainEvent } from "./events.js";

/** Failed dispatches back off from 5 s to 5 min and are dropped after about 20 minutes. */
export const PLAIN_MAX_DISPATCH_ATTEMPTS = 10;
export function plainRetryDelay(attempts: number): number {
  return Math.min(5_000 * 2 ** (attempts - 1), 300_000);
}

export function createPlainWebhookSource(options: {
  database: Database;
  binding: PlainEventBinding;
  signingSecret: string;
  now?: () => number;
}): TriggerSource & { handle(request: Request): Promise<Response>; drain(): Promise<void> } {
  let handler: TriggerHandler | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draining: Promise<void> | undefined;
  const retryLater = async (event: PendingPlainEvent, now: number): Promise<void> => {
    const attempts = event.plainAttempts + 1;
    const log = {
      provider: "plain",
      operation: "plain.inbox.event",
      providerEventReceiptId: event.providerEventReceiptId,
      attempts,
    };
    if (attempts >= PLAIN_MAX_DISPATCH_ATTEMPTS) {
      // Give up so that a permanently failing event cannot be retried forever or crowd
      // newer events out of the inbox.
      await options.database.markPlainEventProcessed(event.providerEventReceiptId);
      logger.error(log, "Plain event dropped after repeated dispatch failures");
      return;
    }
    await options.database.deferPlainEvent(event.providerEventReceiptId, {
      attempts,
      retryAt: new Date(now + plainRetryDelay(attempts)),
    });
    logger.warn(log, "Plain event retained for retry");
  };
  const drain = (): Promise<void> => {
    if (handler === undefined) return Promise.resolve();
    draining ??= (async () => {
      const now = options.now?.() ?? Date.now();
      const events = await options.database.pendingPlainEvents(options.binding, new Date(now));
      for (const event of events) {
        if (handler === undefined) break;
        try {
          await handler(event);
          await options.database.markPlainEventProcessed(event.providerEventReceiptId);
        } catch {
          // Do not log the error, which may contain upstream customer data.
          await retryLater(event, now);
        }
      }
    })().finally(() => {
      draining = undefined;
    });
    return draining;
  };
  const tick = async () => {
    try {
      await drain();
    } catch {
      logger.warn(
        { provider: "plain", operation: "plain.inbox.dispatch" },
        "Plain inbox dispatch will retry",
      );
    } finally {
      if (handler !== undefined) {
        timer = setTimeout(() => {
          void tick();
        }, 1000);
        timer.unref();
      }
    }
  };
  return {
    async start(next) {
      handler = next;
      timer = setTimeout(() => {
        void tick();
      }, 0);
      timer.unref();
    },
    async stop() {
      handler = undefined;
      clearTimeout(timer);
      await draining;
    },
    drain,
    async handle(request) {
      const signature = request.headers.get("plain-request-signature");
      if (signature === null || !/^[a-f0-9]{64}$/iu.test(signature))
        return new Response("Unauthorized", { status: 401 });
      const body = await readBoundedRequestBody(request, 1_048_576);
      if (body instanceof Response) return body;
      const expected = createHmac("sha256", options.signingSecret).update(body).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
        return new Response("Unauthorized", { status: 401 });
      let event;
      try {
        event = normalizePlainEvent(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
          options.binding.workspaceId,
          options.binding.agentId,
        );
      } catch {
        return Response.json({ error: "invalid_plain_event" }, { status: 400 });
      }
      if (event === undefined) return new Response("OK");
      const now = options.now?.() ?? Date.now();
      if (Date.parse(event.timestamp) > now + 300_000)
        return Response.json({ error: "future_plain_event" }, { status: 400 });
      // A durable inbox is committed before acknowledgement. The worker (including after a
      // restart) performs matching, execution and external API calls independently of HTTP.
      try {
        await options.database.persistPlainEvent({
          organizationId: options.binding.organizationId,
          projectId: options.binding.projectId,
          source: event.source,
          payload: event,
          deliveryId: event.deliveryId,
          resourceId: event.conversationKey,
          receivedAt: new Date(now),
        });
      } catch {
        return Response.json({ error: "plain_inbox_unavailable" }, { status: 503 });
      }
      return new Response("OK");
    },
  };
}
