import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { icons, type LucideIcon } from "lucide-react";

/**
 * Icons for canvases (PLAN §5.17): Lucide's, turned into ordinary canvas
 * shapes (lines, ellipses, rectangles in one group) rather than pictures, so
 * they take the canvas's colours, follow dark mode, and can be recoloured and
 * resized like anything else drawn.
 */

/** The icons a software engineer reaches for, shown before any search. */
export const COMMON_ICONS = [
  "Server",
  "Database",
  "Cloud",
  "CloudUpload",
  "CloudDownload",
  "HardDrive",
  "Cpu",
  "MemoryStick",
  "Network",
  "Router",
  "Wifi",
  "Globe",
  "Laptop",
  "Monitor",
  "Smartphone",
  "Tablet",
  "User",
  "Users",
  "UserCog",
  "Bot",
  "Lock",
  "LockOpen",
  "Key",
  "Shield",
  "ShieldCheck",
  "FingerprintPattern",
  "Code",
  "Terminal",
  "Braces",
  "FileCode",
  "FileBraces",
  "File",
  "FileText",
  "Folder",
  "GitBranch",
  "GitCommitHorizontal",
  "GitMerge",
  "GitPullRequest",
  "Bug",
  "Settings",
  "Wrench",
  "Package",
  "Boxes",
  "Container",
  "Layers",
  "Workflow",
  "Webhook",
  "Plug",
  "Link",
  "Zap",
  "Activity",
  "Gauge",
  "ChartBar",
  "ChartLine",
  "ChartPie",
  "Table",
  "List",
  "Mail",
  "MessageSquare",
  "Bell",
  "Send",
  "Inbox",
  "Calendar",
  "Clock",
  "Timer",
  "Search",
  "Funnel",
  "RefreshCw",
  "Repeat",
  "ArrowRightLeft",
  "Split",
  "Merge",
  "Check",
  "X",
  "CircleCheck",
  "CircleX",
  "TriangleAlert",
  "Info",
  "CircleQuestionMark",
  "Ban",
  "Star",
  "Heart",
  "Flag",
  "Lightbulb",
  "Rocket",
  "Target",
  "Sparkles",
  "Brain",
  "Puzzle",
  "Eye",
  "Upload",
  "Download",
  "Trash",
  "Pencil",
  "Copy",
  "Image",
  "Camera",
  "Video",
  "Mic",
  "Phone",
  "CreditCard",
  "ShoppingCart",
  "Building",
  "House",
  "Store",
  "MapPin",
  "Printer",
  "QrCode",
  "Binary",
  "Hash",
  "AtSign",
  "Rss",
  "Power",
  "SlidersHorizontal",
  "LayoutDashboard",
  "LayoutGrid",
  "AppWindow",
  "Play",
  "Pause",
] as const;

const ALL = icons as Record<string, LucideIcon>;

export function iconComponent(name: string): LucideIcon | undefined {
  return ALL[name];
}

/** "CloudUpload" → "cloud upload": how icons are searched and labelled. */
export function iconLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
}

/**
 * Icons whose name has every word of `query`, common ones first; the common
 * set when the query is empty.
 */
export function searchIcons(query: string, limit = 120): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...COMMON_ICONS];
  const matches = (name: string) => {
    const label = iconLabel(name).replace(/\s+/g, "");
    return words.every((w) => label.includes(w));
  };
  const common = COMMON_ICONS.filter(matches);
  const seen = new Set<string>(common);
  const rest = Object.keys(ALL).filter((n) => !seen.has(n) && matches(n));
  return [...common, ...rest].slice(0, limit);
}

// ---- Turning an icon into shapes ------------------------------------------

export type Point = [number, number];

/** A polyline split wherever consecutive points are further apart than `gap`. */
export function splitAtJumps(points: Point[], gap: number): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (const p of points) {
    const last = run[run.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) > gap) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
    : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Ramer–Douglas–Peucker: fewer points, none moved further than `epsilon`. */
export function simplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  let furthest = 0;
  let at = 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distanceToSegment(points[i]!, first, last);
    if (d > furthest) [furthest, at] = [d, i];
  }
  if (furthest <= epsilon) return [first, last];
  const left = simplify(points.slice(0, at + 1), epsilon);
  return [...left.slice(0, -1), ...simplify(points.slice(at), epsilon)];
}

/** A shape in an icon's 24×24 box, before it's placed on a canvas. */
export type IconShape =
  | { kind: "line"; points: Point[] }
  | { kind: "ellipse"; x: number; y: number; width: number; height: number }
  | { kind: "rectangle"; x: number; y: number; width: number; height: number; round: boolean };

const num = (el: Element, attr: string) => Number(el.getAttribute(attr) ?? 0);

function pointsAttr(el: Element): Point[] {
  const values = (el.getAttribute("points") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const points: Point[] = [];
  for (let i = 0; i + 1 < values.length; i += 2) points.push([values[i]!, values[i + 1]!]);
  return points;
}

/** Samples a path along its length (the browser does the geometry). */
function samplePath(path: SVGPathElement): Point[][] {
  const step = 0.25;
  const length = path.getTotalLength();
  const points: Point[] = [];
  for (let at = 0; at < length; at += step) {
    const p = path.getPointAtLength(at);
    points.push([p.x, p.y]);
  }
  const end = path.getPointAtLength(length);
  points.push([end.x, end.y]);
  // A move (`M`) inside the path shows as a jump between samples.
  return splitAtJumps(points, step * 3).map((run) => simplify(run, 0.03));
}

/** The shapes an icon is drawn with, in its 24×24 box. */
export function iconShapes(name: string): IconShape[] {
  const Icon = iconComponent(name);
  if (!Icon) return [];
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:-9999px;top:0;width:24px;height:24px;";
  host.innerHTML = renderToStaticMarkup(createElement(Icon, { size: 24 }));
  document.body.append(host);
  try {
    const shapes: IconShape[] = [];
    for (const el of host.querySelectorAll("svg > *")) {
      switch (el.tagName.toLowerCase()) {
        case "path":
          for (const points of samplePath(el as SVGPathElement))
            shapes.push({ kind: "line", points });
          break;
        case "line":
          shapes.push({
            kind: "line",
            points: [
              [num(el, "x1"), num(el, "y1")],
              [num(el, "x2"), num(el, "y2")],
            ],
          });
          break;
        case "polyline":
          shapes.push({ kind: "line", points: pointsAttr(el) });
          break;
        case "polygon": {
          const points = pointsAttr(el);
          if (points.length) shapes.push({ kind: "line", points: [...points, points[0]!] });
          break;
        }
        case "circle": {
          const r = num(el, "r");
          shapes.push({
            kind: "ellipse",
            x: num(el, "cx") - r,
            y: num(el, "cy") - r,
            width: 2 * r,
            height: 2 * r,
          });
          break;
        }
        case "ellipse": {
          const [rx, ry] = [num(el, "rx"), num(el, "ry")];
          shapes.push({
            kind: "ellipse",
            x: num(el, "cx") - rx,
            y: num(el, "cy") - ry,
            width: 2 * rx,
            height: 2 * ry,
          });
          break;
        }
        case "rect":
          shapes.push({
            kind: "rectangle",
            x: num(el, "x"),
            y: num(el, "y"),
            width: num(el, "width"),
            height: num(el, "height"),
            round: num(el, "rx") > 0,
          });
          break;
      }
    }
    return shapes;
  } finally {
    host.remove();
  }
}
