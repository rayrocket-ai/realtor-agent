import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client.js";
import { completeText } from "../../agent/client.js";
import { config } from "../../config.js";
import type { JobHandler } from "./index.js";

/**
 * Nightly: turn raw draft-vs-sent diffs into at most a few one-line lessons
 * the agent will follow from now on. This is the self-improvement loop.
 */
export const distillLessonsHandler: JobHandler = async () => {
  const d = db();
  const feedback = await d.query.agentFeedback.findMany({
    where: eq(schema.agentFeedback.distilled, false),
    limit: 30,
  });
  if (!feedback.length) return;

  const existing = await d.query.lessons.findMany({ where: eq(schema.lessons.active, true) });

  const user =
    `Below are cases where the assistant drafted a message and ${config().REALTOR_NAME} edited it before sending. ` +
    `Extract GENERALIZABLE writing/behavior lessons (tone, length, phrasing, what to include/omit) — not case-specific facts.\n\n` +
    feedback
      .map((f, i) => `### Case ${i + 1}\nDRAFT:\n${f.draftText}\n\nSENT (after his edits):\n${f.sentText}`)
      .join("\n\n") +
    `\n\nExisting lessons (do NOT repeat these):\n${existing.map((l) => `- ${l.lesson}`).join("\n") || "(none)"}` +
    `\n\nReply with 0-5 NEW lessons, one per line, each a single imperative sentence. Reply with exactly "NONE" if there is nothing new.`;

  const out = await completeText(
    "You distill an assistant's behavioral lessons from human edits. Be conservative: only clear, repeated patterns.",
    user,
    1000,
  );

  const newLessons = out
    .split("\n")
    .map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
    .filter((l) => l.length > 8 && !/^none$/i.test(l))
    .slice(0, 5);

  for (const lesson of newLessons) {
    await d.insert(schema.lessons).values({ lesson, sourceType: "edit_diff", category: "style" });
  }
  for (const f of feedback) {
    await d
      .update(schema.agentFeedback)
      .set({ distilled: true })
      .where(eq(schema.agentFeedback.id, f.id));
  }
  console.log(`[lessons] distilled ${newLessons.length} new lesson(s) from ${feedback.length} edits`);
};
