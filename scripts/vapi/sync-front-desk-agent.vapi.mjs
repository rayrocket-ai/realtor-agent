// Create or update the "Ali" front-desk assistant on Vapi.
// Ported from the ElevenLabs sync script — same prompt source, same agent design.
//
// Usage:
//   VAPI_PRIVATE_KEY=... node sync-front-desk-agent.vapi.mjs            # creates a new assistant
//   VAPI_PRIVATE_KEY=... VAPI_ASSISTANT_ID=... node sync-front-desk-agent.vapi.mjs  # updates existing
//
// Optional env:
//   VAPI_MODEL            (default "gpt-4o")
//   VAPI_VOICE_PROVIDER   (default "openai" — no ElevenLabs dependency)
//   VAPI_VOICE_ID         (default "nova" — warm female receptionist voice)
//   VAPI_TRANSCRIBER_LANG (default "multi" — English/Dari code-switching)
//   VAPI_SERVER_URL       (default https://ray.87.99.139.222.sslip.io/api/voice/vapi)
//   VAPI_KNOWLEDGE_BASE_ID (attach an existing Vapi knowledge base)

import fs from "node:fs/promises";

const apiKey = process.env.VAPI_PRIVATE_KEY;
if (!apiKey) throw new Error("VAPI_PRIVATE_KEY is required (private key from dashboard.vapi.ai)");

const source = await fs.readFile(new URL("../voice-update/front-desk.ts", import.meta.url), "utf8");

function readExport(name) {
  const match = source.match(new RegExp(`export const ${name} = ([\`"])([\\s\\S]*?)\\1;`));
  if (!match) throw new Error(`Unable to read ${name} from front-desk.ts`);
  return match[2];
}

const firstMessage = readExport("FRONT_DESK_FIRST_MESSAGE");
const prompt = readExport("FRONT_DESK_SYSTEM_PROMPT");

const serverUrl =
  process.env.VAPI_SERVER_URL ?? "https://ray.87.99.139.222.sslip.io/api/voice/vapi";

async function request(path, init = {}) {
  const response = await fetch(`https://api.vapi.ai${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Vapi HTTP ${response.status} ${path}: ${body.slice(0, 1500)}`);
  }
  return body ? JSON.parse(body) : {};
}

// Tool the LLM calls near end of call; the Fastify webhook performs the CRM write.
const captureTool = {
  type: "function",
  async: false,
  function: {
    name: "capture_front_desk_lead",
    description:
      "Save the caller's details to Ray's CRM exactly once, near the end of every legitimate non-spam call, after confirming the caller's name and best callback number.",
    parameters: {
      type: "object",
      properties: {
        caller_name: { type: "string", description: "Caller's full name as confirmed on the call" },
        phone: { type: "string", description: "Best callback number confirmed with the caller" },
        email: { type: "string", description: "Email address, only if offered" },
        intent: { type: "string", description: "One-sentence reason for the call" },
        property: { type: "string", description: "Property address or area of interest, if any" },
        timeline: { type: "string", description: "Caller's timeline or deadline, if any" },
        pre_approved: { type: "boolean", description: "Buyer mortgage pre-approval, when relevant" },
        urgency: {
          type: "string",
          enum: ["red", "yellow", "green"],
          description: "red = immediate/high-intent/emergency, yellow = ordinary legitimate follow-up, green = obvious spam",
        },
        call_category: {
          type: "string",
          enum: ["hot_lead", "existing_client", "time_sensitive", "vendor_admin", "personal", "spam", "unknown"],
        },
        notes: { type: "string", description: "Brief factual summary of anything else the caller asked for" },
      },
      required: ["caller_name", "phone", "intent", "urgency", "call_category"],
    },
  },
  messages: [
    { type: "request-start", content: "One moment while I save that." },
    { type: "request-complete", content: "Got it — I've saved those details for Ray." },
    {
      type: "request-failed",
      content: "Sorry, I couldn't save that just now, but I'll still make sure Ray gets your message.",
    },
  ],
};

