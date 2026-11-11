import "../lib/canvasAssets";
import "@excalidraw/excalidraw/index.css";
import {
  CaptureUpdateAction,
  Excalidraw,
  hashElementsVersion,
  isElementLink,
  MainMenu,
  restore,
  serializeAsJSON,
  WelcomeScreen,
} from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import { ClipboardCopy, ImageDown, Shapes } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { copyCanvasImage, exportCanvasImage, type ImageType } from "../lib/canvas";
import { openExternalUrl } from "../lib/fileUrl";
import { useCanvasTheme } from "../state/canvas";
import { useUi } from "../state/ui";
import { message, onVaultChange } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { IconPicker } from "./IconPicker";

/**
 * A canvas (PLAN §5.17): an Excalidraw drawing kept in a `.excalidraw` file.
 * Edits save a moment after you stop; changes made elsewhere show up when
 * there's nothing unsaved here.
 */

type Scene = {
  elements: readonly OrderedExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

/** Saves still on their way to disk, so a view opening the file waits for them. */
const writing = new Map<string, Promise<unknown>>();

/** How long after the last change a canvas saves. */
const SAVE_DELAY = 300;

const LIBRARY_KEY = "groundwork.canvasLibrary";

function loadLibrary(): LibraryItems {
  try {
    return JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "[]") as LibraryItems;
  } catch {
    return [];
  }
}

function saveLibrary(items: LibraryItems) {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(items));
  } catch {
    // Only this session keeps it.
  }
}

/** A file's drawing; an empty file is an empty canvas. */
function parseScene(text: string): Scene {
  if (!text.trim()) return { elements: [], appState: {}, files: {} };
  const data = JSON.parse(text) as { type?: string };
  if (data.type !== "excalidraw") throw new Error("This file isn’t an Excalidraw drawing.");
  const restored = restore(data as Parameters<typeof restore>[0], null, null);
  return { elements: restored.elements, appState: restored.appState, files: restored.files };
}

function serialize(scene: Scene): string {
  const live = scene.elements.filter((el) => !el.isDeleted);
  return serializeAsJSON(live, scene.appState, scene.files, "local");
}

/** Changes only to the view (scrolling, zooming, selecting) don't count. */
function contentKey(scene: Scene): string {
  const { viewBackgroundColor, gridModeEnabled, gridSize, gridStep } = scene.appState;
  return [
    hashElementsVersion(scene.elements),
    Object.keys(scene.files).length,
    viewBackgroundColor,
    gridModeEnabled,
    gridSize,
    gridStep,
  ].join("|");
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.excalidraw$/i, "");
}

