import { describe, expect, it } from "vitest";
import {
  COMMON_ICONS,
  iconComponent,
  iconLabel,
  type Point,
  searchIcons,
  simplify,
  splitAtJumps,
} from "./canvasIcons";

describe("icons", () => {
  it("are all real Lucide icons", () => {
    for (const name of COMMON_ICONS) expect(iconComponent(name), name).toBeDefined();
  });

  it("are labelled in words", () => {
    expect(iconLabel("CloudUpload")).toBe("cloud upload");
    expect(iconLabel("Building2")).toBe("building2");
    expect(iconLabel("QrCode")).toBe("qr code");
  });

  it("are searched by every word, common ones first", () => {
    expect(searchIcons("")).toEqual([...COMMON_ICONS]);
    const db = searchIcons("database");
    expect(db[0]).toBe("Database");
    expect(db.length).toBeGreaterThan(1);
    expect(searchIcons("git branch")).toContain("GitBranch");
    expect(searchIcons("cloud up")[0]).toBe("CloudUpload");
    expect(searchIcons("no-such-icon-anywhere")).toEqual([]);
  });
});

describe("splitAtJumps", () => {
  it("breaks a polyline where it jumps", () => {
    const points: Point[] = [
      [0, 0],
      [0.25, 0],
      [0.5, 0],
      [10, 10],
      [10.25, 10],
    ];
    expect(splitAtJumps(points, 1)).toEqual([
      [
        [0, 0],
        [0.25, 0],
        [0.5, 0],
      ],
      [
        [10, 10],
        [10.25, 10],
      ],
    ]);
  });

  it("drops lone points", () => {
    expect(
      splitAtJumps(
        [
          [0, 0],
          [5, 5],
          [5.1, 5],
        ],
        1,
      ),
    ).toEqual([
      [
        [5, 5],
        [5.1, 5],
      ],
    ]);
  });
});

describe("simplify", () => {
  it("keeps corners and drops points on straight runs", () => {
    const line: Point[] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 1],
      [3, 2],
    ];
    expect(simplify(line, 0.01)).toEqual([
      [0, 0],
      [3, 0],
      [3, 2],
    ]);
  });

  it("leaves short lines alone", () => {
    expect(simplify([[0, 0]], 1)).toEqual([[0, 0]]);
    expect(
      simplify(
        [
          [0, 0],
          [1, 1],
        ],
        1,
      ),
    ).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});
