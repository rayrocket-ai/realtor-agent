// Upload the Ali knowledge-base markdown to Vapi and attach it via a Query Tool.
// (Vapi's current approach: files -> query tool with google-provider knowledge base -> assistant toolIds)
//
// Usage:
//   VAPI_PRIVATE_KEY=... VAPI_ASSISTANT_ID=... node sync-ali-knowledge-base.vapi.mjs

import fs from "node:fs/promises";

const apiKey = process.env.VAPI_PRIVATE_KEY;
const assistantId = process.env.VAPI_ASSISTANT_ID;
if (!apiKey || !assistantId) throw new Error("VAPI_PRIVATE_KEY and VAPI_ASSISTANT_ID are required");

const filePath = new URL("./ali-knowledge.txt", import.meta.url);
const cleanName = "ali-knowledge-v3.txt";

async function request(path, init = {}) {
  const response = await fetch(`https://api.vapi.ai${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, ...init.headers },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Vapi HTTP ${response.status} ${path}: ${body.slice(0, 1500)}`);
  return body ? JSON.parse(body) : {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Upload the markdown with an ASCII filename.
const fileBuffer = await fs.readFile(filePath);
const form = new FormData();
form.append("file", new Blob([fileBuffer], { type: "text/plain" }), cleanName);
const uploaded = await request("/file", { method: "POST", body: form });
const fileId = uploaded.id;
if (!fileId) throw new Error("File uploaded but no ID returned");

// 2. Wait for Vapi to finish parsing it.
let file = uploaded;
for (let i = 0; i < 20 && file.status !== "done"; i++) {
  if (file.status === "failed") throw new Error(`File parsing failed: ${JSON.stringify(file).slice(0, 500)}`);
  await sleep(3000);
  file = await request(`/file/${fileId}`);
}

// 3. Create a query tool backed by the file.
const tool = await request("/tool", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: "query",
    function: {
      name: "lookup_knowledge",
      description:
        "Look up verified facts about Ray Ahmadi's business, social profiles, and general Toronto/GTA and Ontario real-estate topics. Use for any factual question before answering.",
    },
    knowledgeBases: [
      {
        provider: "google",
        name: "Ali Toronto Real Estate Knowledge",
        description: "Verified Ray Ahmadi business facts and Toronto/Ontario real-estate knowledge",
        fileIds: [fileId],
      },
    ],
  }),
});
const toolId = tool.id;
if (!toolId) throw new Error("Query tool created but no ID returned");

// 4. Attach the tool to the assistant (keep existing inline capture tool).
const assistant = await request(`/assistant/${encodeURIComponent(assistantId)}`);
const toolIds = [...new Set([...(assistant.model?.toolIds ?? []), toolId])];
const patched = await request(`/assistant/${encodeURIComponent(assistantId)}`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: {
      provider: assistant.model?.provider ?? "openai",
      model: assistant.model?.model ?? "gpt-4o",
      ...(assistant.model?.provider === "custom-llm" ? { url: assistant.model.url } : {}),
      // Vapi replaces the whole model object on PATCH — resend everything.
      temperature: assistant.model?.temperature,
      maxTokens: assistant.model?.maxTokens,
      messages: assistant.model?.messages,
      tools: assistant.model?.tools,
      toolIds,
    },
  }),
});

console.log(
  JSON.stringify(
    {
      updated: true,
      assistantId,
      fileId,
      fileStatus: file.status,
      queryToolId: toolId,
      attachedToolIds: patched.model?.toolIds ?? [],
    },
    null,
    2,
  ),
);
