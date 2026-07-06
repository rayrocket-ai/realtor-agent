import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { config } from "../config.js";
import { systemPrompt } from "./prompts.js";
import { buildContext, renderLeadBrief } from "./context.js";
import { toolDefinitions, executeTool } from "./tools/index.js";
import { sendToLead } from "../channels/outbound.js";

const MAX_ITERATIONS = 10;
const MAX_TOKENS = 4096;

export interface MinimalAnthropicClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

let clientOverride: MinimalAnthropicClient | undefined;

/** Test/dev hook: replace the Anthropic client (used by vitest and MOCK_ANTHROPIC). */
export function setAnthropicClient(client: MinimalAnthropicClient | undefined): void {
  clientOverride = client;
}

function getClient(): MinimalAnthropicClient {
  if (clientOverride) return clientOverride;
  if (config().MOCK_ANTHROPIC) return mockClient();
  return new Anthropic({ apiKey: config().ANTHROPIC_API_KEY });
}

export interface AgentTurnResult {
  replied: boolean;
  reason?: string;
  output?: string;
}

/**
 * Run one agent turn for a lead: build context, run the tool-use loop, send
 * the final text on the lead's channel. The Postgres timeline is the only
 * conversation state — restarts are free.
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
        system: systemPrompt(),
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

    if (finalText) {
      await sendToLead(lead, finalText);
    }

    await db().insert(schema.agentRuns).values({
      leadId,
      trigger,
      toolCalls: toolCallLog,
      output: finalText || null,
      model: c.ANTHROPIC_MODEL,
      inputTokens,
      outputTokens,
    });

    return { replied: Boolean(finalText), output: finalText };
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

/** Canned-response client for local dev without an API key (MOCK_ANTHROPIC=1). */
function mockClient(): MinimalAnthropicClient {
  return {
    messages: {
      async create(params) {
        const text =
          `Hi! I'm ${config().REALTOR_NAME}'s AI assistant at ${config().REALTOR_BROKERAGE} ` +
          `(mock mode — set ANTHROPIC_API_KEY for real replies). How can I help with your home search?`;
        return {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model: params.model,
          content: [{ type: "text", text, citations: null }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cache_creation: null,
            server_tool_use: null,
            service_tier: null,
          },
        } as Anthropic.Message;
      },
    },
  };
}
