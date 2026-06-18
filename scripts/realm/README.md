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

## Current status (verified 2026-06-18)

**Login is UNBLOCKED end-to-end** (Keycloak SSO + HighLevel SMS MFA, fully
unattended). The BrokerBay handoff now lands too, but the BrokerBay booking
view is still gated on two egress hosts — `check.mjs` exits 1 until they clear.

Cleared:

- ✅ `*.realmmlp.ca`, `sso.ampre.ca`, `collab-static.stratuscollab.com`,
  `services.leadconnectorhq.com`, `*.brokerbay.com`, `storage.googleapis.com`
  all allowlisted.
- ✅ `REALM_USERNAME` / `REALM_PASSWORD` + HighLevel MFA env vars set.
- ✅ Chromium + Playwright work through the proxy.
- ✅ Login mapped to Keycloak; SMS MFA read back via HighLevel; lands on dashboard.
- ✅ Search → listing → "Online Appt" → BrokerBay handoff reaches `edge.brokerbay.com`.

Remaining (egress, on your side):

- ⛔ Allowlist `app.launchdarkly.com` (feature flags — gates the BrokerBay
  booking render; the page hangs on a spinner without it) and `ws-us2.pusher.com`
  (realtime slot availability). **Egress changes only apply to a NEW session** —
  save them, start a fresh session, then run `node scripts/realm/_bb2.mjs` to
  confirm the booking view renders. See `docs/integrations.md` §8 for the full
  network trace and the list of cosmetic hosts that are safe to leave blocked.

## MFA (SMS code via HighLevel)

The account texts a login code to a number in HighLevel.
`otp_highlevel.mjs` reads it back via the LeadConnector v2 API and `book.mjs`
enters it automatically. Set in the environment:

| Env var | What |
|---|---|
| `HIGHLEVEL_API_TOKEN` | HighLevel Private Integration token (Conversations read scope) |
| `HIGHLEVEL_LOCATION_ID` | sub-account/location that owns the phone number |
| `REALM_OTP_SENDER` | *(optional)* the number the code texts from — any format works (`+1...`, `1...`, dashes/spaces; digits are normalized), or an alphanumeric sender ID like `Realm` |

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
