import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { verifySignature } from "./webhooks.js";

const secret = "whsec_test";
const body = JSON.stringify({ hello: "world" });

describe("verifySignature", () => {
  it("accepts a plain shared-secret header", () => {
    expect(verifySignature(body, secret, secret)).toBe(true);
  });

  it("accepts an HMAC-SHA256 hex signature (with or without sha256= prefix)", () => {
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(verifySignature(body, sig, secret)).toBe(true);
    expect(verifySignature(body, `sha256=${sig}`, secret)).toBe(true);
  });

  it("accepts an HMAC-SHA256 base64 signature", () => {
    const sig = crypto.createHmac("sha256", secret).update(body).digest("base64");
    expect(verifySignature(body, sig, secret)).toBe(true);
  });

  it("rejects wrong signatures and empty headers", () => {
    expect(verifySignature(body, "nope", secret)).toBe(false);
    expect(verifySignature(body, "", secret)).toBe(false);
    const other = crypto.createHmac("sha256", "other-secret").update(body).digest("hex");
    expect(verifySignature(body, other, secret)).toBe(false);
  });
});

describe("voice webhook authentication primitive", () => {
  it("does not accept an empty secret or a different secret", () => {
    expect(verifySignature(body, "", secret)).toBe(false);
    expect(verifySignature(body, "wrong", secret)).toBe(false);
  });
});
