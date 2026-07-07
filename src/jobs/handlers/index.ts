import { agentTurnHandler } from "./agent-turn.js";
import { showingReminderHandler } from "./showing-reminder.js";
import { followupHandler } from "./followup.js";
import { notifyRealtorHandler } from "./notify-realtor.js";
import { mlsBookingHandler } from "./mls-booking.js";
import { tourPlanHandler } from "./tour-plan.js";

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

export const handlers: Record<string, JobHandler> = {
  "agent-turn": agentTurnHandler,
  "showing-reminder": showingReminderHandler,
  followup: followupHandler,
  "notify-realtor": notifyRealtorHandler,
  "mls-booking": mlsBookingHandler,
  "tour-plan": tourPlanHandler,
};
