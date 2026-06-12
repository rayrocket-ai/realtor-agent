---
name: submit-offer
description: Prepare and submit a purchase offer for a property on behalf of a client. STUB — not yet implemented; the booking agent is being built first.
---

# Submit an Offer (stub)

This agent is intentionally not built yet. If invoked, tell the user the offer agent is planned but not implemented, and that the booking agent (`/book-showing`) is the current focus.

## Planned scope (to refine later with the user)

1. Resolve client (Buyers table) and property (Listings table) the same way `book-showing` does.
2. Gather offer terms from the user: price, deposit, closing date, conditions (financing, inspection), irrevocable time.
3. Generate the offer summary / paperwork package.
4. Submit through the user's transaction platform (TBD — likely the same Realm access as showings, or eXp's transaction system) and log to CRM System.

## Open questions before building

- What platform are offers actually submitted through (Realm? SkySlope? DocuSign + email)?
- Ontario forms (OREA Form 100) — who fills them, and does the user want drafting help or just submission tracking?
- Approval flow: the user must always review the full offer before anything is sent.
