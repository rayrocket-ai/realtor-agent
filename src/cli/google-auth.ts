/**
 * One-time Google OAuth consent flow. Prints an auth URL, you approve in a
 * browser, paste the code back, and it prints the refresh token to put in
 * .env as GOOGLE_REFRESH_TOKEN.
 *
 * Usage: GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run auth:google
 * (or with a filled-in .env via docker compose run --rm app npm run auth:google)
 */
import readline from "node:readline/promises";
import { google } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error(
      "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (create an OAuth 'Desktop app' client in Google Cloud Console,\nwith the Gmail API and Google Calendar API enabled).",
    );
    process.exit(1);
  }

  // Out-of-band flow for headless servers: Google shows the code on screen.
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, "urn:ietf:wg:oauth:2.0:oob");
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  console.log("\n1. Open this URL in a browser (any device) and sign in with the Gmail account the agent should use:\n");
  console.log(url);
  console.log("\n2. Approve access, copy the code Google shows you, and paste it below.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question("Paste the authorization code: ")).trim();
  rl.close();

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      "\nNo refresh token returned. Remove this app's access at https://myaccount.google.com/permissions and try again.",
    );
    process.exit(1);
  }

  console.log("\n✅ Success! Add this line to your .env:\n");
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
}

main().catch((err) => {
  console.error("Auth flow failed:", err.message ?? err);
  process.exit(1);
});
