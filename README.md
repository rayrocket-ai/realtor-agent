# realtor-agent

AI real estate agent system: book showings and submit offers.

## Agents

| Agent | Skill | Status |
|---|---|---|
| Booking agent | `/book-showing` | Working — Realm/BrokerBay booking automated end-to-end (see `docs/integrations.md`) |
| Offer agent | `/submit-offer` | Stub — built after booking agent is approved |

## Usage

In a Claude Code session on this repo, just ask naturally — both entry points work:

- `book a showing for Sarah Chen` (client-name mode: agent looks up the client, their interested listings, and proposes times)
- `book 123 Main St this Saturday at 2pm` (address + time mode: agent books directly)

The agent looks up clients/listings in Airtable, checks the "Real Estate" Google Calendar for conflicts, confirms the exact slot with you, then places the showing in Realm/BrokerBay via `scripts/realm/book.mjs` (dry-run first, then `--confirm`), creates the calendar event, logs the showing in the CRM table, and drafts the client confirmation email. If a listing isn't bookable online, it falls back to a paste-ready Realm block and never claims a booking was made.

## Repo layout

- `CLAUDE.md` — agent behavior rules and verified data-source IDs
- `.claude/skills/book-showing/` — booking agent workflow
- `.claude/skills/submit-offer/` — offer agent (stub)
- `docs/booking-agent.md` — design + status
- `docs/integrations.md` — what's connected, what's needed (Realm)
