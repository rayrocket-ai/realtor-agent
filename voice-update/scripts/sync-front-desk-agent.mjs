import fs from "node:fs/promises";

const apiKey = process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID;
if (!apiKey || !agentId) {
  throw new Error("ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are required");
}

const source = await fs.readFile(new URL("../src/voice/front-desk.ts", import.meta.url), "utf8");

function readExport(name) {
  const match = source.match(new RegExp(`export const ${name} = ([\`"])([\\s\\S]*?)\\1;`));
  if (!match) throw new Error(`Unable to read ${name} from front-desk.ts`);
  return match[2];
}

const firstMessage = readExport("FRONT_DESK_FIRST_MESSAGE");
const prompt = readExport("FRONT_DESK_SYSTEM_PROMPT");

async function request(path, init = {}) {
  const response = await fetch(`https://api.elevenlabs.io${path}`, {
    ...init,
    headers: {
      "xi-api-key": apiKey,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`ElevenLabs HTTP ${response.status}: ${body.slice(0, 1000)}`);
  }
  return body ? JSON.parse(body) : {};
}

await request(`/v1/convai/agents/${encodeURIComponent(agentId)}`, {
  method: "PATCH",
  body: JSON.stringify({
    name: "Ray Ahmadi AI Front Desk",
    tags: ["real-estate", "inbound", "front-desk", "english", "dari"],
    version_description: "Runtime-only production prompt with verified contact details and safe tool fallbacks",
    conversation_config: {
      conversation: {
        text_only: false,
      },
      agent: {
        first_message: firstMessage,
        prompt: {
          prompt,
          timezone: "America/Toronto",
        },
      },
    },
  }),
});

const configured = await request(`/v1/convai/agents/${encodeURIComponent(agentId)}`);
console.log(JSON.stringify({
  updated: true,
  agentId,
  name: configured.name,
  firstMessage: configured.conversation_config?.agent?.first_message,
  promptCharacters: configured.conversation_config?.agent?.prompt?.prompt?.length ?? 0,
  phoneNumbersAssigned: configured.phone_numbers?.length ?? 0,
}, null, 2));
