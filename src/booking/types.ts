import type { MlsBooking } from "../db/schema.js";

/** What BrokerBay reported after the final submit. */
export interface SubmitResult {
  /** confirmed = instantly confirmed; submitted = request sent, awaiting listing-side approval. */
  state: "confirmed" | "submitted";
  /** Confirmation / status text scraped from the page, for the audit trail. */
  message: string;
}

export interface ListingMatch {
  mlsNumber: string | null;
  matchedAddress: string;
}

/**
 * One end-to-end portal session for a single booking:
 * REALM login → listing search → BrokerBay handoff → slot → submit.
 * Implemented with Playwright in flow.ts; faked in tests.
 */
export interface PortalFlow {
  /** Launch the browser and make sure we're signed into REALM. */
  init(): Promise<void>;
  /** Find the listing on REALM by address. */
  searchListing(address: string): Promise<ListingMatch>;
  /** Follow the listing's "Book Showing" button into the BrokerBay booking UI. */
  openBooking(): Promise<void>;
  /** Pick the requested date/time/duration in BrokerBay (does not submit). */
  selectSlot(start: Date, durationMin: number): Promise<void>;
  /** Click the final confirm/submit button and read back the result. */
  submit(notes?: string | null): Promise<SubmitResult>;
  /** Best-effort screenshot; returns the saved file name or null. */
  screenshot(name: string): Promise<string | null>;
  close(): Promise<void>;
}

/* ---- Terminal flow errors (no automatic retry — the realtor gets an email) ---- */

/** Login needs a human: 2FA prompt, captcha, or expired/invalid credentials. */
export class NeedsLoginError extends Error {
  constructor(
    public portal: "realm" | "brokerbay",
    detail: string,
  ) {
    super(`${portal} login needs your attention: ${detail}`);
    this.name = "NeedsLoginError";
  }
}

export class ListingNotFoundError extends Error {
  constructor(address: string) {
    super(`No active listing found on REALM matching "${address}"`);
    this.name = "ListingNotFoundError";
  }
}

export class AmbiguousListingError extends Error {
  constructor(
    address: string,
    public candidates: string[],
  ) {
    super(
      `Multiple listings match "${address}" — please be more specific.\nCandidates:\n${candidates
        .map((c) => `  - ${c}`)
        .join("\n")}`,
    );
    this.name = "AmbiguousListingError";
  }
}

export class TimeUnavailableError extends Error {
  constructor(
    requested: string,
    public alternatives: string[],
  ) {
    super(
      `The requested time (${requested}) is not available on BrokerBay.` +
        (alternatives.length ? `\nOpen slots that day:\n${alternatives.map((a) => `  - ${a}`).join("\n")}` : ""),
    );
    this.name = "TimeUnavailableError";
  }
}

/**
 * The portal page didn't look like we expected (selectors missed). Terminal:
 * retrying won't help until the selectors are updated for the new UI.
 */
export class PortalChangedError extends Error {
  constructor(step: string, detail: string) {
    super(`Portal UI mismatch at step "${step}": ${detail}`);
    this.name = "PortalChangedError";
  }
}

/** The submit click happened but we couldn't read a clear outcome — never auto-retry. */
export class SubmitStateUnknownError extends Error {
  constructor(detail: string) {
    super(`Submitted (or may have submitted) but couldn't confirm the outcome: ${detail}`);
    this.name = "SubmitStateUnknownError";
  }
}

export type BookingStatus = MlsBooking["status"];
