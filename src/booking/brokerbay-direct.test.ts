import { describe, expect, it, vi, beforeEach } from "vitest";

// The flow reads config() at construction-time only inside methods, so a light
// mock is enough to exercise the pure outcome-parsing via a fake page.
vi.mock("../config.js", () => ({
  config: () => ({
    TZ: "America/Toronto",
    BROKERBAY_URL: "https://edge.brokerbay.com",
    BROKERBAY_EMAIL: "ray@example.com",
    REALTOR_EMAIL: "ray@example.com",
    GMAIL_ADDRESS: "ray@example.com",
  }),
}));
vi.mock("./browser.js", () => ({
  launchBookingContext: vi.fn(),
  saveShot: vi.fn(async () => null),
}));

import { BrokerBayDirectFlow } from "./brokerbay-direct.js";
import { SubmitStateUnknownError } from "./types.js";

/**
 * A minimal fake Playwright Page: submit() clicks a "Book Showing" button then
 * reads body text to classify the outcome. We stub just those interactions.
 */
function fakePage(bodyText: string, opts: { hasConfirm?: boolean; errorText?: string } = {}) {
  const clicks: string[] = [];
  const page: any = {
    clicks,
    locator(sel: string) {
      return {
        last: () => ({
          isVisible: async () => sel.includes("Book Showing"),
          click: async () => clicks.push(`click:${sel}`),
        }),
        first: () => ({
          isVisible: async () => (opts.errorText ? sel.includes("error") || sel.includes("alert") : false),
          textContent: async () => opts.errorText ?? null,
          click: async () => clicks.push(`click:${sel}`),
        }),
      };
    },
    getByText: () => ({ count: async () => 0, nth: () => ({ textContent: async () => "" }) }),
    async waitForTimeout() {},
    async waitForLoadState() {},
    url: () => "https://edge.brokerbay.com/#/listing/x/appointments",
    async textContent() {
      return bodyText;
    },
  };
  return page;
}

function flowWithPage(page: any): BrokerBayDirectFlow {
  const flow = new BrokerBayDirectFlow("00000000-0000-0000-0000-000000000001");
  (flow as any).page = page;
  return flow;
}

describe("BrokerBayDirectFlow.submit outcome parsing", () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports "confirmed" when BrokerBay confirms outright', async () => {
    const page = fakePage("16 Curry Crescent Showing Confirmed for July 7");
    const res = await flowWithPage(page).submit();
    expect(res.state).toBe("confirmed");
  });

  it('reports "submitted" for a request pending listing-side approval (status New)', async () => {
    const page = fakePage("Total: 2 Showings July 7th 5:00 PM RAY AHMADI New Needs Action Confirm Deny");
    const res = await flowWithPage(page).submit();
    expect(res.state).toBe("submitted");
  });

  it('reports "submitted" on "request is being processed"', async () => {
    const page = fakePage("Your showing request is being processed. Please wait for further instruction.");
    const res = await flowWithPage(page).submit();
    expect(res.state).toBe("submitted");
  });

  it("does NOT call confirmed when the row still needs action", async () => {
    // "confirmed" word absent, only Needs Action → submitted, never confirmed.
    const page = fakePage("Showing Requested Needs Action Confirm Deny Suggest");
    const res = await flowWithPage(page).submit();
    expect(res.state).toBe("submitted");
  });

  it("throws SubmitStateUnknownError with the page error text", async () => {
    const page = fakePage("some unrelated page", { errorText: "That time is no longer available" });
    await expect(flowWithPage(page).submit()).rejects.toBeInstanceOf(SubmitStateUnknownError);
  });

  it("throws SubmitStateUnknownError when nothing recognizable is shown", async () => {
    const page = fakePage("blank-ish page with no known markers xyz");
    await expect(flowWithPage(page).submit()).rejects.toBeInstanceOf(SubmitStateUnknownError);
  });
});
