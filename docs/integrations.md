# Integrations

## Connected and working

- **Airtable** — base `appesKJpU9JHpd2y2`, full read/write. Source of truth for buyers, listings, agents, CRM log.
- **Google Calendar** — read/write. Showings calendar: "Real Estate" (`ehjgv5aqlbh60bbp4g502gkid4@group.calendar.google.com`).
- **Gmail** — drafts only by policy; the user reviews and sends.

## Realm — REQUIRED, automation scaffolded, one network blocker left

**Confirmed platform:** Realm by PropTx — member sign-in at https://app.realmmlp.ca/signin (TRREB/PropTx MLS system). Realm has no public booking API, so the integration path is browser automation against the member portal. The Playwright harness lives in `scripts/realm/` (see its README). Run `node scripts/realm/check.mjs` for live connectivity status.

### Login flow (mapped 2026-06-17)

`app.realmmlp.ca/signin` → click **Member** → redirect to TRREB's **Keycloak SSO** at `sso.ampre.ca` (OIDC):

```
https://sso.ampre.ca/realms/trreb/protocol/openid-connect/auth
  ?client_id=app.realmmlp.ca&scope=openid profile email&response_type=code
  &redirect_uri=https://app.realmmlp.ca/auth/amp/callback
```

The login form is **server-rendered Keycloak HTML** (standard `#username` / `#password` / `#kc-login` selectors) — it does NOT depend on the React SPA. So login automation only needs `sso.ampre.ca` reachable; `collab-static` is only needed for the portal/booking UI after login. `login.mjs` drives this directly via the OIDC auth URL and is shared by `book.mjs` and the discovery tools.

Blocker status (verified 2026-06-18 — full end-to-end test run):

