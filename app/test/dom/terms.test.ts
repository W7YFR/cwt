/* The agreement to the terms, kept in the browser. */

import { beforeEach, describe, expect, it } from "vitest";
import { TERMS_VERSION, agree, agreed } from "@/terms";

describe("the agreement to the terms", () => {
  beforeEach(() => localStorage.clear());

  it("holds none until you agree, and records the terms and app versions", () => {
    expect(agreed()).toBe(false);
    agree("1.2.3");
    expect(agreed()).toBe(true);
    expect(JSON.parse(localStorage.getItem("cwt:terms")!)).toEqual({ terms: TERMS_VERSION, app: "1.2.3" });
  });

  it("holds none for older terms, or for what it cannot read", () => {
    localStorage.setItem("cwt:terms", JSON.stringify({ terms: TERMS_VERSION - 1, app: "1.0.0" }));
    expect(agreed()).toBe(false);
    localStorage.setItem("cwt:terms", "not json");
    expect(agreed()).toBe(false);
  });
});
