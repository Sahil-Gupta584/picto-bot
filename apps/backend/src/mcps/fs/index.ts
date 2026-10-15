import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../register.js";
import type { ToolContext } from "../types.js";
import { FS_MCP_NAME, fsTools } from "./tools/index.js";

/**
 * picto-fs - read and write files inside the workspace the agent was given.
 *
 * Registered with ArmorIQ as its own MCP server, so policy can be scoped to
 * filesystem access alone.
 */
export function createFsServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: FS_MCP_NAME, version: "0.1.0" },
    {
      instructions:
        "Filesystem tools for the repository you were given. All paths are relative to " +
        "the repository root and cannot escape it.",
    },
  );
  registerTools(server, fsTools, ctx);
  return server;
}
