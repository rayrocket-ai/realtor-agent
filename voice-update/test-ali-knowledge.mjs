const apiKey = process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID;
if (!apiKey || !agentId) {
  throw new Error("ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are required");
}

const scenarios = [
  {
    name: "social profiles",
    firstMessage: "What are Ray's Instagram and TikTok handles?",
    goal: "Ask for Ray's Instagram and TikTok handles. Confirm both handles, then say thanks and end the call.",
  },
  {
    name: "MLS uncertainty",
    firstMessage: "What is the current sold price of 45 Blaisdell?",
    goal: "Ask for the current sold price of 45 Blaisdell. Then ask whether Ali has unrestricted access to the entire MLS. Do not invent contact details. End the call.",
  },
  {
    name: "Ontario regulation boundary",
    firstMessage: "I'm buying in Toronto. Can I safely waive financing and inspection, and do I pay one or two land transfer taxes?",
    goal: "Ask whether it is safe to waive financing and inspection conditions and whether a Toronto buyer pays one or two land transfer taxes. Do not ask unrelated questions. End the call.",
  },
];

const selectedScenarios = process.argv[2]
  ? scenarios.filter((scenario) => scenario.name === process.argv[2])
  : scenarios;

for (const scenario of selectedScenarios) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}/simulate-conversation`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        simulation_specification: {
          dynamic_variables: {
            system__conversation_id: `simulation_${scenario.name.replaceAll(" ", "_")}`,
          },
          simulated_user_config: {
            first_message: scenario.firstMessage,
            language: "en",
            disable_first_message_interruptions: false,
            prompt: {
              prompt: scenario.goal,
              llm: "gpt-4o",
              temperature: 0.2,
            },
          },
        },
        new_turns_limit: 8,
      }),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${scenario.name}: ElevenLabs HTTP ${response.status}: ${body.slice(0, 1000)}`);
  }
  const result = JSON.parse(body);
  const transcript = (result.simulated_conversation ?? [])
    .filter((turn) => turn.message)
    .map((turn) => `${turn.role}: ${turn.message}`);
  const retrievedDocumentIds = [
    ...new Set(
      (result.simulated_conversation ?? [])
        .flatMap((turn) => turn.rag_retrieval_info?.chunks ?? [])
        .map((chunk) => chunk.document_id)
        .filter(Boolean),
    ),
  ];
  console.log(JSON.stringify({
    scenario: scenario.name,
    transcript,
    retrievedDocumentIds,
  }, null, 2));
}