// Live MLS (TRREB/PropTx) address lookup — answered by the Fastify webhook.
const mlsLookupTool = {
  type: "function",
  async: false,
  function: {
    name: "lookup_listing_by_address",
    description:
      "Look up a specific property by street address in the live MLS (TRREB/PropTx) to answer questions about current status, asking price, beds/baths, and remarks. Only current public facts are returned; never invent details.",
    parameters: {
      type: "object",
      properties: {
        address: { type: "string", description: "Street address, e.g. '123 Yonge Street'" },
        city: { type: "string", description: "City, e.g. 'Toronto' (ask if unsure)" },
      },
      required: ["address"],
    },
  },
  messages: [
    { type: "request-start", content: "Let me pull that up for you." },
    {
      type: "request-failed",
      content: "I couldn't reach the listing system just now — I'll take the address and have Ray follow up.",
    },
  ],
};

const assistant = {
  name: "Ray Ahmadi AI Front Desk",
  firstMessage,
  firstMessageMode: "assistant-speaks-first",
  transcriber: {
    provider: "deepgram",
    model: "nova-3",
    language: process.env.VAPI_TRANSCRIBER_LANG ?? "multi",
  },
  model: {
    provider: process.env.VAPI_MODEL_PROVIDER ?? "anthropic",
    model: process.env.VAPI_MODEL ?? "claude-sonnet-5",
    temperature: 0.3,
    maxTokens: 250,
    messages: [{ role: "system", content: prompt }],
    tools: [captureTool, mlsLookupTool],
    ...(process.env.VAPI_KNOWLEDGE_BASE_ID
      ? { knowledgeBaseId: process.env.VAPI_KNOWLEDGE_BASE_ID }
      : {}),
  },
  voice: {
    provider: process.env.VAPI_VOICE_PROVIDER ?? "openai",
    voiceId: process.env.VAPI_VOICE_ID ?? "nova",
  },
  serverUrl,
  // Post-call analysis feeds the existing triageFrontDeskCall() + notification logic.
  analysisPlan: {
    summaryPlan: { enabled: true },
    structuredDataPlan: {
      enabled: true,
      schema: {
        type: "object",
        properties: {
          caller_name: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          caller_intent: { type: "string" },
          property: { type: "string" },
          timeline: { type: "string" },
          pre_approved: { type: "boolean" },
          urgency: { type: "string", enum: ["red", "yellow", "green"] },
          call_category: {
            type: "string",
            enum: ["hot_lead", "existing_client", "time_sensitive", "vendor_admin", "personal", "spam", "unknown"],
          },
        },
      },
    },
    successEvaluationPlan: { enabled: true, rubric: "NumericScale" },
  },
  endCallPhrases: ["goodbye", "have a great day", "that's all, thanks"],
  maxDurationSeconds: 600,
  backgroundSound: "off",
  voicemailDetection: { provider: "twilio", enabled: false },
};

const assistantId = process.env.VAPI_ASSISTANT_ID;
// Vapi replaces the whole model object on PATCH. Preserve the attached knowledge
// base and toolIds from the live assistant so a prompt sync never wipes them.
if (assistantId) {
  try {
    const existing = await request(`/assistant/${encodeURIComponent(assistantId)}`);
    if (existing.model?.knowledgeBase) assistant.model.knowledgeBase = existing.model.knowledgeBase;
    if (Array.isArray(existing.model?.toolIds) && existing.model.toolIds.length) {
      assistant.model.toolIds = existing.model.toolIds;
    }
  } catch {
    console.error("warning: could not fetch existing assistant; knowledge base not preserved");
  }
}
const saved = assistantId
  ? await request(`/assistant/${encodeURIComponent(assistantId)}`, {
      method: "PATCH",
      body: JSON.stringify(assistant),
    })
  : await request("/assistant", { method: "POST", body: JSON.stringify(assistant) });

console.log(
  JSON.stringify(
    {
      updated: Boolean(assistantId),
      assistantId: saved.id,
      name: saved.name,
      firstMessage: saved.firstMessage,
      promptCharacters: saved.model?.messages?.[0]?.content?.length ?? 0,
      serverUrl: saved.serverUrl,
      tools: saved.model?.tools?.map((t) => t.function?.name) ?? [],
    },
    null,
    2,
  ),
);
