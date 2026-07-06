import { describe, expect, it, vi } from "vitest";
import { runBookingFlow, type BookingDeps } from "./orchestrator.js";
import {
  ListingNotFoundError,
  NeedsLoginError,
  SubmitStateUnknownError,
  TimeUnavailableError,
  type PortalFlow,
  type SubmitResult,
} from "./types.js";
import type { MlsBooking } from "../db/schema.js";

function makeBooking(patch: Partial<MlsBooking> = {}): MlsBooking {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    address: "36 Example Ave, Toronto",
    requestedStart: new Date("2026-07-08T18:00:00Z"),
    durationMin: 30,
    notes: null,
    source: "dashboard",
    leadId: null,
    showingId: null,
    status: "pending",
    attentionReason: null,
    mlsNumber: null,
    matchedAddress: null,
    confirmationText: null,
    gcalEventId: null,
    dryRun: false,
    submitAttemptedAt: null,
    log: [],
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...patch,
  } as MlsBooking;
}

function makeFlow(overrides: Partial<PortalFlow> = {}): PortalFlow {
  return {
    init: vi.fn(async () => {}),
    searchListing: vi.fn(async () => ({ mlsNumber: "W1234567", matchedAddress: "36 Example Ave" })),
    openBooking: vi.fn(async () => {}),
    selectSlot: vi.fn(async () => {}),
    submit: vi.fn(async (): Promise<SubmitResult> => ({ state: "confirmed", message: "Showing confirmed" })),
    screenshot: vi.fn(async () => null),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeDeps() {
  const updates: Array<Partial<MlsBooking>> = [];
  const notifications: Array<{ subject: string; body: string }> = [];
  const steps: string[] = [];
  const deps: BookingDeps = {
    update: vi.fn(async (p) => {
      updates.push(p);
    }),
    logStep: vi.fn(async (step) => {
      steps.push(step);
    }),
    notify: vi.fn(async (subject, body) => {
      notifications.push({ subject, body });
    }),
    createCalendarEvent: vi.fn(async () => "gcal-1"),
  };
  return { deps, updates, notifications, steps };
}

const lastStatus = (updates: Array<Partial<MlsBooking>>) =>
  [...updates].reverse().find((u) => u.status !== undefined)?.status;

describe("runBookingFlow", () => {
  it("books happy-path: confirmed status, calendar event, notification, browser closed", async () => {
    const flow = makeFlow();
    const { deps, updates, notifications } = makeDeps();
    const res = await runBookingFlow(makeBooking(), flow, deps);

    expect(res).toEqual({ status: "confirmed", retryable: false });
    expect(lastStatus(updates)).toBe("confirmed");
    // submitAttemptedAt is recorded BEFORE submit is clicked
    const submitGuardIdx = updates.findIndex((u) => u.submitAttemptedAt);
    expect(submitGuardIdx).toBeGreaterThanOrEqual(0);
    expect(flow.submit).toHaveBeenCalledOnce();
    expect(notifications[0]!.subject).toContain("confirmed");
    expect(updates.some((u) => u.gcalEventId === "gcal-1")).toBe(true);
    expect(flow.close).toHaveBeenCalledOnce();
  });

  it("reports 'submitted' when BrokerBay leaves the request pending approval", async () => {
    const flow = makeFlow({
      submit: vi.fn(async (): Promise<SubmitResult> => ({ state: "submitted", message: "Request sent" })),
    });
    const { deps, updates, notifications } = makeDeps();
    const res = await runBookingFlow(makeBooking(), flow, deps);
    expect(res.status).toBe("submitted");
    expect(lastStatus(updates)).toBe("submitted");
    expect(notifications[0]!.subject).toContain("requested");
  });

  it("dry run stops before submit", async () => {
    const flow = makeFlow();
    const { deps, updates } = makeDeps();
    const res = await runBookingFlow(makeBooking({ dryRun: true }), flow, deps);
    expect(res.status).toBe("dry_run");
    expect(flow.submit).not.toHaveBeenCalled();
    expect(updates.every((u) => u.submitAttemptedAt === undefined)).toBe(true);
    expect(lastStatus(updates)).toBe("dry_run");
  });

  it("never re-runs a booking whose previous attempt reached submit", async () => {
    const flow = makeFlow();
    const { deps, notifications } = makeDeps();
    const res = await runBookingFlow(
      makeBooking({ submitAttemptedAt: new Date(), status: "pending" }),
      flow,
      deps,
    );
    expect(res).toEqual({ status: "needs_attention", retryable: false });
    expect(flow.init).not.toHaveBeenCalled();
    expect(notifications[0]!.body).toContain("duplicate");
  });

  it("marks needs_attention (no retry) when login needs a human", async () => {
    const flow = makeFlow({
      init: vi.fn(async () => {
        throw new NeedsLoginError("realm", "verification code required");
      }),
    });
    const { deps, updates, notifications } = makeDeps();
    const res = await runBookingFlow(makeBooking(), flow, deps);
    expect(res).toEqual({ status: "needs_attention", retryable: false });
    expect(lastStatus(updates)).toBe("needs_attention");
    expect(notifications[0]!.subject).toContain("sign-in");
    expect(flow.close).toHaveBeenCalled();
  });

  it("marks needs_attention when the listing isn't found", async () => {
    const flow = makeFlow({
      searchListing: vi.fn(async () => {
        throw new ListingNotFoundError("36 Example Ave");
      }),
    });
    const { deps } = makeDeps();
    const res = await runBookingFlow(makeBooking(), flow, deps);
    expect(res).toEqual({ status: "needs_attention", retryable: false });
  });

  it("surfaces alternative slots when the time is unavailable", async () => {
    const flow = makeFlow({
      selectSlot: vi.fn(async () => {
        throw new TimeUnavailableError("2:00 PM", ["1:00 PM", "3:30 PM"]);
      }),
    });
    const { deps, notifications } = makeDeps();
    const res = await runBookingFlow(makeBooking(), flow, deps);
    expect(res.status).toBe("needs_attention");
    expect(notifications[0]!.body).toContain("3:30 PM");
  });

  it("retries transient errors before submit", async () => {
    const flow = makeFlow({
      openBooking: vi.fn(async () => {
        throw new Error("net::ERR_TIMED_OUT");
      }),
    });
    const { deps, updates } = makeDeps();
    const res = await runBookingFlow(makeBooking(), flow, deps);
    expect(res.retryable).toBe(true);
    expect(lastStatus(updates)).toBe("failed"); // accurate if the queue's retries run out
  });

  it("NEVER retries when the submit click outcome is unknown", async () => {
    const flow = makeFlow({
      submit: vi.fn(async () => {
        throw new SubmitStateUnknownError("page went blank");
      }),
    });
    const { deps, updates, notifications } = makeDeps();
    const res = await runBookingFlow(makeBooking(), flow, deps);
    expect(res).toEqual({ status: "needs_attention", retryable: false });
    expect(lastStatus(updates)).toBe("needs_attention");
    expect(notifications[0]!.body).toContain("Do NOT blindly retry");
  });

  it("treats even generic crashes after the submit click as non-retryable", async () => {
    const flow = makeFlow({
      submit: vi.fn(async () => {
        throw new Error("browser crashed");
      }),
    });
    const { deps } = makeDeps();
    const res = await runBookingFlow(makeBooking(), flow, deps);
    expect(res).toEqual({ status: "needs_attention", retryable: false });
  });

  it("a calendar failure doesn't fail a successful booking", async () => {
    const flow = makeFlow();
    const { deps, updates } = makeDeps();
    (deps.createCalendarEvent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("gcal down"));
    const res = await runBookingFlow(makeBooking(), flow, deps);
    expect(res.status).toBe("confirmed");
    expect(lastStatus(updates)).toBe("confirmed");
  });
});
