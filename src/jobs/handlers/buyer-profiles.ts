import { config } from "../../config.js";
import { completeText } from "../../agent/client.js";
import { notifyRealtor } from "../../channels/gmail/send.js";
import { activeBuyerProfiles, refreshAllBuyerProfiles } from "../../buyers/profile.js";
import type { JobHandler } from "./index.js";

/** Daily 6:30am (and on-demand from the dashboard): rebuild buyer profiles that have new activity. */
export const refreshBuyerProfilesHandler: JobHandler = async (payload) => {
  const counts = await refreshAllBuyerProfiles({ force: payload.force === true });
  console.log(
    `[buyers] profiles refreshed: ${counts.updated} updated, ${counts.skipped} unchanged, ${counts.failed} failed`,
  );
};

/** Monday 8:00am: weekly buyer-clients update email for Ray. */
export const buyerWeeklyUpdateHandler: JobHandler = async () => {
  const c = config();
  // Catch anything the 6:30 refresh missed (skip logic makes this cheap).
  await refreshAllBuyerProfiles();
  const buyers = await activeBuyerProfiles();

  if (buyers.length === 0) {
    console.log("[buyers] weekly update: no active buyer profiles, skipping email");
    return;
  }

  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
  const facts = buyers.map(({ profile, lead }) => ({
    name: lead.name ?? lead.email ?? lead.phone ?? "Unnamed lead",
    stage: lead.stage,
    paused: lead.paused,
    summary: profile.summary,
    requirements: profile.requirements,
    homesSeen: profile.propertyReactions,
    nextAction: profile.nextAction,
    followupDue: lead.followupAt && lead.followupAt <= new Date() ? lead.followupAt.toISOString() : null,
    activeThisWeek: (profile.sourceActivityAt ?? profile.generatedAt) >= weekAgo,
  }));

  let body: string;
  try {
    body = await completeText(
      `You write ${c.REALTOR_NAME}'s Monday-morning buyer clients update. He is a Toronto realtor; the JSON
describes every active buyer, their requirements, homes seen with reactions, offers, and suggested next steps.
Write plain text, short and scannable. Structure:
1. "This week" — buyers who need action now (offers in play, follow-ups due, hot buyers), one line each with the reason.
2. "All active buyers" — one short block per buyer: name, what they want (budget/areas/type), homes seen with liked/disliked, and the next step.
3. Close with anything at risk of going stale (no activity, no next showing).
No fluff, no markdown headers — just clear labelled sections.`,
      JSON.stringify(facts, null, 1),
      2500,
    );
  } catch {
    body = facts
      .map(
        (f) =>
          `${f.name} [${f.stage}] — ${f.summary || "no summary yet"}\n  Next: ${f.nextAction ?? "review"}`,
      )
      .join("\n\n");
  }

  body += `\n\nBuyer profiles: ${c.APP_BASE_URL}/admin/buyers`;

  if (c.gmailEnabled) {
    await notifyRealtor(`Weekly buyer update — ${buyers.length} active buyer${buyers.length === 1 ? "" : "s"}`, body);
  } else {
    console.log(`[buyers] weekly update\n${body}`);
  }
};
