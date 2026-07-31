import { describe, expect, it } from "vitest";

import { parseDesktopCustomization } from "./customization";

describe("desktop customization metadata", () => {
  it("recognizes a stamped customized build", () => {
    expect(
      parseDesktopCustomization({
        paseoCustomized: true,
        paseoCustomizationOwner: " shasderias ",
      }),
    ).toEqual({
      customized: true,
      owner: "shasderias",
    });
  });

  it("does not trust an owner without the customization stamp", () => {
    expect(parseDesktopCustomization({ paseoCustomizationOwner: "shasderias" })).toEqual({
      customized: false,
      owner: null,
    });
  });

  it("allows a customized build without an owner", () => {
    expect(parseDesktopCustomization({ paseoCustomized: true })).toEqual({
      customized: true,
      owner: null,
    });
  });
});
