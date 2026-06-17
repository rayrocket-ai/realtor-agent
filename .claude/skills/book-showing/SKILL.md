---
name: book-showing
description: Book a real estate showing for a client. Use when the user asks to book, schedule, or set up a showing/viewing. Works from either a client name ("book a showing for Sarah") or an address + time ("book 123 Main St Saturday at 2pm").
---

# Book a Showing

Book a property showing end-to-end: resolve the client, resolve the property, pick the precise time, verify no conflicts, place the booking, log it.

All times are **America/Toronto** unless the user says otherwise. Default duration is **30 minutes**.

## Inputs — two entry points

**A. Client name** (e.g. "book a showing for Sarah Chen")
1. Search the Buyers table (base `appesKJpU9JHpd2y2`, table `tbl8HBiXdyRhoOSAd`) by Buyer Name. Use Airtable `search_records` or a `filterByFormula` on Buyer Name; match case-insensitively and accept partial names. If multiple buyers match, list them and ask which one.
2. From the buyer record, pull: Contact Information, Preferred Location, Interested Listings, Notes.
3. Property: if the user named one, use it. Otherwise use the buyer's Interested Listings (linked records → fetch from Listings `tblhrJOQL8k7F3P0a`). If several, ask which property.
4. Time: if the user gave one, use it. Otherwise propose 2–3 open slots (see Conflict check) and ask.

**B. Address + time** (e.g. "book 123 Main St tomorrow at 2pm")
1. Search the Listings table by Address (partial match OK). If found, grab Property ID and Listing Agent. If not found, proceed with the raw address but tell the user it's not in Airtable.
2. Client is optional in this mode. Check the listing's Buyer Interest links and the Buyers table for a likely client; if one obvious match exists, suggest it; otherwise book without a client attached.

## Conflict check

Before confirming any time, list events on the "Real Estate" calendar (`ehjgv5aqlbh60bbp4g502gkid4@group.calendar.google.com`) for that day. If the requested slot overlaps an existing event (include 30 min travel buffer between showings), tell the user and propose the nearest free slots instead. Do not silently move the time.

## Confirm before acting

Show the user one summary line — client, address, date, exact start–end time — and get a yes before creating anything. Skip this only if the user already gave every detail explicitly in their request.

## Execute (in this order)

1. **Realm booking** — Realm automation is scaffolded in `scripts/realm/` but still gated on two network-policy changes (see `docs/integrations.md`: `sso.ampre.ca` is blocked so the Keycloak login can't load, and `collab-static.stratuscollab.com` is blocked so the portal can't render). Until those clear, output a "Realm booking block" the user can paste in:

   ```
   Property: <address> (ID: <property id>)
   Date/Time: <YYYY-MM-DD HH:MM–HH:MM ET>
   Client: <buyer name, phone/email>
   Listing agent: <name, contact from Agents table>
   ```

   Never state or imply the Realm booking was placed. Once `node scripts/realm/check.mjs` reports UNBLOCKED and the form selectors are mapped, replace this step with a call to `scripts/realm/book.mjs --confirm` and record the confirmation number it returns.

2. **Calendar event** — create on the "Real Estate" calendar: title `Showing — <address> (<client name>)`, correct start/end, description containing client contact info, Property ID, and listing agent contact.

3. **CRM log** — create a record in CRM System (`tblesJV5pZPJqeTjk`): link Buyer Name, set Interaction Date to the showing date, Interaction Type to the closest matching choice (fetch the table schema first to get valid singleSelect options), link Listing Interest to the property, Notes = showing time + status.

4. **Confirmation email (draft only)** — Gmail draft to the client: address, date, time, meeting instructions. Tell the user the draft is ready to review and send.

## Report back

End with: what was booked (or prepared), the calendar event date/time, the Realm block status (placed vs. needs manual entry), and anything that needs the user's follow-up.

## Failure handling

- Client not found → say so, show the closest name matches, ask. Do not create a buyer record unless asked.
- Address not found in Listings → proceed with raw address, flag it.
- Ambiguous time ("Saturday afternoon") → propose concrete free slots, never guess silently.
