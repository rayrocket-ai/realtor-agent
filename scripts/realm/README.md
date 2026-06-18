# Realm (PropTx) automation

Browser automation for the **Realm by PropTx** member portal
(https://app.realmmlp.ca/signin) — step 1 ("Realm booking") of the
`book-showing` skill. Realm has no public API, so this drives the web portal
with Playwright.

## Files

| File | What it does |
|---|---|
| `browser.mjs` | Shared Chromium launcher. Wires up the environment's TLS-intercepting proxy + cert so Chromium can reach `app.realmmlp.ca`. |
| `check.mjs` | Connectivity diagnostic. Probes every host the SPA needs and reports whether the login form actually renders. **Run this first.** |
| `book.mjs` | Signs in and submits a showing request. Dry-run by default. |

## Login flow

`app.realmmlp.ca/signin` → **Member** button → TRREB **Keycloak SSO** on
`sso.ampre.ca` (OIDC). The login form is server-rendered Keycloak HTML, so
`book.mjs` goes straight to the OIDC auth URL and fills the standard
`#username` / `#password` / `#kc-login` fields. On success Keycloak redirects
back to `app.realmmlp.ca/auth/amp/callback`.

## Current status (verified 2026-06-17)

`check.mjs` says **BLOCKED**. Cleared:

- ✅ `*.realmmlp.ca` allowlisted (app shell + OIDC callback reachable).
- ✅ `REALM_USERNAME` / `REALM_PASSWORD` set in the environment.
- ✅ Chromium + Playwright work through the proxy.
- ✅ Login flow mapped to Keycloak (selectors wired, no guessing needed).

Remaining (all on your side):

- ⛔ Egress allowlist — add `sso.ampre.ca` (login), `collab-static.stratuscollab.com`
  (portal), and `services.leadconnectorhq.com` (HighLevel API for MFA). **Egress
  changes only apply to a NEW session** — save them, then start a fresh session
  and re-run `check.mjs`. Likely also: `realmlive-default-rtdb.firebaseio.com`,
  `www.torontomls.net`.
- ⚙️ HighLevel env vars for the SMS MFA code (see below).

## MFA (SMS code via HighLevel)

The account texts a login code to a number in HighLevel.
`otp_highlevel.mjs` reads it back via the LeadConnector v2 API and `book.mjs`
enters it automatically. Set in the environment:

| Env var | What |
|---|---|
| `HIGHLEVEL_API_TOKEN` | HighLevel Private Integration token (Conversations read scope) |
| `HIGHLEVEL_LOCATION_ID` | sub-account/location that owns the phone number |
| `REALM_OTP_SENDER` | *(optional)* substring of the sending number/name to filter on |

Verify the fetcher alone before a full login:

```bash
node scripts/realm/otp_highlevel.mjs   # prints the latest detectable SMS code
```

## Running

```bash
# 1. Verify connectivity (exit 0 = unblocked, exit 1 = something is blocked)
node scripts/realm/check.mjs

# 2. Dry run (logs in, fills the form, DOES NOT submit)
node scripts/realm/book.mjs --address "123 Main St, Toronto" --mls W1234567 \
  --date 2026-06-20 --start 14:00 --end 14:30 --client "Sarah Chen"

# 3. Real submission — only once the form is mapped and you mean it
node scripts/realm/book.mjs ... --confirm
```

## Remaining work once `check.mjs` is green

1. **Verify the Keycloak login + MFA** — login and the HighLevel OTP fetch are
   wired; confirm a clean end-to-end sign-in (run `otp_highlevel.mjs` first to
   prove the SMS read works, then a full `book.mjs` dry run).
2. **Implement `submitShowing()`** in `book.mjs` — navigate to the listing and
   fill the real showing-request form (the `TODO(form-mapping)` marker).
   Capture the confirmation number.
3. **Wire into the skill** — replace step 1 of `.claude/skills/book-showing/SKILL.md`
   with a call to `book.mjs --confirm` and record the returned confirmation.

Until then the skill keeps emitting the paste-ready Realm block and never claims
a booking was placed.
