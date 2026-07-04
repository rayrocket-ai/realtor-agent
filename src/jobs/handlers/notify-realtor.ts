import { config } from "../../config.js";
import { notifyRealtor } from "../../channels/gmail/send.js";
import type { JobHandler } from "./index.js";

export const notifyRealtorHandler: JobHandler = async (payload) => {
  const subject = String(payload.subject ?? "realtor-agent notification");
  const body = String(payload.body ?? "");
  if (!config().gmailEnabled) {
    console.log(`[notify] (gmail disabled) ${subject}\n${body}`);
    return;
  }
  await notifyRealtor(subject, body);
};