export default function CanvasView({ path }: { path: string }) {
  const [initial, setInitial] = useState<ExcalidrawInitialDataState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [picking, setPicking] = useState(false);
  const theme = useCanvasTheme();
  /** Where the file is now (it may have been renamed while open). */
  const pathRef = useRef(path);
  const latest = useRef<Scene | null>(null);
  /** The content last saved or loaded: its key, its serialized form, and the file's text. */
  const saved = useRef({ key: "", json: "", text: "" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const scene = latest.current;
    if (!scene) return;
    const key = contentKey(scene);
    if (key === saved.current.key) return;
    const json = serialize(scene);
    // Versions bumped with nothing changed (fonts loading re-measure text, say).
    if (json === saved.current.json) {
      saved.current = { ...saved.current, key };
      return;
    }
    saved.current = { key, json, text: json };
    const target = pathRef.current;
    const write = api
      .writeFile(target, json)
      .catch((err) => useUi.getState().notify(`Couldn’t save the canvas: ${message(err)}`))
      .finally(() => {
        if (writing.get(target) === write) writing.delete(target);
      });
    writing.set(target, write);
  }, []);

  // Load the file, after any save still being written.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await writing.get(path);
        const file = await api.readFile(path);
        if (cancelled) return;
        const text = file.text ?? "";
        const scene = parseScene(text);
        latest.current = scene;
        saved.current = { key: contentKey(scene), json: serialize(scene), text };
        setInitial({ ...scene, scrollToContent: true, libraryItems: loadLibrary() });
      } catch (err) {
        if (!cancelled) setError(message(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Follow renames, and show changes made elsewhere (Claude, Obsidian, git).
  useEffect(
    () =>
      onVaultChange((changes) => {
        for (const c of changes) {
          if (c.kind === "moved" && c.from === pathRef.current) pathRef.current = c.path;
          // Deleted: don't write it back.
          if (c.kind === "removed" && c.path === pathRef.current) {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            latest.current = null;
          }
          if (c.kind === "modified" && c.path === pathRef.current && excalidraw) {
            void (async () => {
              const file = await api.readFile(c.path).catch(() => null);
              const text = file?.text ?? "";
              // Our own save, or edits here that haven't been saved yet.
              if (!file || text === saved.current.text || timer.current) return;
              let scene: Scene;
              try {
                scene = parseScene(text);
              } catch {
                return;
              }
              latest.current = scene;
              saved.current = { key: contentKey(scene), json: serialize(scene), text };
              excalidraw.addFiles(Object.values(scene.files));
              excalidraw.updateScene({
                elements: scene.elements,
                appState: {
                  viewBackgroundColor: scene.appState.viewBackgroundColor ?? "#ffffff",
                  gridModeEnabled: scene.appState.gridModeEnabled ?? false,
                },
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            })();
          }
        }
      }),
    [excalidraw],
  );

  // Save what's unsaved when the tab closes or shows another file.
  useEffect(() => () => flush(), [flush]);

  const onChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      const scene = { elements, appState, files };
      latest.current = scene;
      if (contentKey(scene) === saved.current.key) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY);
    },
    [flush],
  );

  const copy = useCallback(async () => {
    if (!excalidraw) return;
    try {
      await copyCanvasImage(excalidraw);
      useUi.getState().notify("Copied the drawing as an image");
    } catch (err) {
      useUi.getState().notify(message(err));
    }
  }, [excalidraw]);

  const exportAs = useCallback(
    async (type: ImageType) => {
      if (!excalidraw) return;
      try {
        if (await exportCanvasImage(excalidraw, type, baseName(pathRef.current)))
          useUi.getState().notify(`Exported the drawing as ${type === "png" ? "PNG" : "JPEG"}`);
      } catch (err) {
        useUi.getState().notify(message(err));
      }
    },
    [excalidraw],
  );

  if (error) {
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }
  if (!initial) return <div className="loading" aria-busy="true" />;
  return (
    <div className="canvas-view" data-testid="canvas">
      <Excalidraw
        initialData={initial}
        excalidrawAPI={setExcalidraw}
        onChange={onChange}
        theme={theme}
        name={baseName(path)}
        aiEnabled={false}
        // Nothing on a canvas reaches out to the web (no embedded videos or tweets).
        validateEmbeddable={() => false}
        onLibraryChange={saveLibrary}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            toggleTheme: false,
          },
        }}
        onLinkOpen={(element, event) => {
          const link = element.link;
          if (!link || isElementLink(link)) return;
          event.preventDefault();
          if (/^[a-z][a-z0-9+.-]*:/i.test(link)) void openExternalUrl(link);
          else void useWorkspace.getState().openLink(pathRef.current, link);
        }}
        renderTopRightUI={() => (
          <div className="canvas-tools">
            <button
              type="button"
              className={`canvas-tool${picking ? " active" : ""}`}
              aria-label="Icons"
              aria-pressed={picking}
              title="Icons"
              onClick={() => setPicking((p) => !p)}
            >
              <Shapes size={16} />
            </button>
            <button
              type="button"
              className="canvas-tool"
              aria-label="Copy as image"
              title="Copy as image (the selection, or everything drawn)"
              onClick={() => void copy()}
            >
              <ClipboardCopy size={16} />
            </button>
            <button
              type="button"
              className="canvas-tool"
              aria-label="Export image"
              title="Export as PNG or JPEG"
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                useUi.getState().showMenu(box.left, box.bottom + 4, [
                  { label: "Export PNG…", action: () => void exportAs("png") },
                  { label: "Export JPEG…", action: () => void exportAs("jpeg") },
                ]);
              }}
            >
              <ImageDown size={16} />
            </button>
            {picking && excalidraw && (
              <IconPicker excalidraw={excalidraw} onClose={() => setPicking(false)} />
            )}
          </div>
        )}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.CommandPalette />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Hints.MenuHint />
          <WelcomeScreen.Hints.ToolbarHint />
          <WelcomeScreen.Hints.HelpHint />
        </WelcomeScreen>
      </Excalidraw>
    </div>
  );
}
