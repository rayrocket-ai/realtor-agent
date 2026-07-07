import type Anthropic from "@anthropic-ai/sdk";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { config } from "../config.js";
import { systemPrompt } from "./prompts.js";
import { buildContext, renderLeadBrief } from "./context.js";
import { toolDefinitions, executeTool } from "./tools/index.js";
import { sendToLead } from "../channels/outbound.js";
import { getClient, setAnthropicClient, type MinimalAnthropicClient } from "./client.js";
import { approvalRequired, queueDraft } from "../approvals/messages.js";

const MAX_ITERATIONS = 10;
const MAX_TOKENS = 4096;
const MAX_ACTIVE_LESSONS = 50;

export { setAnthropicClient, type MinimalAnthropicClient };

export interface AgentTurnResult {
  replied: boolean;
  queued?: boolean; // true when the reply went to the approval queue instead of out
  reason?: string;
  output?: string;
}

async function activeLessons(): Promise<string[]> {
  const rows = await db().query.lessons.findMany({
    where: eq(schema.lessons.active, true),
    orderBy: desc(schema.lessons.createdAt),
    limit: MAX_ACTIVE_LESSONS,
  });
  return rows.map((r) => r.lesson);
}

/**
 * Run one agent turn for a lead: build context, run the tool-use loop, then
 * either send the final text or queue it for the realtor's approval
 * (training-wheels mode). Postgres is the only conversation state.
 */
export async function runAgentTurn(leadId: string, trigger = "inbound"): Promise<AgentTurnResult> {
  const c = config();
  const ctx = await buildContext(leadId);
  if (!ctx) return { replied: false, reason: "lead not found" };

  const { lead } = ctx;
  if (lead.paused) return { replied: false, reason: "lead paused (human takeover)" };
  if (lead.pausedUntil && lead.pausedUntil.getTime() > Date.now()) {
    return { replied: false, reason: "lead temporarily paused (realtor active on thread)" };
  }

  const client = getClient();
  const tools = toolDefinitions();
  const lessons = await activeLessons();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: renderLeadBrief(ctx) }];
  const toolCallLog: unknown[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let finalText = "";

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await client.messages.create({
        model: c.ANTHROPIC_MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt(lessons),
        tools,
        messages,
      });
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;

      if (response.stop_reason === "refusal") {
        throw new Error("Model refused the request (stop_reason: refusal)");
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        finalText = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        break;
      }

      messages.push({ role: "assistant", content: response.content });

      // Re-read the lead so tool handlers see updates from earlier iterations.
      const freshLead =
        (await db().query.leads.findFirst({ where: eq(schema.leads.id, leadId) })) ?? lead;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const { result, isError } = await executeTool(
          tu.name,
          { lead: freshLead },
          tu.input as Record<string, unknown>,
        );
        toolCallLog.push({ name: tu.name, input: tu.input, result: result.slice(0, 1000), isError });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: result, is_error: isError });
      }
      messages.push({ role: "user", content: results });
    }

    let queued = false;
    if (finalText) {
      if (await approvalRequired(lead)) {
        const channel = await lastInboundChannel(leadId);
        await queueDraft(lead, channel, finalText);
        queued = true;
      } else {
        await sendToLead(lead, finalText);
      }
    }

    await db().insert(schema.agentRuns).values({
      leadId,
      trigger,
      toolCalls: toolCallLog,
      output: finalText ? (queued ? `[queued for approval] ${finalText}` : finalText) : null,
      model: c.ANTHROPIC_MODEL,
      inputTokens,
      outputTokens,
    });

    return { replied: Boolean(finalText), queued, output: finalText };
  } catch (err) {
    await db()
      .insert(schema.agentRuns)
      .values({
        leadId,
        trigger,
        toolCalls: toolCallLog,
        model: c.ANTHROPIC_MODEL,
        inputTokens,
        outputTokens,
        error: (err as Error).message.slice(0, 4000),
      })
      .catch(() => {});
    throw err;
  }
}

async function lastInboundChannel(leadId: string): Promise<string> {
  const last = await db().query.messages.findFirst({
    where: eq(schema.messages.leadId, leadId),
    orderBy: desc(schema.messages.createdAt),
  });
  return last?.channel ?? "gmail";
}
