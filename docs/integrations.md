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
7. ⛔ **BrokerBay host not in egress allowlist (gates BOOKING)** — booking does NOT happen inside Realm. The listing page's **"Online Appt"** link hands off to **BrokerBay**, which is currently 403 (`Host not in allowlist`). **Action:** allowlist BrokerBay (`edge.brokerbay.com`, and the broader `*.brokerbay.com` to be safe). This is the only remaining blocker for end-to-end booking.

> **Egress changes need a NEW session.** The allowlist is baked into the container at startup; editing it does not affect a session that is already running. Save the allowlist change, then start a fresh Claude Code session and re-test.

Allowlist edits are in Claude Code on the web → environment network policy (https://code.claude.com/docs/en/claude-code-on-the-web). Currently required + working: `*.realmmlp.ca`, `sso.ampre.ca`, `collab-static.stratuscollab.com`, `services.leadconnectorhq.com`. **Still needed: `*.brokerbay.com` (at minimum `edge.brokerbay.com`).**

### Search → listing → BrokerBay flow (mapped 2026-06-18)

1. **Search** is a button (`aria-label="Open search"`, "Search REALM") that opens an overlay with a text input (placeholder "try: street address, MLS#, client name…"). Typing + Enter navigates to `/s?...` results.
2. **Results** list listing links: `a[href="/view/listings/TREB-<MLS>"]` with the address as text. (e.g. "85 Ronan Cres, Vaughan" → `TREB-N12851994`.)
3. **Listing page** (`/view/listings/<id>?view=agent-full`) exposes the showing entry point as a link: **`Online Appt`** → `href="/redirect?key=online-appt&listingId=<id>"`.
4. Clicking it opens a **new tab** → `app.realmmlp.ca/api/v1/treb/listings/links/onlineappt/<id>` → redirects to **`https://edge.brokerbay.com/external/treb/book.html`** (the BrokerBay booking UI). ← blocked here by egress.

The listing page also carries the listing agent + brokerage (e.g. PAT PISANTI, Royal LePage Maximum Realty) and a Google Maps "Directions" link with the full geocodable address — useful for the routing/back-to-back feature.

8. ⏳ **BrokerBay booking-form mapping** — cannot be done until blocker 7 clears (the page won't render). Once `*.brokerbay.com` is allowlisted: map the date picker / time-slot list / availability + confirm controls on `edge.brokerbay.com/external/treb/book.html`, then implement the booking + multi-listing routing.

Next step: allowlist `*.brokerbay.com`, start a new session, re-run the "Online Appt" handoff to capture the live BrokerBay DOM, then build the booking flow.

### Interim behavior

Until blocker 7 clears and the BrokerBay form is mapped, the `book-showing` skill outputs a paste-ready booking block and never claims a Realm/BrokerBay booking was made. Everything else (lookup, conflict check, calendar, CRM, email draft) runs for real.

### Discovery tooling

`scripts/realm/login.mjs` is the shared, verified login (Keycloak + HighLevel MFA, optional `storageState` session reuse via `browser.mjs`). `scripts/realm/_capture.mjs` and `scripts/realm/_bb.mjs` are temporary DOM-mapping harnesses (search→listing, and the Online Appt→BrokerBay handoff) — they never submit anything and can be deleted once BrokerBay is mapped.

## Also available (not used yet)

Boosend, Canva, Figma, Gamma, Google Drive, Stripe, Vercel, Zoom, GoDaddy MCP servers are connected to this environment and can be pulled in later (e.g. listing flyers via Canva, payment links via Stripe).
