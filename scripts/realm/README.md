# Realm (PropTx) automation

Browser automation for the **Realm by PropTx** member portal
(https://app.realmmlp.ca/signin) — step 1 ("Realm booking") of the
`book-showing` skill. Realm has no public API, so this drives the web portal
with Playwright.

## Files

| File | What it does |
|---|---|
| `browser.mjs` | Shared Chromium launcher. Wires up the environment's TLS-intercepting proxy + cert so Chromium can reach `app.realmmlp.ca`. |
| `login.mjs` | Shared, verified login (Keycloak SSO + HighLevel SMS MFA), with optional `storageState` session reuse. Used by `book.mjs`. |
| `otp_highlevel.mjs` | Reads the SMS MFA code back from HighLevel (LeadConnector v2 API). |
| `check.mjs` | Connectivity diagnostic. Probes every host the SPA needs and reports whether the login form actually renders. **Run this first.** |
| `book.mjs` | Signs in, follows the listing's "Online Appt" handoff into BrokerBay, fills the booking form, and submits. **Dry-run by default; only `--confirm` places the booking.** |

## Login flow

`app.realmmlp.ca/signin` → **Member** button → TRREB **Keycloak SSO** on
`sso.ampre.ca` (OIDC). The login form is server-rendered Keycloak HTML, so
`book.mjs` goes straight to the OIDC auth URL and fills the standard
`#username` / `#password` / `#kc-login` fields. On success Keycloak redirects
back to `app.realmmlp.ca/auth/amp/callback`.

## Current status (verified 2026-06-18)

**Login → booking form fill → dry-run all work** in a single unattended run;
`check.mjs` exits 0. **The final "Book Showing" submit is blocked by Google
reCAPTCHA** (`www.google.com/recaptcha`), which is egress-blocked — the form
hangs and no request is sent. Allowlist `www.google.com/recaptcha` +
`www.gstatic.com` and start a new session to place real bookings. `book.mjs`
detects the block on `--confirm` and aborts honestly (see `docs/integrations.md`
§10).

- ✅ `*.realmmlp.ca`, `sso.ampre.ca`, `collab-static.stratuscollab.com`,
  `services.leadconnectorhq.com`, `*.brokerbay.com`, `storage.googleapis.com`,
  `app.launchdarkly.com`, `ws-us2.pusher.com` all allowlisted.
- ✅ `REALM_USERNAME` / `REALM_PASSWORD` + HighLevel MFA env vars set.
- ✅ Chromium + Playwright work through the proxy.
- ✅ Login mapped to Keycloak; SMS MFA read back via HighLevel; lands on dashboard.
- ✅ Search → listing → "Online Appt" → BrokerBay handoff reaches `edge.brokerbay.com`.
- ✅ BrokerBay booking view renders (LaunchDarkly flags + Pusher availability
  socket both connect); date / time-slot / duration form mapped and driven by
  `book.mjs`.

See `docs/integrations.md` §8–9 for the full network trace, the booking-form DOM
map, and the list of cosmetic hosts that are safe to leave blocked.

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

# 2. Dry run (logs in, follows the BrokerBay handoff, fills the form, DOES NOT submit)
node scripts/realm/book.mjs --mls N12851994 \
  --date 2026-06-20 --start "2:00 PM" --end "2:30 PM" --client "Sarah Chen"
#    --listing TREB-N12851994   use a known listing id and skip lookup
#    --address "85 Ronan Cres"  resolve the listing by searching Realm
#    --type "Buyer Visit"       override the default Buyer/Broker showing type
#    --note "..."               attach a note to the request
# Start/end accept "2:00 PM" or 24h "14:00"; duration is derived (15 or 30 min).
# A screenshot of the filled form lands at /tmp/realm-booking-filled.png.

# 3. Real submission — clicks "Book Showing" and reads back the confirmation
node scripts/realm/book.mjs --mls N12851994 --date 2026-06-20 \
  --start "2:00 PM" --end "2:30 PM" --client "Sarah Chen" --confirm
```

The flow and selectors are mapped (see `docs/integrations.md` §8–9). `book.mjs`
aborts loudly if login/MFA fails, the booking view never renders, or the
requested slot isn't offered/available, and never prints a confirmation it
didn't read back from BrokerBay.
