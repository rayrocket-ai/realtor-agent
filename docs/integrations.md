# Integrations

## Connected and working

- **Airtable** — base `appesKJpU9JHpd2y2`, full read/write. Source of truth for buyers, listings, agents, CRM log.
- **Google Calendar** — read/write. Showings calendar: "Real Estate" (`ehjgv5aqlbh60bbp4g502gkid4@group.calendar.google.com`).
- **Gmail** — drafts only by policy; the user reviews and sends.

## Realm — REQUIRED, automation scaffolded, one network blocker left

**Confirmed platform:** Realm by PropTx — member sign-in at https://app.realmmlp.ca/signin (TRREB/PropTx MLS system). Realm has no public booking API, so the integration path is browser automation against the member portal. The Playwright harness lives in `scripts/realm/` (see its README). Run `node scripts/realm/check.mjs` for live connectivity status.

Blocker status (verified 2026-06-17):

1. ✅ **Network policy (partial)** — `*.realmmlp.ca` is now allowlisted: `app.realmmlp.ca`, `e-login.realmmlp.ca`, `browser.realmmlp.ca` all reachable through the proxy. (General web is still blocked, e.g. google.com → 403, which is fine.)
2. ✅ **Credentials** — `REALM_USERNAME` / `REALM_PASSWORD` are set as environment variables. Never commit credentials to the repo or paste them into chat history.
3. ✅ **Browser runtime** — Chromium + Playwright work through the environment's TLS-intercepting proxy (`browser.mjs` handles the proxy + cert wiring).
4. ⛔ **App JS host still blocked (THE gating blocker)** — the Realm SPA loads its JavaScript bundles from `collab-static.stratuscollab.com`, which the proxy blocks (403). The sign-in page returns HTTP 200 but renders an **empty** `<div id="root">` with zero inputs, so the login form never appears and automation cannot proceed. **Action:** allowlist `collab-static.stratuscollab.com` in the environment's network policy (Claude Code on the web settings: https://code.claude.com/docs/en/claude-code-on-the-web), then re-run `scripts/realm/check.mjs`. Likely also needed once logged in: `realmlive-default-rtdb.firebaseio.com`, `www.torontomls.net`.
5. ⏳ **MFA/2FA** — unknown until the form renders. `book.mjs` detects a code prompt at login and aborts (unattended booking is impossible if MFA is enforced; would need attended login or session reuse).
6. ⏳ **Booking form mapping** — the login/showing-request selectors (`TODO(form-mapping)` in `scripts/realm/`) can only be finalised against the rendered DOM, i.e. after blocker 4 clears.

Next step is purely the blocker-4 allowlist change; the script structure, proxy/cert handling, login attempt, MFA guard, and dry-run safety are already in place and tested.

### Interim behavior

Until blocker 4 clears and the form is mapped, the `book-showing` skill outputs a paste-ready booking block and never claims a Realm booking was made. Everything else (lookup, conflict check, calendar, CRM, email draft) runs for real.

## Also available (not used yet)

Boosend, Canva, Figma, Gamma, Google Drive, Stripe, Vercel, Zoom, GoDaddy MCP servers are connected to this environment and can be pulled in later (e.g. listing flyers via Canva, payment links via Stripe).
