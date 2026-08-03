import { describe, expect, it } from "vitest";
import { parseAddressQuery } from "./reso.js";

describe("parseAddressQuery", () => {
  it("removes street suffix, direction, unit and province text from PropTx display addresses", () => {
    expect(parseAddressQuery("4168 Finch Avenue E PH27, Toronto, ON M1S 3V1")).toEqual({
      streetNumber: "4168",
      streetName: "Finch",
      city: "Toronto",
    });
  });

  it("preserves multi-word street names", () => {
    expect(parseAddressQuery("55 St Clair Avenue W, Toronto")).toEqual({
      streetNumber: "55",
      streetName: "St Clair",
      city: "Toronto",
    });
  });

  it("still handles a simple municipality address", () => {
    expect(parseAddressQuery("12 Maple Dr, Vaughan")).toEqual({
      streetNumber: "12",
      streetName: "Maple",
      city: "Vaughan",
    });
  });
});
