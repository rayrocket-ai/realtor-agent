import fs from "node:fs/promises";

const apiKey = process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID;
if (!apiKey || !agentId) {
  throw new Error("ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are required");
}

const documentName = "Ali — Ray Social & Toronto Real Estate — 2026-07-31 v3";
const text = await fs.readFile(
  new URL("../knowledge/ali-ray-social-toronto-real-estate.md", import.meta.url),
  "utf8",
);

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

const list = await request("/v1/convai/knowledge-base?page_size=100");
const documents = list.documents ?? list.items ?? [];
let document = documents.find((item) => item.name === documentName);

if (!document) {
  document = await request("/v1/convai/knowledge-base/text", {
    method: "POST",
    body: JSON.stringify({ name: documentName, text }),
  });
}

const documentId = document.id ?? document.document_id;
if (!documentId) throw new Error("Knowledge-base document was created but no ID was returned");

const agent = await request(`/v1/convai/agents/${encodeURIComponent(agentId)}`);
const current = agent.conversation_config?.agent?.prompt?.knowledge_base ?? [];
const withoutOlderCopies = current.filter(
  (item) => item.name !== documentName && !String(item.name ?? "").startsWith("Ali — Ray Social & Toronto Real Estate —"),
);
const knowledgeBase = [
  ...withoutOlderCopies,
  { type: "text", name: documentName, id: documentId, usage_mode: "auto" },
];

await request(`/v1/convai/agents/${encodeURIComponent(agentId)}`, {
  method: "PATCH",
  body: JSON.stringify({
    version_description: "Added verified social profiles and grounded Toronto/Ontario real-estate knowledge",
    conversation_config: {
      conversation: {
        text_only: false,
      },
      agent: {
        prompt: {
          knowledge_base: knowledgeBase,
        },
      },
    },
  }),
});

const configured = await request(`/v1/convai/agents/${encodeURIComponent(agentId)}`);
const attached = configured.conversation_config?.agent?.prompt?.knowledge_base ?? [];
console.log(JSON.stringify({
  updated: true,
  agentId,
  documentId,
  documentName,
  attached: attached.some((item) => item.id === documentId),
  totalKnowledgeBaseDocuments: attached.length,
  toolIdsPreserved: configured.conversation_config?.agent?.prompt?.tool_ids?.length ?? 0,
}, null, 2));
