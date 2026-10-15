/**
 * Mounts one MCP server on an HTTP path.
 *
 * We run several MCP servers from a single process and a single port, each on
 * its own path. That keeps one tunnel and one deploy while still registering as
 * separate MCP servers with ArmorIQ - which matters, because policy and signed
 * plan steps are scoped per MCP server.
 *
 *   /mcp/fs      picto-fs
 *   /mcp/repo    picto-repo
 *
 * Set PICTO_MCP_TRACE to a file path to record every inbound request. Use it
 * when a caller is rejected before any handler runs and the server log is
 * therefore silent about what they actually sent.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Router, type Request, type Response } from "express";
import { appendFileSync } from "node:fs";

/**
 * Opt-in request trace.
 *
 * Set PICTO_MCP_TRACE to a file path and every request that reaches an MCP
 * endpoint is appended to it. The server log shows what WE decided; it does not
 * show what arrived. When a caller's request is rejected before any handler
 * runs, the only way to learn what it actually sent is to write it down.
 */
const TRACE_PATH = process.env.PICTO_MCP_TRACE;

function trace(entry: Record<string, unknown>): void {
  if (!TRACE_PATH) return;
  try {
    appendFileSync(TRACE_PATH, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`);
  } catch {
    // Tracing is a diagnostic: it must never be able to fail a request.
  }
}

/**
 * Removes ArmorIQ's envelope from a forwarded JSON-RPC message.
 *
 * The proxy does not pass the message through untouched. It appends its own
 * metadata:
 *
 *   { jsonrpc, method, params, id, _iam_context: { allowed_tools, domain, ... } }
 *
 * The MCP SDK validates every inbound message against a STRICT schema, so a
 * single unknown key makes the entire message "not JSON-RPC". The transport
 * rejects it with -32700 Parse error before any tool runs, and the SDK upstream
 * flattens that into "MCP invocation failed: [object Object]" - so the agent
 * sees a tool that simply does not work, with no way to tell why.
 *
 * The envelope is ArmorIQ's record of the decision it already made, not part of
 * the protocol, so it is lifted out here and reported to the caller instead.
 */
function stripEnvelope(body: unknown): {
  message: unknown;
  envelope: Record<string, unknown> | null;
} {
  if (Array.isArray(body)) {
    const envelopes: Record<string, unknown>[] = [];
    const message = body.map((item) => {
      const stripped = stripEnvelope(item);
      if (stripped.envelope) envelopes.push(stripped.envelope);
      return stripped.message;
    });
    return { message, envelope: envelopes.length ? { batch: envelopes } : null };
  }

  if (!body || typeof body !== "object") return { message: body, envelope: null };

  const { _iam_context, ...rest } = body as Record<string, unknown>;
  return {
    message: rest,
    envelope: (_iam_context as Record<string, unknown> | undefined) ?? null,
  };
}

/** A JSON-RPC error response, shaped like the MCP transport's own. */
function jsonRpcError(status: number, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

export function mountMcp(build: () => McpServer): Router {
  const router = Router();

  /**
   * Stateless by design.
   *
   * ArmorIQ's proxy obtains a session id once and then reuses it forever. It has
   * no path for "your session is gone, let's start again": a 404 is relayed to
   * the caller as a failure and the next call arrives with the same dead id. So
   * the moment this process restarts - any deploy, any `npm run dev` reload -
   * every tool call would fail "Server not initialized" until the MCP was
   * re-registered by hand.
   *
   * With `sessionIdGenerator: undefined` the transport keeps no session at all
   * and never validates one, which is precisely the contract that survives a
   * caller holding a stale id. The cost is a fresh server and transport per
   * request, and that is cheap: these tools are stateless functions over a
   * workspace directory.
   *
   * `enableJsonResponse` returns the result as JSON rather than an SSE stream.
   * Both are valid MCP; JSON is used because it makes a failed call readable in
   * a log or a proxy trace instead of a chunked event stream.
   */
  const handle = async (req: Request, res: Response): Promise<void> => {
    const { message, envelope } = stripEnvelope(req.body);

    trace({
      method: req.method,
      path: req.originalUrl,
      contentType: req.header("content-type"),
      accept: req.header("accept"),
      protocolVersion: req.header("mcp-protocol-version"),
      session: req.header("mcp-session-id") ?? null,
      userAgent: req.header("user-agent"),
      envelope,
      body: JSON.stringify(message)?.slice(0, 600),
    });

    if (req.method !== "POST") {
      // GET would open a server-to-client stream and DELETE would end a session.
      // There is no session to end and nothing to push, so say so plainly.
      res
        .status(405)
        .json(jsonRpcError(405, -32000, "Method Not Allowed: this server is stateless"));
      return;
    }

    try {
      const server = build();
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", (): void => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, message);
    } catch (err) {
      console.error("[mcp] request failed:", err);
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(500, -32603, String(err)));
      }
    }
  };

  router.post("/", handle);
  router.get("/", handle);
  router.delete("/", handle);
  return router;
}
