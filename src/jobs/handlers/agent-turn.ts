import { runAgentTurn } from "../../agent/loop.js";
import type { JobHandler } from "./index.js";

export const agentTurnHandler: JobHandler = async (payload) => {
  const leadId = String(payload.leadId ?? "");
  if (!leadId) throw new Error("agent-turn job missing leadId");
  const result = await runAgentTurn(leadId, String(payload.reason ?? "inbound"));
  if (!result.replied && result.reason) {
    console.log(`[agent] no reply for lead ${leadId}: ${result.reason}`);
  }
};
