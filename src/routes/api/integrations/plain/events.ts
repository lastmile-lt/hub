import { createFileRoute } from "@tanstack/react-router";
import { handleProviderRequest } from "../../../../server/runtime.js";
export const Route = createFileRoute("/api/integrations/plain/events")({
  server: { handlers: { POST: ({ request }) => handleProviderRequest("plain.events", request) } },
});
