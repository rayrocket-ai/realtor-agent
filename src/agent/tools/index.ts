import type Anthropic from "@anthropic-ai/sdk";
import type { Lead } from "../../db/schema.js";
import { calendarTools } from "./calendar.js";
import { leadTools } from "./lead.js";
import { offerTools } from "./offer.js";
import { escalateTools } from "./escalate.js";
import { tourTools } from "./tour.js";
import { feedbackTools } from "./feedback.js";

export interface ToolContext {
  lead: Lead;
}

export interface AgentTool {
  definition: Anthropic.Tool;
  handler: (ctx: ToolContext, input: Record<string, unknown>) => Promise<string>;
}

export function allTools(): AgentTool[] {
  return [...calendarTools, ...leadTools, ...offerTools, ...escalateTools, ...tourTools, ...feedbackTools];
}

export function toolDefinitions(): Anthropic.Tool[] {
  return allTools().map((t) => t.definition);
}

export async function executeTool(
  name: string,
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<{ result: string; isError: boolean }> {
  const tool = allTools().find((t) => t.definition.name === name);
  if (!tool) return { result: `Unknown tool: ${name}`, isError: true };
  try {
    return { result: await tool.handler(ctx, input), isError: false };
  } catch (err) {
    return { result: `Tool error: ${(err as Error).message}`, isError: true };
  }
}
