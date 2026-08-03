import { describe, expect, it } from "vitest";
import { isBrokerBayEmail, parseBrokerBayEmail, parseLooseDate } from "./parse.js";

const confirmation = `Your showing has been CONFIRMED

Property: 45 Elm Ave, Toronto, ON M4C 1K2
Date & Time: Jul 12, 2026 from 2:00 PM to 2:30 PM
Showing Agent: Lisa Wong
Email: lisa@listings.ca
Phone: (416) 555-1234

Lockbox Code: 4482
Showing Instructions: Remove shoes, lights off when leaving. Tenant occupied — knock first.

Thank you,
BrokerBay`;

describe("isBrokerBayEmail", () => {
  it("matches brokerbay senders and showing subjects", () => {
    expect(isBrokerBayEmail("notifications@brokerbay.com", "anything")).toBe(true);
    expect(isBrokerBayEmail("noreply@mail.brokerbay.ca", "x")).toBe(true);
    expect(isBrokerBayEmail("other@x.com", "Showing Confirmed: 45 Elm Ave")).toBe(true);
    expect(isBrokerBayEmail("lead@gmail.com", "Interested in a condo")).toBe(false);
  });
});

describe("parseBrokerBayEmail", () => {
  it("extracts everything from a confirmation", () => {
    const ev = parseBrokerBayEmail("Showing Confirmed - 45 Elm Ave", confirmation);
    expect(ev.kind).toBe("confirmed");
    expect(ev.address).toContain("45 Elm Ave");
    expect(ev.lockboxCode).toBe("4482");
    expect(ev.instructions).toContain("Remove shoes");
    expect(ev.agentName).toBe("Lisa Wong");
    expect(ev.agentEmail).toBe("lisa@listings.ca");
    expect(ev.agentPhone).toContain("416");
    expect(ev.startsAt).not.toBeNull();
    expect(ev.startsAt!.getFullYear()).toBe(2026);
  });

  it("classifies cancellations and declines", () => {
    expect(parseBrokerBayEmail("Showing Cancelled - 45 Elm Ave", "Property: 45 Elm Ave").kind).toBe("cancelled");
    expect(parseBrokerBayEmail("Showing Request Declined", "Property: 45 Elm Ave").kind).toBe("declined");
    expect(parseBrokerBayEmail("Showing Rescheduled", "Property: 45 Elm Ave").kind).toBe("rescheduled");
  });

  it("returns nulls rather than garbage when fields are absent", () => {
    const ev = parseBrokerBayEmail("Showing Confirmed", "no useful content");
    expect(ev.address).toBeNull();
    expect(ev.lockboxCode).toBeNull();
  });
});

describe("parseLooseDate", () => {
  it("parses 'Jul 12, 2026 from 2:00 PM to 2:30 PM'", () => {
    const d = parseLooseDate("Jul 12, 2026 from 2:00 PM to 2:30 PM");
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe("2026-07-12T18:00:00.000Z");
  });
});
