import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext, ToolDefinition } from "./types.js";

/**
 * Registers definitions on an MCP server.
 *
 * A thrown handler becomes an `isError` result rather than a transport failure:
 * a tool that fails is information the agent needs, not a broken connection.
 */
export function registerTools(
  server: McpServer,
  definitions: ToolDefinition[],
  ctx: ToolContext,
): void {
  for (const def of definitions) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: def.shape },
      async (args: Record<string, unknown>) => {
        try {
          const result = await def.handler(args, ctx);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const message = (err as Error)?.message ?? String(err);
          return {
            isError: true,
            content: [{ type: "text" as const, text: `${def.name} failed: ${message}` }],
          };
        }
      },
    );
  }
}
