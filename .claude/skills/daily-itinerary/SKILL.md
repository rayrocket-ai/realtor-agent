---
name: daily-itinerary
description: Build a route-ordered showing run sheet for a day. Use when the user asks for their itinerary, run sheet, schedule, or "what showings do I have" for today / tomorrow / a given date. Reads the Real Estate calendar and enriches each showing with property + buyer details.
---

# Daily Showing Itinerary

Turn a day's calendar into a single, ready-to-drive run sheet: every showing in time
order, each enriched with the property facts and the client context you need on site.

Read-only and fully unattended — no Realm/BrokerBay booking, no emails, no calendar
writes. All times are **America/Toronto**.

## Input — the target day

- Default to **today** if the user doesn't say.
- Accept "tomorrow", a weekday ("Friday"), or an explicit date. Resolve it to a single
  `YYYY-MM-DD` in America/Toronto. If genuinely ambiguous, ask; otherwise proceed and
  state the date you used.

## Step 1 — Pull the day's showings (Gmail is the source of truth)

Confirmed showings live in **BrokerBay emails**, not (yet) on the calendar. Pull both
sources and reconcile:

1. **BrokerBay confirmations (primary).** Search Gmail:
   `from:brokerbay.com subject:"Showing Confirmed" newer_than:14d`. Each email body has
   the **address**, **day + time window (EDT)**, **showing type**, often the **listing
   agent** name/email/phone, and **access instructions** ("Turn Off Lights", "Remove
   Shoes", lockbox/escort, etc.). Keep only those whose date is the target day.
2. **Real Estate calendar (secondary).** List events on
   `ehjgv5aqlbh60bbp4g502gkid4@group.calendar.google.com` for the target day; keep
   events titled `Showing — <address> (<client>)` or clearly a viewing. These carry the
   **client name** (which the BrokerBay email lacks).

**Reconcile to the latest state per showing — this matters:**
- A showing can be **modified** ("successfully modified and is now confirmed") — use the
  **most recent** email for that address/day and discard the superseded time.
- Honor **cancellations** ("Showing Cancelled") — drop those, and search
  `subject:"Showing Cancelled"` for the day too.
- **Dedupe** a calendar event against its BrokerBay email (same address + overlapping
  time) so each real showing appears once.

If there are no showings, say so plainly (note any non-showing calendar events that day)
and stop.

## Step 2 — Assemble each showing

Per showing pull: **start/end time**, **address**, **showing type**, **listing agent**
(name + contact, from the BrokerBay email), **access/instructions**, and **client name**
(from the matching calendar event if present).

## Step 3 — Enrich from Airtable (base `appesKJpU9JHpd2y2`), best-effort

The BrokerBay email already gives the listing agent and access notes. Use Airtable to add
the **buyer context** and fill gaps — never invent:

- **Buyer** (`tbl8HBiXdyRhoOSAd`) by Buyer Name (only when a client is known from the
  calendar event): Contact Information, Budget, Preferred Location, Purchase Timeline,
  Notes — the "what this client wants" context for the walkthrough.
- **Listing** (`tblhrJOQL8k7F3P0a`) by Address: Property ID / MLS, Price — mainly useful
  when it's one of the user's own listings.
- **Agents** (`tbliFWgBrH4s25kDe`): only if the email didn't include agent contact.

Most showings are other brokerages' listings, so expect Airtable misses — that's fine.
Keep the showing and use the email's data; don't drop a stop for a missing lookup.

## Step 4 — Sequence and flag transitions

Showings are fixed appointments, so order strictly by **start time**. Between each
consecutive pair, sanity-check the gap:

- Gap < ~30 min → flag **⚠ tight** (little/no travel buffer).
- Consecutive stops in clearly different areas (compare Preferred Location / city in the
  address) → flag **⚠ long drive** so the user can plan.
- Overlapping times → flag **⚠ conflict** up top.

Do not reorder by geography — the times are booked. The flags are advisory.

## Step 5 — Output the run sheet

One scannable block. Example shape:

```
🗓  Showing Itinerary — Friday, June 19, 2026  ·  3 showings

1.  4:00–4:30 PM   19 Meadow Vista Cres, Holland Landing
    Client:  Sarah Chen · 647-555-0182 · budget $1.2M · wants 4BR Vaughan/Aurora · timeline ~3 mo
    Listing: $1.15M · MLS N12873040 · agent Jane Doe 905-555-0144
    Access:  <lockbox/escort note if known>
    ↓ ~25 min drive · 45 min buffer — OK

2.  5:15–5:45 PM   …
    ⚠ tight — 5 min after the drive

…

Heads-up: bring lockbox combos for #1 and #3; #2 is agent-escort only.
Not in Airtable: <any property/buyer that didn't resolve>.
```

Keep it dense and skimmable — this is read in the car. Lead each stop with **time +
address**, then client, then listing, then access, then the transition note.

## Report back

End with a one-line summary: number of showings, the time window (first start → last
end), and any flags the user should act on (conflicts, tight gaps, missing data).

## Failure handling

- No calendar access / empty day → say so; don't fabricate showings.
- Address or client not in Airtable → keep the stop, flag the gap, carry whatever the
  calendar event already had.
- Times in another timezone → normalize to America/Toronto and note it.
