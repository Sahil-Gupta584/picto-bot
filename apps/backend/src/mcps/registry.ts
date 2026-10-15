/**
 * The complete tool surface, derived from the tool definitions themselves.
 *
 * Both MCP servers register from here and the model is described from here, so
 * the agent can only ever call something that genuinely exists.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { fsTools } from "./fs/tools/index.js";
import { repoTools } from "./repo/tools/index.js";
import type { ToolDefinition } from "./types.js";

export const ALL_TOOLS: ToolDefinition[] = [...fsTools, ...repoTools];

/**
 * Arguments the model must not supply.
 *
 * Which workspace a run is working in is decided by us when the run starts. If
 * the model could name it, it could name someone else's - so it is stripped from
 * the schema the model sees and re-attached before the call is invoked.
 */
const HIDDEN_ARGS = new Set(["workspace"]);

export function toolByName(name: string): ToolDefinition | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}

/** The tools of one MCP server. */
export function toolsOfMcp(mcp: string): ToolDefinition[] {
  return ALL_TOOLS.filter((tool) => tool.mcp === mcp);
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * OpenAI-shaped tool specs. Google's OpenAI-compatible endpoint accepts this
 * shape directly, so one adapter covers every provider we might switch to.
 */
export function chatTools(): ChatTool[] {
  return ALL_TOOLS.map((def) => {
    const json = zodToJsonSchema(z.object(def.shape), {
      target: "jsonSchema7",
      $refStrategy: "none",
    }) as { $schema?: string; properties?: Record<string, unknown>; required?: string[] };

    const properties = { ...(json.properties ?? {}) };
    for (const hidden of HIDDEN_ARGS) delete properties[hidden];

    const required = (json.required ?? []).filter((name) => !HIDDEN_ARGS.has(name));

    return {
      type: "function" as const,
      function: {
        name: def.name,
        description: def.description,
        parameters: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      },
    };
  });
}

/** Re-attach the arguments the model is not allowed to choose. */
export function bindRunArgs(
  args: Record<string, unknown>,
  workspace: string,
): Record<string, unknown> {
  return { ...args, workspace };
}

/** One line per tool, for prompts and logs. */
export function toolSummary(): string {
  return ALL_TOOLS.map((tool) => `- ${tool.name} [${tool.mcp}] - ${tool.title}`).join("\n");
}
