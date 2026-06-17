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

## Current status (verified 2026-06-17)

`check.mjs` says **BLOCKED**. Two of the original blockers are cleared:

- ✅ `*.realmmlp.ca` is allowlisted (app / e-login / portal all reachable).
- ✅ `REALM_USERNAME` / `REALM_PASSWORD` are set in the environment.
- ✅ Chromium + Playwright work through the proxy.

The remaining gate is **one network-policy change**: the Realm SPA loads its
JavaScript from `collab-static.stratuscollab.com`, which the proxy still blocks
(403). With the JS blocked the login form never renders, so automation cannot
proceed. Allowlist that host (and re-run `check.mjs`) to unblock.

Likely also needed for full function once you're in:
`realmlive-default-rtdb.firebaseio.com`, `www.torontomls.net`.

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

1. **Map the login selectors** in `browser.mjs`/`book.mjs` against the rendered
   form (the `TODO(form-mapping)` markers).
2. **Implement `submitShowing()`** in `book.mjs` — navigate to the listing and
   fill the real showing-request form. Capture the confirmation number.
3. **Handle MFA** if Realm prompts for a code (`book.mjs` already detects and
   aborts on it; decide on an attended-login or session-reuse workaround).
4. **Wire into the skill** — replace step 1 of `.claude/skills/book-showing/SKILL.md`
   with a call to `book.mjs --confirm` and record the returned confirmation.

Until then the skill keeps emitting the paste-ready Realm block and never claims
a booking was placed.
