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

The login form is **server-rendered Keycloak HTML** (standard `#username` / `#password` / `#kc-login` selectors) — it does NOT depend on the React SPA. So login automation only needs `sso.ampre.ca` reachable; `collab-static` is only needed for the portal/booking UI after login. `book.mjs` drives this directly via the OIDC auth URL.

Blocker status (verified 2026-06-17):

1. ✅ **Credentials** — `REALM_USERNAME` / `REALM_PASSWORD` are set as environment variables. Never commit credentials to the repo or paste them into chat history.
2. ✅ **Browser runtime** — Chromium + Playwright work through the environment's TLS-intercepting proxy (`browser.mjs` handles the proxy + cert wiring).
3. ✅ **Realm app host** — `*.realmmlp.ca` is allowlisted (app shell + OIDC callback reachable).
4. ⛔ **SSO login host blocked (gates LOGIN)** — `sso.ampre.ca` returns 403 (`X-Proxy-Error: blocked-by-allowlist`). The Keycloak login page can't load, so we can't even sign in. **Action:** allowlist `sso.ampre.ca`.
5. ⛔ **App JS host blocked (gates the PORTAL/booking UI)** — the SPA loads from `collab-static.stratuscollab.com` (403). Needed after login to navigate the portal and submit a showing. **Action:** allowlist `collab-static.stratuscollab.com`.

Both allowlist changes are in Claude Code on the web → environment network policy (https://code.claude.com/docs/en/claude-code-on-the-web). Likely also needed once logged in: `realmlive-default-rtdb.firebaseio.com`, `www.torontomls.net`. After changing the policy, re-run `node scripts/realm/check.mjs`.

6. ⏳ **MFA/2FA** — unknown until the Keycloak form renders. `book.mjs` detects an OTP prompt and aborts (unattended booking is impossible if MFA is enforced; would need attended login or session reuse).
7. ⏳ **Booking form mapping** — login selectors are standard Keycloak and already wired. The showing-request form (`submitShowing()` / `TODO(form-mapping)` in `book.mjs`) can only be finalised against the rendered portal, i.e. after blocker 5 clears.

Next step is the two allowlist changes (blockers 4 + 5); the script structure, proxy/cert handling, Keycloak login flow, MFA guard, and dry-run safety are already in place and tested.

### Interim behavior

Until blocker 4 clears and the form is mapped, the `book-showing` skill outputs a paste-ready booking block and never claims a Realm booking was made. Everything else (lookup, conflict check, calendar, CRM, email draft) runs for real.

## Also available (not used yet)

Boosend, Canva, Figma, Gamma, Google Drive, Stripe, Vercel, Zoom, GoDaddy MCP servers are connected to this environment and can be pulled in later (e.g. listing flyers via Canva, payment links via Stripe).
