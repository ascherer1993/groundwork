import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement, NonDeleted } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { isTauri } from "../api/transport";
import { iconShapes, type Point } from "./canvasIcons";

/**
 * Canvases (PLAN §5.17): what the canvas view does beyond Excalidraw itself.
 * Only the (lazily loaded) canvas view imports this, so Excalidraw stays out
 * of the app's first load.
 */

/** Room left around a drawing when it's copied or exported, in canvas pixels. */
export const EXPORT_PADDING = 24;
/** Exports are drawn at twice their size, so they stay sharp on Retina screens and in Slack. */
const EXPORT_SCALE = 2;

export type ImageType = "png" | "jpeg";

/**
 * What a copy or export takes: the selection when there is one (with the
 * text inside selected shapes), else the whole drawing.
 */
export function elementsToExport(api: ExcalidrawImperativeAPI): NonDeleted<ExcalidrawElement>[] {
  const all = api.getSceneElements();
  const selected = api.getAppState().selectedElementIds;
  if (!Object.keys(selected).length) return [...all];
  const picked = all.filter(
    (el) => selected[el.id] || ("containerId" in el && el.containerId && selected[el.containerId]),
  );
  return picked.length ? picked : [...all];
}

/**
 * The drawing as an image: only where something is drawn, plus a margin.
 * Always light on its own background, whatever the canvas shows, so it reads
 * well wherever it's pasted.
 */
export function canvasImage(api: ExcalidrawImperativeAPI, type: ImageType): Promise<Blob> {
  const elements = elementsToExport(api);
  if (!elements.length) return Promise.reject(new Error("Nothing drawn yet"));
  return exportToBlob({
    elements,
    files: api.getFiles(),
    appState: {
      ...api.getAppState(),
      exportBackground: true,
      exportWithDarkMode: false,
    },
    exportPadding: EXPORT_PADDING,
    getDimensions: (width: number, height: number) => ({
      width: width * EXPORT_SCALE,
      height: height * EXPORT_SCALE,
      scale: EXPORT_SCALE,
    }),
    mimeType: type === "png" ? "image/png" : "image/jpeg",
    ...(type === "jpeg" ? { quality: 0.92 } : {}),
  });
}

/** Puts the drawing on the clipboard as a PNG, to paste into Slack and the like. */
export async function copyCanvasImage(api: ExcalidrawImperativeAPI): Promise<void> {
  if (!elementsToExport(api).length) throw new Error("Nothing drawn yet");
  // The item is made at once, with the image to come, so Safari's WebKit still
  // counts the write as part of the click.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": canvasImage(api, "png") })]);
}

/**
 * Saves the drawing as an image where you choose (the desktop app asks with
 * the system's dialog; the browser downloads it). False if cancelled.
 */
export async function exportCanvasImage(
  api: ExcalidrawImperativeAPI,
  type: ImageType,
  baseName: string,
): Promise<boolean> {
  const blob = await canvasImage(api, type);
  const ext = type === "png" ? "png" : "jpg";
  const fileName = `${baseName.replace(/[/\\:]/g, "-")}.${ext}`;
  if (!isTauri()) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const { downloadDir, join } = await import("@tauri-apps/api/path");
  const { invoke } = await import("@tauri-apps/api/core");
  const path = await save({
    title: `Export ${type.toUpperCase()}`,
    defaultPath: await join(await downloadDir(), fileName),
    filters: [{ name: type.toUpperCase(), extensions: type === "png" ? ["png"] : ["jpg", "jpeg"] }],
  });
  if (!path) return false;
  await invoke("save_image", new Uint8Array(await blob.arrayBuffer()), {
    headers: { "x-path": encodeURIComponent(path) },
  });
  return true;
}

// ---- Icons -----------------------------------------------------------------

/** How big a new icon is on the canvas. */
export const ICON_SIZE = 64;

/**
 * Puts an icon in the middle of what's on screen, as one group of shapes in
 * the current stroke colour, and selects it.
 */
export function insertIcon(api: ExcalidrawImperativeAPI, name: string): void {
  const shapes = iconShapes(name);
  if (!shapes.length) return;
  const state = api.getAppState();
  const centre = viewportCoordsToSceneCoords(
    {
      clientX: state.offsetLeft + state.width / 2,
      clientY: state.offsetTop + state.height / 2,
    },
    state,
  );
  const scale = ICON_SIZE / 24;
  const left = centre.x - ICON_SIZE / 2;
  const top = centre.y - ICON_SIZE / 2;
  const group = `icon-${Math.random().toString(36).slice(2, 10)}`;
  const common = {
    strokeColor: state.currentItemStrokeColor,
    backgroundColor: "transparent",
    strokeWidth: 2,
    roughness: 0,
    opacity: state.currentItemOpacity,
    groupIds: [group],
    customData: { icon: name },
  };
  const at = (p: Point): [number, number] => [left + p[0] * scale, top + p[1] * scale];
  const skeletons: ExcalidrawElementSkeleton[] = shapes.map((shape) => {
    if (shape.kind === "line") {
      const points = shape.points.map(at);
      const [x0, y0] = points[0]!;
      const relative = points.map(([x, y]) => [x - x0, y - y0]);
      const xs = relative.map((p) => p[0]!);
      const ys = relative.map((p) => p[1]!);
      return {
        type: "line",
        x: x0,
        y: y0,
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
        points: relative,
        roundness: null,
        ...common,
      } as ExcalidrawElementSkeleton;
    }
    const [x, y] = at([shape.x, shape.y]);
    return {
      type: shape.kind,
      x,
      y,
      width: shape.width * scale,
      height: shape.height * scale,
      roundness: shape.kind === "rectangle" && shape.round ? { type: 3 } : null,
      ...common,
    } as ExcalidrawElementSkeleton;
  });
  const added = convertToExcalidrawElements(skeletons);
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), ...added],
    appState: {
      selectedElementIds: Object.fromEntries(added.map((el) => [el.id, true])),
      selectedGroupIds: { [group]: true },
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}
