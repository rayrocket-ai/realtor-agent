import { google, type gmail_v1, type calendar_v3 } from "googleapis";
import { config } from "../config.js";

let oauth2: InstanceType<typeof google.auth.OAuth2> | undefined;

export function googleAuth() {
  if (!oauth2) {
    const c = config();
    oauth2 = new google.auth.OAuth2(c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET);
    oauth2.setCredentials({ refresh_token: c.GOOGLE_REFRESH_TOKEN });
  }
  return oauth2;
}

export function gmailClient(): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth: googleAuth() });
}

export function calendarClient(): calendar_v3.Calendar {
  return google.calendar({ version: "v3", auth: googleAuth() });
}
