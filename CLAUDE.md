# realtor-agent

AI real estate assistant system with two agents:

1. **Booking Agent** (`/book-showing`) — books property showings for clients. Active development.
2. **Offer Agent** (`/submit-offer`) — prepares and submits purchase offers. Stub only; do not build out until the booking agent is approved.

## How to behave in this repo

- The user is a realtor (eXp Realty, Greater Toronto Area). Default timezone is **America/Toronto** for all dates and showing times.
- When the user gives a booking request, route it through the `book-showing` skill workflow (`.claude/skills/book-showing/SKILL.md`). Accept either entry point:
  - **Client name only** → look the client up, infer property and preferred time from their record, confirm before booking.
  - **Address + time** → book directly; attach a client if one matches the property.
- Never invent client data, property data, or confirmation numbers. If a lookup returns nothing, say so and ask.
- Always confirm the final showing details (address, date, time, client) with the user **before** creating calendar events or sending anything external (emails, Realm requests).

## Connected data sources (live, verified)

### Airtable — base "Real Estate Marketing Platform" (`appesKJpU9JHpd2y2`)

| Table | ID | Used for |
|---|---|---|
| Buyers | `tbl8HBiXdyRhoOSAd` | Client lookup by name. Fields: Buyer Name, Contact Information, Budget, Preferred Location, Purchase Timeline, Interested Listings, Assigned Agent, Engagement Level, Notes |
| Listings | `tblhrJOQL8k7F3P0a` | Property lookup by address. Fields: Property ID, Address, Price, Listing Agent, Buyer Interest |
| Agents | `tbliFWgBrH4s25kDe` | Listing agent contact info (email/phone) for showing requests |
| CRM System | `tblesJV5pZPJqeTjk` | Log every booked showing as an interaction record |

### Google Calendar

- Showings go on the **"Real Estate"** calendar: `ehjgv5aqlbh60bbp4g502gkid4@group.calendar.google.com` (America/Toronto).
- Check this calendar for conflicts before proposing or confirming any showing time.

### Gmail

- Draft (do not auto-send) confirmation emails to clients and showing requests to listing agents. The user sends them after review.

## Realm integration — NOT YET CONNECTED

The precise showing booking is supposed to be placed in **Realm**. There is currently **no Realm tool/API access** in this environment. Until it is connected (see `docs/integrations.md`):

- Do everything else end-to-end (lookup, conflict check, calendar hold, CRM log).
- For the Realm step, output a ready-to-submit booking block (address, MLS/Property ID, date, exact start/end time, client name, agent info) and tell the user to place it in Realm, or draft the request email to the listing agent.
- Never claim a Realm booking was made.

## Conventions

- Default showing duration: 30 minutes (ask if the user wants longer).
- Skills live in `.claude/skills/`. Design docs live in `docs/`.
- Commit messages: short imperative subject line, body explains why.
