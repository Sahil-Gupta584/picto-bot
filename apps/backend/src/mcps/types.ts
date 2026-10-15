import type { z } from "zod";
import type { Workspaces } from "../workspace/index.js";

/** Everything a tool handler is allowed to touch. */
export interface ToolContext {
  workspaces: Workspaces;
}

/**
 * One capability, declared once.
 *
 * The same record registers the tool on its MCP server and describes it to the
 * model, so the two can never disagree about what a tool accepts. A tool that
 * exists on one side and not the other is either an unreachable capability or a
 * hallucinated one, and both are bugs this shape makes impossible.
 */
export interface ToolDefinition {
  /** The MCP server that owns this tool. ArmorIQ scopes policy and signed plans by this name. */
  mcp: string;
  name: string;
  title: string;
  description: string;
  /** Zod shape for the MCP server. */
  shape: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}
