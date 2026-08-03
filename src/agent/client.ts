import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

export interface MinimalAnthropicClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

let clientOverride: MinimalAnthropicClient | undefined;

/** Test/dev hook: replace the Anthropic client (used by vitest, audit, MOCK_ANTHROPIC). */
export function setAnthropicClient(client: MinimalAnthropicClient | undefined): void {
  clientOverride = client;
}

export function getClient(): MinimalAnthropicClient {
  if (clientOverride) return clientOverride;
  if (config().MOCK_ANTHROPIC) return mockClient();
  return new Anthropic({ apiKey: config().ANTHROPIC_API_KEY });
}

/** One-shot text completion for batch agents (distiller, briefing). */
export async function completeText(system: string, user: string, maxTokens = 2048): Promise<string> {
  const res = await getClient().messages.create({
    model: config().ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  if (res.stop_reason === "refusal") throw new Error("Model refused the request");
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
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
        } as unknown as Anthropic.Message;
      },
    },
  };
}
