import type { ApiError } from "./generated/ApiError";
import type { ErrorCode } from "./generated/ErrorCode";
import type { Event } from "./generated/Event";
import type { Request } from "./generated/Request";

/** Carries a backend `ApiError` as a throwable. */
export class ApiCallError extends Error {
  readonly code: ErrorCode;

  constructor(error: ApiError) {
    super(error.message);
    this.name = "ApiCallError";
    this.code = error.code;
  }
}

export type EventListener = (event: Event) => void;

export interface Transport {
  call(request: Request): Promise<unknown>;
  /** Subscribes to backend events. Returns an unsubscribe function. */
  listen(listener: EventListener): () => void;
  /** Called after the connection to the backend was lost and restored. */
  onReconnect(listener: () => void): () => void;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && "code" in value && "message" in value;
}

/** Desktop app: Tauri IPC into the `api` command; events on one Tauri channel. */
export class TauriTransport implements Transport {
  private listeners = new Set<EventListener>();
  private subscribed = false;

  async call(request: Request): Promise<unknown> {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      return await invoke("api", { request });
    } catch (err) {
      throw isApiError(err) ? new ApiCallError(err) : err;
    }
  }

  listen(listener: EventListener): () => void {
    this.listeners.add(listener);
    if (!this.subscribed) {
      this.subscribed = true;
      void import("@tauri-apps/api/event").then(({ listen }) =>
        listen<Event>("groundwork://event", (e) => {
          for (const l of this.listeners) l(e.payload);
        }),
      );
    }
    return () => this.listeners.delete(listener);
  }

  onReconnect(): () => void {
    // IPC never disconnects.
    return () => {};
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };

/**
 * Browser mode: the same requests over the dev server's WebSocket. Connects
 * eagerly so events arrive, and reconnects with backoff when the server restarts.
 */
export class WebSocketTransport implements Transport {
  private socket: Promise<WebSocket> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private listeners = new Set<EventListener>();
  private reconnectListeners = new Set<() => void>();
  private retryDelay = 250;
  private hadConnection = false;

  constructor(private readonly url: string) {}

  async call(request: Request): Promise<unknown> {
    const socket = await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, request }));
    });
  }

  listen(listener: EventListener): () => void {
    this.listeners.add(listener);
    void this.connect().catch(() => {});
    return () => this.listeners.delete(listener);
  }

  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  private connect(): Promise<WebSocket> {
    if (this.socket) return this.socket;
    this.socket = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.onopen = () => {
        this.retryDelay = 250;
        if (this.hadConnection) for (const l of this.reconnectListeners) l();
        this.hadConnection = true;
        resolve(ws);
      };
      ws.onerror = () =>
        reject(
          new ApiCallError({
            code: "internal",
            message: `can't reach the dev server at ${this.url} (is it running?)`,
          }),
        );
      ws.onclose = () => {
        this.socket = null;
        for (const { reject } of this.pending.values()) {
          reject(new ApiCallError({ code: "internal", message: "connection to dev server lost" }));
        }
        this.pending.clear();
        if (this.listeners.size > 0) this.scheduleReconnect();
      };
      ws.onmessage = (event) => this.receive(String(event.data));
    });
    return this.socket;
  }

  private scheduleReconnect() {
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 5000);
    setTimeout(() => void this.connect().catch(() => {}), delay);
  }

  private receive(data: string) {
    const message = JSON.parse(data) as
      Event | { id: number | null; result?: unknown; error?: ApiError };
    if ("event" in message) {
      for (const l of this.listeners) l(message);
      return;
    }
    if (message.id === null) {
      console.error("dev server rejected a message", message.error);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new ApiCallError(message.error));
    else pending.resolve(message.result);
  }
}
