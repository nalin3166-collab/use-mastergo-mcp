import {
  PROTOCOL_VERSION,
  safeStringify,
  serializeError,
  toJsonSafeValue,
  type BridgeHelloMessage,
  type BridgeRequestMessage,
  type BridgeResponseMessage,
  type DocumentSnapshot,
  type ExecuteParams,
  type ExecuteResult,
  type PluginCapabilities,
  type ScreenshotNodeParams,
  type ScreenshotNodeResult,
  type SelectionNodeSummary,
  type StatusResult,
  type UploadImagesParams,
  type UploadImagesResult,
} from "@use-mastergo-mcp/protocol";

const PLUGIN_VERSION = "0.1.1";

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_LOOKUP = (() => {
  const table = new Uint8Array(128);
  table.fill(255);
  for (let i = 0; i < BASE64_CHARS.length; i++) {
    table[BASE64_CHARS.charCodeAt(i)] = i;
  }
  return table;
})();

function base64ToUint8Array(base64: string): Uint8Array {
  const cleaned = base64.replace(/[\r\n\s=]/g, "");
  const len = cleaned.length;
  const byteLength = Math.floor((len * 3) / 4);
  const bytes = new Uint8Array(byteLength);

  let outIdx = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = BASE64_LOOKUP[cleaned.charCodeAt(i)] ?? 0;
    const c1 = BASE64_LOOKUP[cleaned.charCodeAt(i + 1)] ?? 0;
    const c2 = i + 2 < len ? (BASE64_LOOKUP[cleaned.charCodeAt(i + 2)] ?? 0) : 0;
    const c3 = i + 3 < len ? (BASE64_LOOKUP[cleaned.charCodeAt(i + 3)] ?? 0) : 0;

    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (outIdx < byteLength) bytes[outIdx++] = (triple >> 16) & 0xff;
    if (outIdx < byteLength) bytes[outIdx++] = (triple >> 8) & 0xff;
    if (outIdx < byteLength) bytes[outIdx++] = triple & 0xff;
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const len = bytes.length;
  let chunk = "";

  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;

    const triple = (b0 << 16) | (b1 << 8) | b2;
    chunk += BASE64_CHARS[(triple >> 18) & 0x3f];
    chunk += BASE64_CHARS[(triple >> 12) & 0x3f];
    chunk += i + 1 < len ? BASE64_CHARS[(triple >> 6) & 0x3f] : "=";
    chunk += i + 2 < len ? BASE64_CHARS[triple & 0x3f] : "=";

    if (chunk.length >= 16_384) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks.join("");
}

type AsyncFunctionCtor = new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

function getAsyncFunctionCtor(): AsyncFunctionCtor | null {
  try {
    const ctor = Object.getPrototypeOf(async function () {})
      .constructor as AsyncFunctionCtor;
    const probe = new ctor("return 1 + 1;");
    return typeof probe === "function" ? ctor : null;
  } catch {
    return null;
  }
}

const AsyncFunction = getAsyncFunctionCtor();
const CAPABILITIES: PluginCapabilities = {
  dynamicEval: AsyncFunction !== null,
  apiVersion: typeof mg.apiVersion === "string" ? mg.apiVersion : "1.0.0",
};

function summarizeSceneNode(node: SceneNode): SelectionNodeSummary {
  const summary: SelectionNodeSummary = {
    id: node.id,
    name: node.name,
    type: node.type,
  };
  if ("x" in node && typeof node.x === "number") summary.x = node.x;
  if ("y" in node && typeof node.y === "number") summary.y = node.y;
  if ("width" in node && typeof node.width === "number") summary.width = node.width;
  if ("height" in node && typeof node.height === "number") {
    summary.height = node.height;
  }
  return summary;
}

function getDocumentSnapshot(): DocumentSnapshot {
  const doc = mg.document;
  const currentPage = doc.currentPage;
  const pages = Array.isArray(doc.children) ? doc.children : [];
  const selection = Array.isArray(currentPage?.selection)
    ? currentPage.selection
    : [];
  return {
    id: String(doc?.id ?? ""),
    name: String(doc?.name ?? "Untitled"),
    currentPageId: String(currentPage?.id ?? ""),
    currentPageName: String(currentPage?.name ?? ""),
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      childCount: Array.isArray(page.children) ? page.children.length : 0,
      isCurrent: page.id === currentPage?.id,
    })),
    selection: selection.map(summarizeSceneNode),
  };
}

function buildHelloMessage(): BridgeHelloMessage {
  let document: DocumentSnapshot | undefined;
  try {
    document = getDocumentSnapshot();
  } catch (err) {
    console.error("[use-mastergo-mcp] getDocumentSnapshot error:", err);
  }
  return {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    pluginVersion: PLUGIN_VERSION,
    capabilities: CAPABILITIES,
    document,
  };
}

function postToUI(payload: Record<string, unknown>): void {
  mg.ui.postMessage(
    {
      __mgBridge: true,
      ...payload,
    },
    "*"
  );
}

async function handleStatus(): Promise<StatusResult> {
  return {
    connected: true,
    pluginVersion: PLUGIN_VERSION,
    capabilities: CAPABILITIES,
    document: getDocumentSnapshot(),
  };
}

