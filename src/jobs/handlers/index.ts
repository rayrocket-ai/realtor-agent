import { agentTurnHandler } from "./agent-turn.js";
import { showingReminderHandler } from "./showing-reminder.js";
import { followupHandler } from "./followup.js";
import { notifyRealtorHandler } from "./notify-realtor.js";

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

export const handlers: Record<string, JobHandler> = {
  "agent-turn": agentTurnHandler,
  "showing-reminder": showingReminderHandler,
  followup: followupHandler,
  "notify-realtor": notifyRealtorHandler,
};
