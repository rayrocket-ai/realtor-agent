# realtor-agent

Your 24/7 AI real estate assistant. It answers leads on **email (Gmail)** and **WhatsApp/Instagram (via Boosend)**, books **showings** straight into your "Real Estate" Google Calendar, **books the MLS side too** — give it an address and a time and it finds the listing on **REALM (PropTx)** and books the appointment through **BrokerBay** — drafts **offers** (Ontario / OREA Form 100 terms) that **you approve before anything is sent**, and follows up with leads automatically.

Built for a solo agent running everything on one small server (e.g. a Hetzner VPS).

## What it does

- **Answers every lead, instantly, 24/7** — email, WhatsApp, and Instagram DMs all flow into one conversation timeline per lead. The assistant always discloses that it's your AI assistant.
- **Books showings** — checks your real Google Calendar availability (working hours: 9am–8pm Toronto by default), proposes times, books the event with the lead invited, and sends 24h + 2h reminders.
- **Books the showing on the MLS side (BrokerBay)** — you give it just an address and a time (dashboard form or `npm run book -- "36 Example Ave" "tomorrow 2pm"`). A real browser signs into **BrokerBay** (via PropTx/TRREB single sign-on), finds the listing, and books your requested slot. Every step is screenshotted; you get an email when it's confirmed or submitted (or when it needs you — ambiguous address, slot taken). When a lead agrees to a time, the same MLS booking is queued automatically after the calendar hold. Verified end-to-end against the live TRREB portal.
- **Drafts offers, never sends them** — when a buyer is ready, it collects price, deposit, irrevocable date, closing date, and conditions, then emails *you* a terms sheet + draft email with **Approve / Reject** links. You can also just reply "approve" to the email, or edit the draft on the dashboard first. Only your approval sends anything. This is enforced in code — the AI has no "send offer" capability at all.
- **Knows when to shut up** — if you reply to a lead yourself (from Gmail or the Boosend console), the assistant pauses on that lead for 4 hours. You can also pause any lead permanently from the dashboard.
- **Escalates to you** — legal/financing questions, upset leads, or "can I talk to Ray?" pause the AI and email you immediately.
- **Dashboard** — a simple password-protected page at `/admin`: all leads, full timelines, pending offers (edit + approve), showings, manual takeover.

## Setup (about 30 minutes)

### 0. What you need

