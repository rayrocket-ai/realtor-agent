import { agentTurnHandler } from "./agent-turn.js";
import { showingReminderHandler } from "./showing-reminder.js";
import { followupHandler } from "./followup.js";
import { notifyRealtorHandler } from "./notify-realtor.js";
import { feedbackRequestHandler, feedbackFollowupHandler } from "./feedback.js";
import { distillLessonsHandler } from "./distill-lessons.js";
import { morningBriefingHandler } from "./morning-briefing.js";
import { refreshBuyerProfilesHandler, buyerWeeklyUpdateHandler } from "./buyer-profiles.js";
import { leadReactivationHandler } from "./lead-reactivation.js";
import { listingMatcherHandler } from "./listing-matcher.js";

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

export const handlers: Record<string, JobHandler> = {
  "agent-turn": agentTurnHandler,
  "showing-reminder": showingReminderHandler,
  followup: followupHandler,
  "notify-realtor": notifyRealtorHandler,
  "feedback-request": feedbackRequestHandler,
  "feedback-followup": feedbackFollowupHandler,
  "distill-lessons": distillLessonsHandler,
  "morning-briefing": morningBriefingHandler,
  "refresh-buyer-profiles": refreshBuyerProfilesHandler,
  "buyer-weekly-update": buyerWeeklyUpdateHandler,
  "lead-reactivation": leadReactivationHandler,
  "listing-matcher": listingMatcherHandler,
};
