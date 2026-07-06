import type { BrowserContext, Page } from "playwright";
import { launchBookingContext, saveShot } from "./browser.js";
import { ensureRealmLogin, openBrokerBayFromListing, openListing } from "./realm.js";
import { ensureBrokerBayLogin, openBookingUi, selectDate, selectTime, submitBooking } from "./brokerbay.js";
import type { ListingMatch, PortalFlow, SubmitResult } from "./types.js";

/** The real REALM → BrokerBay flow, backed by a persistent Playwright session. */
export class RealmBrokerBayFlow implements PortalFlow {
  private context: BrowserContext | null = null;
  private realmPage: Page | null = null;
  private bbPage: Page | null = null;

  constructor(private bookingId: string) {}

  private page(): Page {
    const p = this.bbPage ?? this.realmPage;
    if (!p) throw new Error("flow not initialized");
    return p;
  }

  async init(): Promise<void> {
    this.context = await launchBookingContext();
    this.realmPage = await this.context.newPage();
    await ensureRealmLogin(this.realmPage);
    await this.screenshot("realm-signed-in");
  }

  async searchListing(address: string): Promise<ListingMatch> {
    const match = await openListing(this.realmPage!, address);
    await this.screenshot("listing");
    return match;
  }

  async openBooking(): Promise<void> {
    this.bbPage = await openBrokerBayFromListing(this.context!, this.realmPage!);
    await ensureBrokerBayLogin(this.bbPage);
    await openBookingUi(this.bbPage);
    await this.screenshot("brokerbay");
  }

  async selectSlot(start: Date, durationMin: number): Promise<void> {
    await selectDate(this.bbPage!, start);
    await selectTime(this.bbPage!, start, durationMin);
  }

  async submit(notes?: string | null): Promise<SubmitResult> {
    return submitBooking(this.bbPage!, notes);
  }

  async screenshot(name: string): Promise<string | null> {
    try {
      return await saveShot(this.page(), this.bookingId, name);
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.realmPage = null;
    this.bbPage = null;
  }
}