| Thing | Where to get it |
|---|---|
| A server | Hetzner Cloud — a CX22/CPX11 (~€4/mo) with Ubuntu 24.04 is plenty |
| A domain/subdomain | e.g. `agent.yourdomain.com` — create a DNS **A record** pointing at the server's IP |
| Anthropic API key | [console.anthropic.com](https://console.anthropic.com) → API keys |
| Google OAuth client | [console.cloud.google.com](https://console.cloud.google.com): create a project → enable **Gmail API** and **Google Calendar API** → OAuth consent screen (External, add your Gmail as a test user) → Credentials → Create OAuth client ID → type **Desktop app** |
| Boosend API key + webhook | Your Boosend workspace settings (optional — skip to run email-only) |

### 1. Bootstrap the server

SSH in as root and run:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/rayrocket-ai/realtor-agent.git /opt/realtor-agent
cd /opt/realtor-agent
bash scripts/bootstrap.sh
```

The script installs Docker, sets up the firewall, generates passwords, asks for your keys, walks you through the one-time Google sign-in, starts everything with HTTPS (automatic Let's Encrypt via Caddy), and installs a nightly database backup. At the end it prints your dashboard URL and login.

### 2. Connect Boosend (WhatsApp/Instagram)

In Boosend's webhook settings, set:

- **URL:** `https://YOUR_DOMAIN/webhooks/boosend`
- **Secret:** the `BOOSEND_WEBHOOK_SECRET` value the bootstrap printed (also in `/opt/realtor-agent/.env`)

If replies fail, your Boosend plan may use a different send endpoint — the one place to adjust is `src/channels/boosend/client.ts`. To see exactly what Boosend sends, watch `docker compose logs -f app` while sending yourself a test WhatsApp message; ignored payloads are logged in full.

### 3. Choose your Gmail intake mode

By default (`GMAIL_MODE=label`) the assistant only handles email threads you label **AI-Handle** in Gmail — create that label and drag lead threads onto it. Safe way to start.

When you trust it, set `GMAIL_MODE=all` in `.env` and run `bash scripts/deploy.sh` — it will then pick up any new inbound email that looks like a lead (newsletters, no-replys, and mailing lists are filtered out).

### 4. Connect BrokerBay (MLS-side showing bookings)

1. Put your PropTx / TRREB sign-in into `.env`:

   ```
   REALM_USERNAME=9556208          # your TRREB member number (numeric) or portal email
   REALM_PASSWORD=your-pin
   ```

   A numeric `REALM_USERNAME` automatically uses the **"Log in with PropTx User ID"** SSO path (User ID + PIN); an email address uses the regular form. BrokerBay is signed into through this same PropTx SSO, so no separate BrokerBay password is normally needed. Set `BROKERBAY_EMAIL` if your BrokerBay login differs from `REALTOR_EMAIL`.

   To have the agent read the one-time SMS code automatically, point it at whichever channel receives it:

   ```
   REALM_OTP_SENDER=+18338191548   # the number PropTx texts codes from
   # if that number is a HighLevel (GoHighLevel) line:
   HIGHLEVEL_API_TOKEN=pit-…
   HIGHLEVEL_LOCATION_ID=…
   ```

2. Sign in once so the session is saved to `./data/booking`:

   ```bash
   docker compose exec app npm run booking:login
   ```

   PropTx texts an **authorization code** during sign-in. The agent reads it automatically from HighLevel or Gmail (see above); otherwise paste it into the code box on `/admin/bookings` (or `echo CODE > data/booking/otp.txt`) within ~5 minutes and the sign-in finishes by itself. This is one-time — the session persists for future bookings.

3. Do a **dry run** first — it signs in, finds the listing, selects the slot, screenshots everything, and stops just before the final submit:

   ```bash
   docker compose exec app npm run book -- "36 Example Ave, Toronto" "tomorrow 2pm" --dry-run
   ```

   Check the screenshots at `https://YOUR_DOMAIN/admin/bookings`. If it sailed through, book for real (drop `--dry-run`), or set `BOOKING_DRY_RUN=1` in `.env` to keep everything in rehearsal mode while you build trust.

**Which portal:** `BOOKING_PORTAL=brokerbay` (default) signs into BrokerBay directly and uses its own listing search — this is the path verified end-to-end. `BOOKING_PORTAL=realm` instead searches REALM/PropTx first and follows its **Book Showing** handoff into BrokerBay; use it if your board doesn't expose listings through BrokerBay search.

**Safety model:** the final BrokerBay submit is recorded *before* it's clicked, so a crash mid-submit can never silently double-book — the booking parks as "needs attention" and you get an email telling you to check BrokerBay before retrying. "The portal said no" outcomes (listing not found, several matches, your slot taken — with the open slots listed, code prompt, UI changed) never auto-retry either; they email you with screenshots. Only boring transient errors (timeouts before the submit step) retry automatically.

> Heads-up: BrokerBay and PropTx update their UIs without notice. If a booking fails with "portal UI mismatch", the error screenshot on the booking's dashboard page shows exactly where it got stuck — the selectors live in `src/booking/brokerbay-direct.ts`, `src/booking/proptx-sso.ts`, and (for the REALM path) `src/booking/realm.ts` + `brokerbay.ts`.

## Day-to-day

- **Dashboard:** `https://YOUR_DOMAIN/admin` — leads, timelines, offers, showings, MLS bookings.
- **Book a showing on the MLS:** open `https://YOUR_DOMAIN/admin/bookings`, type the address and a time like `tomorrow 2pm` / `sat 1:30pm` / `2026-07-08 14:00`, hit **Book it** — or from a shell: `docker compose exec app npm run book -- "36 Example Ave" "sat 1pm"`. You'll get an email when BrokerBay confirms (instant-confirm listings) or when the request is submitted and waiting on the listing side.
- **Offer approvals** arrive in your normal Gmail inbox with subject `[OFFER-xxxxxxxx]`. Click **Approve** (confirmation page → send), click **Reject** (add feedback, the AI revises), or just **reply** to the email: "approve" sends it, anything else is treated as rejection feedback. Links expire after 72 hours.
- **Take over a conversation:** reply to the lead yourself from Gmail/Boosend (AI pauses 4h), or hit **Pause AI** on the lead's page (pauses until you resume).
- **Update the app:** `cd /opt/realtor-agent && bash scripts/deploy.sh`
- **Logs:** `docker compose logs -f app`
- **Backups:** nightly at 03:30 into `/opt/realtor-agent/backups` (14 kept). Restore: `gunzip -c backups/FILE.sql.gz | docker compose exec -T db psql -U postgres realtor`

## Local development

```bash
cp .env.example .env       # fill in DATABASE_URL for a local postgres
npm install
npm run db:generate        # only after schema changes
npm run dev                # starts server + worker + poller

# test the agent without any credentials:
MOCK_ANTHROPIC=1 npm run send-test -- "can I see 12 Main St this weekend?"

npm test                   # unit tests
npm run typecheck
```

## Architecture (short version)

One Node.js process (TypeScript, Fastify) + Postgres + Caddy, via Docker Compose.

- **Inbound:** Gmail poller (every 45s, Gmail history API) and the Boosend webhook both normalize into one `messages` timeline per lead; the same person on email + WhatsApp merges into one lead by email/phone.
- **Agent:** each inbound message schedules a debounced turn (60s, so rapid texts collapse into one reply). A turn = load lead + timeline from Postgres → Claude (`ANTHROPIC_MODEL`, default `claude-sonnet-5`) with typed tools (`check_availability`, `book_showing`, `draft_offer`, `escalate_to_human`, …) → final text goes back out on the lead's channel. All state lives in Postgres; restarts lose nothing. Every turn is audit-logged in `agent_runs`.
- **Jobs:** a Postgres-backed queue (`FOR UPDATE SKIP LOCKED`, 15s tick) runs reminders, follow-ups, and notifications — durable across restarts, no double-fires, 3 retries then you get an email.
- **Offer safety:** `draft_offer` only writes a row and emails you. The single code path that can send an offer (`src/offers/approval.ts`) requires a valid single-use token or an authenticated dashboard action — i.e., you.
- **MLS bookings:** an `mls_bookings` row + a durable `mls-booking` job per request. `src/booking/orchestrator.ts` drives a `PortalFlow` (Playwright persistent Chromium profile), logging every step to the row and screenshotting into `data/booking/shots/<id>/`. The default flow is `brokerbay-direct.ts` (BrokerBay app → search → book), with `proptx-sso.ts` handling the shared PropTx/TRREB single sign-on (User ID + PIN + auto-read SMS code); the alternate `flow.ts` + `realm.ts` path searches REALM first. Requested times are parsed in `src/booking/time.ts` (timezone-aware, DST-safe). The orchestrator and the BrokerBay outcome parsing are unit-tested against fakes.
