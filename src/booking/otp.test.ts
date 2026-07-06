import { describe, expect, it } from "vitest";
import { extractOtpCode } from "./otp.js";

describe("extractOtpCode", () => {
  it("finds codes near the word 'code'", () => {
    expect(extractOtpCode("Your REALM verification code is 482913.")).toBe("482913");
    expect(extractOtpCode("Use code 7291 to sign in")).toBe("7291");
    expect(extractOtpCode("948123 is your security code")).toBe("948123");
  });
  it("falls back to a bare 6-digit number", () => {
    expect(extractOtpCode("REALM: 553201")).toBe("553201");
  });
  it("ignores phone numbers and unrelated digits", () => {
    expect(extractOtpCode("Call us at 416 555 0199 ext 12")).toBeNull();
    expect(extractOtpCode("no digits here")).toBeNull();
  });
});
