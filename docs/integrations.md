# Integrations

## Connected and working

- **Airtable** — base `appesKJpU9JHpd2y2`, full read/write. Source of truth for buyers, listings, agents, CRM log.
- **Google Calendar** — read/write. Showings calendar: "Real Estate" (`ehjgv5aqlbh60bbp4g502gkid4@group.calendar.google.com`).
- **Gmail** — drafts only by policy; the user reviews and sends.

## Realm — REQUIRED, automation working end-to-end

**Confirmed platform:** Realm by PropTx — member sign-in at https://app.realmmlp.ca/signin (TRREB/PropTx MLS system). Realm has no public booking API, so the integration path is browser automation against the member portal. The Playwright harness lives in `scripts/realm/` (see its README). Run `node scripts/realm/check.mjs` for live connectivity status.

### Login flow (mapped 2026-06-17)

`app.realmmlp.ca/signin` → click **Member** → redirect to TRREB's **Keycloak SSO** at `sso.ampre.ca` (OIDC):

```
https://sso.ampre.ca/realms/trreb/protocol/openid-connect/auth
  ?client_id=app.realmmlp.ca&scope=openid profile email&response_type=code
  &redirect_uri=https://app.realmmlp.ca/auth/amp/callback
```

The login form is **server-rendered Keycloak HTML** (standard `#username` / `#password` / `#kc-login` selectors) — it does NOT depend on the React SPA. So login automation only needs `sso.ampre.ca` reachable; `collab-static` is only needed for the portal/booking UI after login. `login.mjs` drives this directly via the OIDC auth URL and is shared by `book.mjs` and the discovery tools.

Status (verified 2026-06-18 — full end-to-end test run, login → BrokerBay booking form filled):

