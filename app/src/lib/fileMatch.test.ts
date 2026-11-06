import { describe, expect, it } from "vitest";
import { nameQuery } from "./fileMatch";

describe("nameQuery", () => {
  it("keeps the words and drops what only searches text", () => {
    expect(nameQuery('vendor "kick off" -draft #legal')).toEqual({ words: "vendor kick off" });
  });
  it("returns a path to narrow by", () => {
    expect(nameQuery("kickoff path:Projects/Acme")).toEqual({
      words: "kickoff",
      path: "Projects/Acme",
    });
    expect(nameQuery("#waiting")).toEqual({ words: "" });
  });
});
