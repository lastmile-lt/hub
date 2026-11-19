ALTER TABLE "provider_event_receipts" DROP CONSTRAINT "provider_event_receipts_provider_check";--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD COLUMN "plain_processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD COLUMN "plain_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD COLUMN "plain_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD CONSTRAINT "provider_event_receipts_provider_check" CHECK ("provider_event_receipts"."provider" in ('github', 'slack', 'discord', 'linear', 'manual', 'schedule', 'plain'));