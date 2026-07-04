import { describe, expect, it } from "vitest";
import { parseAddress, extractPlainText } from "./poller.js";

describe("parseAddress", () => {
  it("parses 'Name <email>' form", () => {
    expect(parseAddress('Jane Buyer <Jane@Example.com>')).toEqual({
      name: "Jane Buyer",
      email: "jane@example.com",
    });
  });
  it("parses quoted names", () => {
    expect(parseAddress('"Buyer, Jane" <j@x.com>')).toEqual({ name: "Buyer, Jane", email: "j@x.com" });
  });
  it("parses bare addresses", () => {
    expect(parseAddress("j@x.com")).toEqual({ name: null, email: "j@x.com" });
  });
  it("returns nulls for junk", () => {
    expect(parseAddress("not an address")).toEqual({ name: null, email: null });
  });
});

describe("extractPlainText", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");

  it("reads a top-level text/plain body", () => {
    expect(extractPlainText({ mimeType: "text/plain", body: { data: b64("hello") } })).toBe("hello");
  });

  it("finds text/plain inside multipart parts", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64("<b>hi</b>") } },
        { mimeType: "text/plain", body: { data: b64("hi there") } },
      ],
    };
    expect(extractPlainText(payload)).toBe("hi there");
  });

  it("falls back to stripped html", () => {
    const payload = { mimeType: "text/html", body: { data: b64("<p>Hello <b>world</b></p>") } };
    expect(extractPlainText(payload)).toBe("Hello world");
  });

  it("returns empty string for empty payloads", () => {
    expect(extractPlainText(undefined)).toBe("");
    expect(extractPlainText({})).toBe("");
  });
});
