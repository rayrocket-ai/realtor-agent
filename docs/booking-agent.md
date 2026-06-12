# Booking Agent — design

Books property showings at a precise time using the client's information. Invoked via the `book-showing` skill.

## Data flow

```
user request
   │
   ├─ "client name" ──► Airtable Buyers ──► client record (contact, interested listings, preferences)
   │                                              │
   └─ "address + time" ──► Airtable Listings ◄────┘
                                │
                                ▼
              Google Calendar "Real Estate" — conflict check (America/Toronto)
                                │
                                ▼
                     user confirms exact slot
                                │
            ┌───────────────────┼────────────────────┐
            ▼                   ▼                    ▼
     Realm booking       Calendar event        CRM System log
   (manual until API     (created by agent)   (created by agent)
    is connected)
                                │
                                ▼
                  Gmail draft → client confirmation
```

## Verified resources

| Resource | Identifier |
|---|---|
| Airtable base | `appesKJpU9JHpd2y2` ("Real Estate Marketing Platform") |
| Buyers table | `tbl8HBiXdyRhoOSAd` |
| Listings table | `tblhrJOQL8k7F3P0a` |
| Agents table | `tbliFWgBrH4s25kDe` |
| CRM System table | `tblesJV5pZPJqeTjk` |
| Showings calendar | `ehjgv5aqlbh60bbp4g502gkid4@group.calendar.google.com` ("Real Estate", America/Toronto) |

## Design decisions

- **Confirm-before-book.** The agent always echoes the final client/address/date/time and waits for a yes before writing anywhere, unless the user's request already contained every detail.
- **Realm is the system of record for the showing itself**; the calendar event and CRM record are the agent's own bookkeeping. Until Realm is connected the agent produces a paste-ready booking block instead (see `integrations.md`).
- **Drafts, not sends.** Emails are drafted in Gmail for the user to review — the agent never emails clients or listing agents directly.
- **30-minute default duration, 30-minute travel buffer** between consecutive showings. Both are conventions, adjustable per request.

## Status

- [x] Client lookup path (Airtable Buyers)
- [x] Property lookup path (Airtable Listings)
- [x] Conflict check + calendar event (Google Calendar)
- [x] CRM logging (Airtable CRM System)
- [x] Confirmation email drafting (Gmail)
- [ ] **Realm booking — blocked on access** (see `integrations.md`)
- [ ] End-to-end test run with a real client + listing
