# Integrations

## Connected and working

- **Airtable** — base `appesKJpU9JHpd2y2`, full read/write. Source of truth for buyers, listings, agents, CRM log.
- **Google Calendar** — read/write. Showings calendar: "Real Estate" (`ehjgv5aqlbh60bbp4g502gkid4@group.calendar.google.com`).
- **Gmail** — drafts only by policy; the user reviews and sends.

## Realm — REQUIRED, not yet connected

**Confirmed platform:** Realm by PropTx — member sign-in at https://app.realmmlp.ca/signin (TRREB/PropTx MLS system). Realm has no public booking API, so the integration path is browser automation against the member portal (or its showing-request flow, e.g. BrokerBay if the brokerage routes through it).

Blockers, in order:

1. **Network policy** — as of 2026-06-12 this remote environment blocks all outbound web traffic (403 from the proxy for app.realmmlp.ca and even google.com). The user must change the environment's network policy in Claude Code on the web settings to allow `app.realmmlp.ca` (plus any auth/asset domains it redirects to) before any automation is possible. Docs: https://code.claude.com/docs/en/claude-code-on-the-web
2. **Credentials** — Realm member username/password supplied as environment variables (e.g. `REALM_USERNAME`, `REALM_PASSWORD`) in the environment settings. Never commit credentials to the repo or paste them into chat history.
3. **MFA/2FA** — if Realm prompts for a code at login, fully unattended booking isn't possible; the user will need to approve logins or provide a session workaround.
4. **Booking form mapping** — a screenshot or field list of Realm's showing-request form, so agent data (address/MLS#, date, exact time, client) maps onto it correctly.

Once 1–2 are in place, build a small Playwright script (`scripts/realm_book.py` or similar) that signs in, finds the listing, and submits the showing request, then wire it into step 1 of the `book-showing` skill.

### Interim behavior

Until one of the above exists, the `book-showing` skill outputs a paste-ready booking block and never claims a Realm booking was made. Everything else (lookup, conflict check, calendar, CRM, email draft) runs for real.

## Also available (not used yet)

Boosend, Canva, Figma, Gamma, Google Drive, Stripe, Vercel, Zoom, GoDaddy MCP servers are connected to this environment and can be pulled in later (e.g. listing flyers via Canva, payment links via Stripe).
