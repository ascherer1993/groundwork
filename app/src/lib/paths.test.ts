import { describe, expect, it } from "vitest";
import { ancestors, displayName } from "./paths";

describe("displayName", () => {
  it("drops .md from notes", () => {
    expect(displayName("Fix login.md", "note")).toEqual({ base: "Fix login", ext: "" });
  });

  it("keeps other extensions, split out", () => {
    expect(displayName("sketch.html", "page")).toEqual({ base: "sketch", ext: ".html" });
    expect(displayName("login-flow.page", "pageBundle")).toEqual({
      base: "login-flow",
      ext: ".page",
    });
  });

  it("leaves folders and dotless names alone", () => {
    expect(displayName("v1.2 notes", "folder")).toEqual({ base: "v1.2 notes", ext: "" });
    expect(displayName("Makefile", "asset")).toEqual({ base: "Makefile", ext: "" });
  });
});

describe("ancestors", () => {
  it("lists parent folders outermost first", () => {
    expect(ancestors("Projects/Acme/Work/T.md")).toEqual([
      "Projects",
      "Projects/Acme",
      "Projects/Acme/Work",
    ]);
    expect(ancestors("Welcome.md")).toEqual([]);
  });
});