1. ✅ **Credentials** — `REALM_USERNAME` / `REALM_PASSWORD` are set as environment variables. Never commit credentials to the repo or paste them into chat history.
2. ✅ **Browser runtime** — Chromium + Playwright work through the environment's TLS-intercepting proxy (`browser.mjs` handles the proxy + cert wiring).
3. ✅ **Realm app host** — `*.realmmlp.ca` is allowlisted (app shell + OIDC callback reachable).
4. ✅ **SSO login host** — `sso.ampre.ca` reachable; Keycloak login form renders and login succeeds.
5. ✅ **App JS host** — `collab-static.stratuscollab.com` reachable; the React SPA (dashboard, search, listing pages) loads.
6. ✅ **MFA/2FA — SMS code via HighLevel (verified working)** — the account enforces SMS MFA. The number lives in HighLevel (GoHighLevel); `scripts/realm/otp_highlevel.mjs` reads the code back via the LeadConnector v2 Conversations API and `login.mjs` enters it automatically — fully unattended. Confirmed end-to-end: login lands on the authenticated Realm dashboard. Env: `HIGHLEVEL_API_TOKEN` (Private Integration token, Conversations read scope), `HIGHLEVEL_LOCATION_ID`, `REALM_OTP_SENDER`; host `services.leadconnectorhq.com`.
7. ✅ **BrokerBay host allowlisted** — booking does NOT happen inside Realm. The listing page's **"Online Appt"** link hands off to **BrokerBay**. `*.brokerbay.com` is now allowlisted; the "Online Appt" handoff reaches `edge.brokerbay.com` and the BrokerBay shell loads (verified 2026-06-18, fresh session, live end-to-end run).
8. ⛔ **BrokerBay booking SPA renders only a spinner — two functional dependencies still blocked (gates BOOKING).** The BrokerBay app shell and its JS bundles load, but the booking view never mounts: it polls feature flags and opens a realtime socket at bootstrap, both of which are egress-blocked. Console confirms it directly: `[FeatureFlagClient]: Error fetching flag settings: network error` and `WebSocket connection to 'wss://ws-us2.pusher.com/...' failed: ... 403`. **Action — allowlist both:**
   - `app.launchdarkly.com` — BrokerBay polls LaunchDarkly feature flags at startup; the spinner hangs until this resolves. (SDK is in polling mode, so only this host is needed — not the streaming/events hosts.)
   - `ws-us2.pusher.com` (or broadly `*.pusher.com`) — realtime channel for live slot availability.

   Already reachable and working for booking: `edge.brokerbay.com` (app shell + booking API) and `storage.googleapis.com` (BrokerBay's `brokerbay-app-static-prod` JS bundles — its bucket root answers 403 by design, but bundle fetches succeed).

   **Safe to ignore** (cosmetic / telemetry only, all blocked but non-essential): `js-agent.newrelic.com`, `sentry.io`, `s.go-mpulse.net`, `www.google-analytics.com`, `www.googletagmanager.com`, `static.zdassets.com` (Zendesk), `fast.appcues.com`, `cdn.roomvo.com`, `code.listtrac.com`, `cdnjs.cloudflare.com` (font-awesome icons + rollbar), `js.stripe.com` (no payment in a showing booking), and listing-photo CDNs (`live-images.stratuscollab.com`, `photos.v3.torontomls.net`).

> **Egress changes need a NEW session.** The allowlist is baked into the container at startup; editing it does not affect a session that is already running. Save the allowlist change, then start a fresh Claude Code session and re-test.

Allowlist edits are in Claude Code on the web → environment network policy (https://code.claude.com/docs/en/claude-code-on-the-web). Currently required + working: `*.realmmlp.ca`, `sso.ampre.ca`, `collab-static.stratuscollab.com`, `services.leadconnectorhq.com`, `*.brokerbay.com`, `storage.googleapis.com`. **Still needed for booking: `app.launchdarkly.com` and `ws-us2.pusher.com`.**

### Search → listing → BrokerBay flow (mapped 2026-06-18)

1. **Search** is a button (`aria-label="Open search"`, "Search REALM") that opens an overlay with a text input (placeholder "try: street address, MLS#, client name…"). Typing + Enter navigates to `/s?...` results.
2. **Results** list listing links: `a[href="/view/listings/TREB-<MLS>"]` with the address as text. (e.g. "85 Ronan Cres, Vaughan" → `TREB-N12851994`.)
3. **Listing page** (`/view/listings/<id>?view=agent-full`) exposes the showing entry point as a link: **`Online Appt`** → `href="/redirect?key=online-appt&listingId=<id>"`.
4. Clicking it opens a **new tab** → `app.realmmlp.ca/api/v1/treb/listings/links/onlineappt/<id>` → redirects into the BrokerBay booking SPA at **`edge.brokerbay.com/dashboard/#/rets/v3--<token>/appointments/book`**. The handoff now lands (host allowlisted); the booking view is gated on the LaunchDarkly/Pusher blockers in §8 above.

The listing page also carries the listing agent + brokerage (e.g. PAT PISANTI, Royal LePage Maximum Realty) and a Google Maps "Directions" link with the full geocodable address — useful for the routing/back-to-back feature.

9. ⏳ **BrokerBay booking-form mapping** — cannot be done until blocker 8 clears (the booking view won't render past the spinner). Once `app.launchdarkly.com` + `ws-us2.pusher.com` are allowlisted: map the date picker / time-slot list / availability + confirm controls on `edge.brokerbay.com/dashboard/#/.../appointments/book`, then implement the booking + multi-listing routing.

Next step: allowlist `app.launchdarkly.com` and `ws-us2.pusher.com`, start a new session, re-run `node scripts/realm/_bb2.mjs` to confirm the booking view renders (and capture its live DOM), then build the booking flow.

### Interim behavior

Until blocker 7 clears and the BrokerBay form is mapped, the `book-showing` skill outputs a paste-ready booking block and never claims a Realm/BrokerBay booking was made. Everything else (lookup, conflict check, calendar, CRM, email draft) runs for real.

### Discovery tooling

`scripts/realm/login.mjs` is the shared, verified login (Keycloak + HighLevel MFA, optional `storageState` session reuse via `browser.mjs`). `scripts/realm/_capture.mjs`, `scripts/realm/_bb.mjs`, and `scripts/realm/_bb2.mjs` are temporary DOM-mapping harnesses (search→listing, the Online Appt→BrokerBay handoff, and the handoff + full network/console trace) — they never submit anything and can be deleted once BrokerBay is mapped. `_bb2.mjs` is the one to re-run after the LaunchDarkly/Pusher allowlist change: it logs every host the booking SPA touches and flags which are blocked.

## Also available (not used yet)

Boosend, Canva, Figma, Gamma, Google Drive, Stripe, Vercel, Zoom, GoDaddy MCP servers are connected to this environment and can be pulled in later (e.g. listing flyers via Canva, payment links via Stripe).
