import { describe, expect, it } from "vitest";
import { parseTaskMeta, taskMetaHtml } from "./tasks";

describe("parseTaskMeta", () => {
  it("finds priority, dates and recurrence, and where they are", () => {
    const text = " Ask [[Jane Doe]] ⏫ 📅 2026-11-05 🔁 every week ➕ 2026-11-03 ^t1";
    const { meta, ranges } = parseTaskMeta(text);
    expect(meta).toEqual({
      priority: 1,
      due: "2026-11-05",
      recurrence: "every week",
      created: "2026-11-03",
    });
    let rest = text;
    for (const r of [...ranges].reverse()) rest = rest.slice(0, r.from) + rest.slice(r.to);
    expect(rest).toBe(" Ask [[Jane Doe]] ^t1");
  });

  it("leaves tasks without metadata alone", () => {
    expect(parseTaskMeta(" Buy milk #errand")).toEqual({ meta: {}, ranges: [] });
  });
});

describe("taskMetaHtml", () => {
  const now = new Date(2026, 10, 3, 15, 0);
  const text = (html: string) => html.replace(/<[^>]+>/g, "");

  it("lists priority first and uses friendly dates", () => {
    const html = taskMetaHtml({ priority: 1, due: "2026-11-04", created: "2026-11-03" }, true, now);
    expect(text(html)).toBe("P1 · Due tomorrow · Created today");
  });

  it("flags overdue open tasks only", () => {
    expect(taskMetaHtml({ due: "2026-11-01" }, true, now)).toContain("is-overdue");
    expect(text(taskMetaHtml({ due: "2026-11-01" }, true, now))).toBe("Overdue Sun, Nov 1");
    const done = taskMetaHtml({ due: "2026-11-01", done: "2026-11-02" }, false, now);
    expect(done).not.toContain("is-overdue");
    expect(text(done)).toBe("Due Sun, Nov 1 · Done yesterday");
  });

  it("shows the year only when it differs", () => {
    expect(text(taskMetaHtml({ due: "2027-01-15" }, true, now))).toBe("Due Jan 15, 2027");
    expect(text(taskMetaHtml({ due: "2026-12-20" }, true, now))).toBe("Due Dec 20");
  });
});
