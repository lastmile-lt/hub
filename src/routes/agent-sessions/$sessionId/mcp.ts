import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../server/runtime.js";

export const Route = createFileRoute("/agent-sessions/$sessionId/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await getApplication()).operations.handleSessionCapabilities(
          request,
          new URL(request.url).pathname.split("/")[2] ?? "",
        ),
      // Stateless and POST-only like the execution capability route: answer
      // the SSE stream open (GET) and session terminate (DELETE) with the 405
      // the MCP Streamable HTTP spec requires instead of falling through to
      // the SPA route render, which crashed to 500 on every session start.
      GET: methodNotAllowed,
      DELETE: methodNotAllowed,
    },
  },
});

function methodNotAllowed(): Response {
  return Response.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