async function handleExecute(params: ExecuteParams): Promise<ExecuteResult> {
  if (!AsyncFunction) {
    throw new Error(
      "Dynamic JavaScript execution (AsyncFunction) is disabled in this MasterGo sandbox version."
    );
  }

  const startedAt = Date.now();
  const logs: string[] = [];

  const capture =
    (level: string, forward: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const formatted = args
        .map((arg) => (typeof arg === "string" ? arg : safeStringify(arg)))
        .join(" ");
      logs.push(level === "log" ? formatted : `[${level}] ${formatted}`);
      try {
        forward(...args);
      } catch {
        // Ignore host console errors
      }
    };

  const scopedConsole = {
    log: capture("log", console.log.bind(console)),
    info: capture("info", console.info.bind(console)),
    warn: capture("warn", console.warn.bind(console)),
    error: capture("error", console.error.bind(console)),
    assert: (condition?: boolean, ...args: unknown[]) => {
      if (!condition) {
        capture("assert", console.error.bind(console))(...args);
      }
    },
    clear: () => {},
  };

  try {
    const fn = new AsyncFunction("mg", "console", params.code);
    const rawValue = await fn(mg, scopedConsole);
    try {
      mg.commitUndo();
    } catch {
      // Ignore commitUndo error for read-only scripts
    }

    return {
      value: toJsonSafeValue(rawValue),
      logs,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const enriched = new Error(serializeError(err).message) as Error & {
      __capturedLogs?: string[];
      __originalError?: unknown;
    };
    enriched.__capturedLogs = logs;
    enriched.__originalError = err;
    throw enriched;
  }
}

async function handleUploadImages(
  params: UploadImagesParams
): Promise<UploadImagesResult> {
  const results: UploadImagesResult["results"] = {};
  const errors: UploadImagesResult["errors"] = {};

  for (const item of params.images) {
    try {
      const bytes = base64ToUint8Array(item.base64);
      const imageHandle = await mg.createImage(bytes);
      results[item.key] = {
        imageRef: imageHandle.href,
        width: item.width,
        height: item.height,
      };
    } catch (err) {
      errors[item.key] = serializeError(err).message;
    }
  }

  return { results, errors };
}

async function handleScreenshotNode(
  params: ScreenshotNodeParams
): Promise<ScreenshotNodeResult> {
  const node = mg.getNodeById(params.nodeId);
  if (!node) {
    throw new Error(
      `Node "${params.nodeId}" was not found in the current MasterGo document.`
    );
  }

  if (typeof (node as ExportMixin).exportAsync !== "function") {
    throw new Error(
      `Node "${params.nodeId}" (${node.type}) does not support exportAsync().`
    );
  }

  const format = params.format ?? "PNG";
  const scale = params.scale ?? 1;
  const exported = await (node as ExportMixin).exportAsync({
    format,
    constraint: {
      type: "SCALE",
      value: scale,
    },
  });

  if (!(exported instanceof Uint8Array)) {
    throw new Error(
      `Unexpected non-binary export result for format "${format}".`
    );
  }

  const base64 = uint8ArrayToBase64(exported);
  const width = "width" in node && typeof node.width === "number" ? node.width : 0;
  const height =
    "height" in node && typeof node.height === "number" ? node.height : 0;

  return {
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    width,
    height,
    format,
    scale,
    base64,
    byteLength: exported.byteLength,
  };
}

async function dispatchBridgeRequest(request: BridgeRequestMessage): Promise<void> {
  const startedAt = Date.now();
  const label =
    request.method === "execute"
      ? (request.params as ExecuteParams).description
      : request.method;

  postToUI({
    type: "activity",
    status: "running",
    method: request.method,
    label,
  });

  try {
    let result: unknown;
    switch (request.method) {
      case "status":
        result = await handleStatus();
        break;
      case "execute":
        result = await handleExecute(request.params as ExecuteParams);
        break;
      case "upload_images":
        result = await handleUploadImages(request.params as UploadImagesParams);
        break;
      case "screenshot_node":
        result = await handleScreenshotNode(
          request.params as ScreenshotNodeParams
        );
        break;
      default:
        throw new Error(`Unsupported bridge method: "${String(request.method)}"`);
    }

    const durationMs = Date.now() - startedAt;
    const response: BridgeResponseMessage = {
      type: "response",
      requestId: request.requestId,
      ok: true,
      result,
      durationMs,
    };

    postToUI({
      type: "ws-send",
      message: response,
      activity: {
        status: "ok",
        method: request.method,
        label,
        durationMs,
      },
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const wrapped = err as {
      __capturedLogs?: string[];
      __originalError?: unknown;
    };
    const serialized = serializeError(wrapped.__originalError ?? err);
    const response: BridgeResponseMessage = {
      type: "response",
      requestId: request.requestId,
      ok: false,
      error: serialized,
      logs: wrapped.__capturedLogs,
      durationMs,
    };

    postToUI({
      type: "ws-send",
      message: response,
      activity: {
        status: "error",
        method: request.method,
        label: `${label}: ${serialized.message}`,
        durationMs,
      },
    });
  }
}

console.log("[use-mastergo-mcp] main thread booted, capabilities:", CAPABILITIES);

mg.ui.onmessage = (rawMessage: unknown) => {
  if (!rawMessage || typeof rawMessage !== "object") {
    return;
  }
  const rawRecord = rawMessage as Record<string, unknown>;
  const msg =
    rawRecord.pluginMessage && typeof rawRecord.pluginMessage === "object"
      ? (rawRecord.pluginMessage as Record<string, unknown>)
      : rawRecord;

  if (msg.type === "ui-ready" || msg.type === "request-hello") {
    postToUI({
      type: "hello-payload",
      hello: buildHelloMessage(),
    });
    return;
  }

  if (msg.type === "bridge-request" && msg.request) {
    void dispatchBridgeRequest(msg.request as BridgeRequestMessage);
  }
};

mg.showUI(__html__, {
  width: 320,
  height: 430,
  visible: true,
});

// Proactively push hello in case ui-ready fired before listener attachment
setTimeout(() => {
  try {
    postToUI({
      type: "hello-payload",
      hello: buildHelloMessage(),
    });
  } catch (err) {
    console.error("[use-mastergo-mcp] initial postToUI failed:", err);
  }
}, 250);