1. ✅ **Credentials** — `REALM_USERNAME` / `REALM_PASSWORD` are set as environment variables. Never commit credentials to the repo or paste them into chat history.
2. ✅ **Browser runtime** — Chromium + Playwright work through the environment's TLS-intercepting proxy (`browser.mjs` handles the proxy + cert wiring).
3. ✅ **Realm app host** — `*.realmmlp.ca` is allowlisted (app shell + OIDC callback reachable).
4. ✅ **SSO login host** — `sso.ampre.ca` reachable; Keycloak login form renders and login succeeds.
5. ✅ **App JS host** — `collab-static.stratuscollab.com` reachable; the React SPA (dashboard, search, listing pages) loads.
6. ✅ **MFA/2FA — SMS code via HighLevel (verified working)** — the account enforces SMS MFA. The number lives in HighLevel (GoHighLevel); `scripts/realm/otp_highlevel.mjs` reads the code back via the LeadConnector v2 Conversations API and `login.mjs` enters it automatically — fully unattended. Confirmed end-to-end: login lands on the authenticated Realm dashboard. Env: `HIGHLEVEL_API_TOKEN` (Private Integration token, Conversations read scope), `HIGHLEVEL_LOCATION_ID`, `REALM_OTP_SENDER`; host `services.leadconnectorhq.com`.
7. ✅ **BrokerBay host allowlisted** — booking does NOT happen inside Realm. The listing page's **"Online Appt"** link hands off to **BrokerBay**. `*.brokerbay.com` is now allowlisted; the "Online Appt" handoff reaches `edge.brokerbay.com` and the BrokerBay shell loads (verified 2026-06-18, fresh session, live end-to-end run).
8. ✅ **BrokerBay booking SPA renders — LaunchDarkly + Pusher cleared (verified 2026-06-18, fresh session).** The two functional dependencies that used to hang the spinner are now allowlisted and working: `app.launchdarkly.com` returns 200 ("LaunchDarkly client initialized") and the Pusher availability socket connects (`wss://ws-us2.pusher.com/app/...`). The booking view mounts fully — profile, date picker, and live time-slot availability all render. Already reachable and working: `edge.brokerbay.com` (app shell + booking API) and `storage.googleapis.com` (BrokerBay's `brokerbay-app-static-prod` JS bundles — bucket root answers 403 by design, but bundle fetches succeed).

   **Safe to ignore** (cosmetic / telemetry only, all blocked but non-essential): `js-agent.newrelic.com`, `sentry.io`, `s.go-mpulse.net`, `www.google-analytics.com`, `www.googletagmanager.com`, `static.zdassets.com` (Zendesk), `fast.appcues.com`, `cdn.roomvo.com`, `code.listtrac.com`, `cdnjs.cloudflare.com` (font-awesome icons + rollbar), `js.stripe.com` (no payment in a showing booking), and listing-photo CDNs (`live-images.stratuscollab.com`, `photos.v3.torontomls.net`).

> **Egress changes need a NEW session.** The allowlist is baked into the container at startup; editing it does not affect a session that is already running. Save the allowlist change, then start a fresh Claude Code session and re-test.

Allowlist edits are in Claude Code on the web → environment network policy (https://code.claude.com/docs/en/claude-code-on-the-web). Required + working for the full booking flow: `*.realmmlp.ca`, `sso.ampre.ca`, `collab-static.stratuscollab.com`, `services.leadconnectorhq.com`, `*.brokerbay.com`, `storage.googleapis.com`, `app.launchdarkly.com`, `ws-us2.pusher.com`. All other hosts the SPA touches are cosmetic/telemetry (see list above) and safe to leave blocked.

### Search → listing → BrokerBay flow (mapped 2026-06-18)

1. **Search** is a button (`aria-label="Open search"`, "Search REALM") that opens an overlay with a text input (placeholder "try: street address, MLS#, client name…"). Typing + Enter navigates to `/s?...` results.
2. **Results** list listing links: `a[href="/view/listings/TREB-<MLS>"]` with the address as text. (e.g. "85 Ronan Cres, Vaughan" → `TREB-N12851994`.)
3. **Listing page** (`/view/listings/<id>?view=agent-full`) exposes the showing entry point as a link: **`Online Appt`** → `href="/redirect?key=online-appt&listingId=<id>"`.
4. Clicking it opens a **new tab** → `app.realmmlp.ca/api/v1/treb/listings/links/onlineappt/<id>` → redirects into the BrokerBay booking SPA at **`edge.brokerbay.com/dashboard/#/rets/v3--<token>/appointments/book`**. The handoff now lands (host allowlisted); the booking view is gated on the LaunchDarkly/Pusher blockers in §8 above.

The listing page also carries the listing agent + brokerage (e.g. PAT PISANTI, Royal LePage Maximum Realty) and a Google Maps "Directions" link with the full geocodable address — useful for the routing/back-to-back feature.

9. ✅ **BrokerBay booking form mapped + implemented (verified 2026-06-18).** The booking view at `edge.brokerbay.com/dashboard/#/rets/v3--<token>/appointments/book` is a three-step form, now driven by `scripts/realm/book.mjs`:
   - **Step 1 – Profile:** pre-filled from the logged-in agent (name, brokerage, email). `select[name="showingType"]` chooses the visit type (default `Buyer/Broker`); an "Add Note" button reveals a note `textarea`.
   - **Step 2 – Date:** `.datepicker-booking` calendar; days are `.datenumber` inside `.datecontainer` (past days carry `.no-hover`, the selected day's number carries `.day-selected`). Month is navigated with the `‹ ›` chevrons in the header.
   - **Step 3 – Time:** 15-minute `.timeslot` divs whose class encodes availability — plain `.timeslot` is bookable, `.timeslot-unavailable` is taken/blocked, `.timeslot-p` is in the past. Selecting a slot marks it `.timeslot-selected` and reveals a **Duration** radio (`input[name="duration"]`, values `15`/`30`, capped per listing) plus a **Done** button.
   - **Submit:** the `Book Showing` button (`button.ant-btn`, text "Book Showing") becomes enabled once date + slot + duration are set. `book.mjs` clicks it only with `--confirm` and reads back the result.

   `book.mjs` resolves the listing (`--listing`, `--mls` → `TREB-<MLS#>`, or `--address` via Realm search), opens the Online Appt handoff, fills the form, and is dry-run by default. Live slot availability comes over the Pusher socket, so it doubles as the real-time conflict check on the listing side.

### Behavior

The `book-showing` skill now places the showing through `book.mjs` (dry-run → confirm) when `check.mjs` is UNBLOCKED, and records the confirmation it reads back. If the listing isn't bookable online or a session is BLOCKED, it falls back to the paste-ready booking block and never claims a booking was made. Everything else (lookup, conflict check, calendar, CRM, email draft) runs for real.

### Discovery tooling

`scripts/realm/login.mjs` is the shared, verified login (Keycloak + HighLevel MFA, optional `storageState` session reuse via `browser.mjs`). The BrokerBay flow is now mapped and lives in `book.mjs`; the temporary DOM-mapping harnesses (`_capture.mjs`, `_bb*.mjs`) have been removed. To re-capture the live DOM if BrokerBay changes, drive `login.mjs` + the Online Appt handoff and dump the booking frame.

## Also available (not used yet)

Boosend, Canva, Figma, Gamma, Google Drive, Stripe, Vercel, Zoom, GoDaddy MCP servers are connected to this environment and can be pulled in later (e.g. listing flyers via Canva, payment links via Stripe).
