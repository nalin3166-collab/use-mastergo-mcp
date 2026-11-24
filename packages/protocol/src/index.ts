export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_BRIDGE_HOST = "127.0.0.1" as const;
export const DEFAULT_BRIDGE_PORT = 8787 as const;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000 as const;
export const MAX_REQUEST_TIMEOUT_MS = 300_000 as const;

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

export interface PageSummary {
  id: string;
  name: string;
  childCount: number;
  isCurrent: boolean;
}

export interface SelectionNodeSummary {
  id: string;
  name: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface DocumentSnapshot {
  id: string;
  name: string;
  currentPageId: string;
  currentPageName: string;
  pages: PageSummary[];
  selection: SelectionNodeSummary[];
}

export interface PluginCapabilities {
  dynamicEval: boolean;
  apiVersion?: string;
}

export interface StatusResult {
  connected: true;
  pluginVersion: string;
  capabilities: PluginCapabilities;
  document: DocumentSnapshot;
}

export interface ExecuteParams {
  code: string;
  description: string;
  timeoutMs?: number;
}

export interface ExecuteResult {
  value: unknown;
  logs: string[];
  durationMs: number;
}

export interface UploadImagePayload {
  key: string;
  mimeType: string;
  base64: string;
  width?: number;
  height?: number;
}

export interface UploadImagesParams {
  images: UploadImagePayload[];
}

export interface UploadedImageInfo {
  imageRef: string;
  width?: number;
  height?: number;
}

export interface UploadImagesResult {
  results: Record<string, UploadedImageInfo>;
  errors: Record<string, string>;
}

export interface ScreenshotNodeParams {
  nodeId: string;
  scale?: number;
  format?: "PNG" | "JPG" | "WEBP";
}

export interface ScreenshotNodeResult {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  width: number;
  height: number;
  format: "PNG" | "JPG" | "WEBP";
  scale: number;
  base64: string;
  byteLength: number;
}

export interface BridgeMethodMap {
  status: {
    params: Record<string, never>;
    result: StatusResult;
  };
  execute: {
    params: ExecuteParams;
    result: ExecuteResult;
  };
  upload_images: {
    params: UploadImagesParams;
    result: UploadImagesResult;
  };
  screenshot_node: {
    params: ScreenshotNodeParams;
    result: ScreenshotNodeResult;
  };
}

export type BridgeMethod = keyof BridgeMethodMap;

export interface BridgeRequestMessage<M extends BridgeMethod = BridgeMethod> {
  type: "request";
  requestId: string;
  method: M;
  params: BridgeMethodMap[M]["params"];
  timeoutMs: number;
}

export interface BridgeResponseSuccessMessage {
  type: "response";
  requestId: string;
  ok: true;
  result: unknown;
  durationMs: number;
}

export interface BridgeResponseErrorMessage {
  type: "response";
  requestId: string;
  ok: false;
  error: SerializedError;
  logs?: string[];
  durationMs: number;
}

export type BridgeResponseMessage =
  | BridgeResponseSuccessMessage
  | BridgeResponseErrorMessage;

export interface BridgeHelloMessage {
  type: "hello";
  protocolVersion: number;
  pluginVersion: string;
  capabilities: PluginCapabilities;
  document?: DocumentSnapshot;
}

export interface BridgeWelcomeMessage {
  type: "welcome";
  protocolVersion: number;
  serverVersion: string;
  port: number;
}

export interface BridgePingMessage {
  type: "ping";
  ts: number;
}

export interface BridgePongMessage {
  type: "pong";
  ts: number;
}

export type ServerToPluginMessage =
  | BridgeWelcomeMessage
  | BridgeRequestMessage
  | BridgePingMessage;

export type PluginToServerMessage =
  | BridgeHelloMessage
  | BridgeResponseMessage
  | BridgePongMessage;

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown };
    return {
      name: error.name || "Error",
      message: error.message || String(error),
      stack: error.stack,
      code: typeof withCode.code === "string" ? withCode.code : undefined,
    };
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name : "Error",
      message:
        typeof record.message === "string"
          ? record.message
          : safeStringify(error),
      stack: typeof record.stack === "string" ? record.stack : undefined,
      code: typeof record.code === "string" ? record.code : undefined,
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

/**
 * Converts arbitrary JS return values from plugin scripts into JSON-safe structures
 * without throwing on circular references, BigInt, Symbols, or typed arrays.
 */
export function toJsonSafeValue(value: unknown, maxDepth = 8): unknown {
  const seen = new WeakSet<object>();

  function visit(current: unknown, depth: number): unknown {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? current : String(current);
    }
    if (typeof current === "undefined") {
      return null;
    }
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (typeof current === "symbol" || typeof current === "function") {
      return `[${typeof current}]`;
    }
    if (current instanceof Date) {
      return current.toISOString();
    }
    if (current instanceof Uint8Array) {
      return `[Uint8Array(${current.byteLength})]`;
    }
    if (current instanceof Error) {
      return serializeError(current);
    }
    if (typeof current !== "object") {
      return String(current);
    }
    if (seen.has(current)) {
      return "[Circular]";
    }
    if (depth >= maxDepth) {
      return Array.isArray(current)
        ? `[Array(${current.length})]`
        : "[Object]";
    }
    seen.add(current);

    if (Array.isArray(current)) {
      return current.map((item) => visit(item, depth + 1));
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(current as Record<string, unknown>)) {
      try {
        out[key] = visit((current as Record<string, unknown>)[key], depth + 1);
      } catch (err) {
        out[key] = `[Unreadable: ${serializeError(err).message}]`;
      }
    }
    return out;
  }

  return visit(value, 0);
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(toJsonSafeValue(value));
  } catch {
    return String(value);
  }
}
