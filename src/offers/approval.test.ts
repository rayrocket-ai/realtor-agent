import { describe, expect, it } from "vitest";
import { generateToken, hashToken } from "./approval.js";

describe("approval tokens", () => {
  it("generates 64-char hex tokens, unique per call", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("hashes deterministically with the secret, not reversibly", () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toBe(hashToken(t + "x"));
  });
});
