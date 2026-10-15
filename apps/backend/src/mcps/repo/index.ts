import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../register.js";
import type { ToolContext } from "../types.js";
import { REPO_MCP_NAME, repoTools } from "./tools/index.js";

/**
 * picto-repo - run commands against the workspace and publish the result.
 *
 * `push_branch` and `push_main` are separate tools on purpose: ArmorIQ matches
 * tool names, not arguments, so publishing to a branch and publishing to the
 * default branch have to be distinguishable to policy. They are.
 */
export function createRepoServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: REPO_MCP_NAME, version: "0.1.0" },
    {
      instructions:
        "Run commands in the workspace and publish the result. Prefer push_branch and a " +
        "pull request; push_main publishes to the default branch immediately.",
    },
  );
  registerTools(server, repoTools, ctx);
  return server;
}
