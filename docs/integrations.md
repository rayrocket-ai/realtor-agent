# Integrations

## Connected and working

- **Airtable** — base `appesKJpU9JHpd2y2`, full read/write. Source of truth for buyers, listings, agents, CRM log.
- **Google Calendar** — read/write. Showings calendar: "Real Estate" (`ehjgv5aqlbh60bbp4g502gkid4@group.calendar.google.com`).
- **Gmail** — drafts only by policy; the user reviews and sends.

## Realm — REQUIRED, not yet connected

The booking agent must place the actual showing in Realm. No Realm API/tool is available in this environment yet. To wire it up we need, from the user:

1. **Which Realm** — confirm the exact product (e.g. the Realm showing/booking platform used by their board/brokerage) and the URL they log into.
2. **How bookings are placed today** — web portal, mobile app, or email to the listing brokerage. A short description (or screenshots) of the booking form fields is enough to map our data onto it.
3. **Programmatic access**, one of:
   - Realm API key / credentials (if Realm exposes an API or an MCP connector),
   - or approval to drive it via browser automation with the user's login,
   - or fallback: the agent prepares the booking block and the user pastes it into Realm (current behavior).

### Interim behavior

Until one of the above exists, the `book-showing` skill outputs a paste-ready booking block and never claims a Realm booking was made. Everything else (lookup, conflict check, calendar, CRM, email draft) runs for real.

## Also available (not used yet)

Boosend, Canva, Figma, Gamma, Google Drive, Stripe, Vercel, Zoom, GoDaddy MCP servers are connected to this environment and can be pulled in later (e.g. listing flyers via Canva, payment links via Stripe).
