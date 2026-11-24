import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  serializeError,
  type UploadImagePayload,
} from "@use-mastergo-mcp/protocol";
import {
  loadAndPrepareLocalImage,
  saveExportedScreenshot,
} from "./image-utils.js";
import {
  BridgeExecutionError,
  type MasterGoWsBridge,
} from "./ws-bridge.js";

export const SERVER_NAME = "use-mastergo-mcp";
export const SERVER_VERSION = "0.1.0";

function formatJsonText(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function formatErrorResponse(err: unknown) {
  if (err instanceof BridgeExecutionError) {
    const lines = [
      `Error (${err.remoteError.name}): ${err.remoteError.message}`,
    ];
    if (err.remoteError.stack) {
      lines.push("", "Stack:", err.remoteError.stack);
    }
    if (err.logs.length > 0) {
      lines.push("", "Captured console logs:", ...err.logs);
    }
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }

  const serialized = serializeError(err);
  const text = serialized.stack
    ? `Error (${serialized.name}): ${serialized.message}\n\n${serialized.stack}`
    : `Error (${serialized.name}): ${serialized.message}`;

  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
  };
}

export function createMasterGoMcpServer(bridge: MasterGoWsBridge): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // 1. mastergo_status
  server.tool(
    "mastergo_status",
    "Check whether the local WebSocket bridge is connected to the MasterGo desktop plugin, and inspect the active document name, pages list, current selection summary, and plugin runtime capabilities.",
    {},
    async () => {
      const conn = bridge.getConnectionInfo();
      if (!conn.connected) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatJsonText({
                connected: false,
                bridgeUrl: conn.url,
                port: conn.port,
                howToConnect: [
                  "Open your file in the MasterGo desktop client.",
                  'Load/run the local development plugin "use-mastergo-mcp Bridge" (packages/mg-plugin/dist).',
                  `Verify the plugin panel shows Connected to ${conn.url}.`,
                ],
              }),
            },
          ],
        };
      }

      try {
        const status = await bridge.request("status", {}, 15_000);
        return {
          content: [
            {
              type: "text" as const,
              text: formatJsonText({
                ...status,
                bridgeUrl: conn.url,
                port: conn.port,
                connectedAt: conn.connectedAt,
              }),
            },
          ],
        };
      } catch (err) {
        return formatErrorResponse(err);
      }
    }
  );

  // 2. use_mastergo
  server.tool(
    "use_mastergo",
    "Execute an async JavaScript snippet inside the MasterGo plugin main thread with full access to the `mg` Plugin API. Prefer batching an entire section, card grid, or full page in one script and returning a structured JSON summary (created node IDs, bounds, verification metrics).",
    {
      code: z
        .string()
        .min(1)
        .describe(
          "JavaScript async function body executed with `mg` in scope. Supports `await` and `return` (must return JSON-serializable data)."
        ),
      description: z
        .string()
        .min(1)
        .describe(
          "Short human-readable description of what this script does (shown in the MasterGo plugin activity log)."
        ),
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(MAX_REQUEST_TIMEOUT_MS)
        .optional()
        .describe(
          `Execution timeout in milliseconds (default ${DEFAULT_REQUEST_TIMEOUT_MS}, max ${MAX_REQUEST_TIMEOUT_MS}).`
        ),
    },
    async ({ code, description, timeoutMs }) => {
      try {
        const result = await bridge.request(
          "execute",
          {
            code,
            description,
            timeoutMs: timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          },
          timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
        );

        return {
          content: [
            {
              type: "text" as const,
              text: formatJsonText({
                ok: true,
                description,
                durationMs: result.durationMs,
                result: result.value,
                ...(result.logs.length > 0 ? { logs: result.logs } : {}),
              }),
            },
          ],
        };
      } catch (err) {
        return formatErrorResponse(err);
      }
    }
  );

  // 3. upload_local_images
  server.tool(
    "upload_local_images",
    "Read one or more local image files (PNG/JPG/WebP/GIF) from disk, optionally resize oversized images to keep MasterGo memory low, upload them in one batch to MasterGo via `mg.createImage()`, and return a `{ [localPath]: imageRef }` map for use in `ImagePaint` fills.",
    {
      paths: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe("List of local absolute (or workspace-relative) image file paths."),
      maxDimension: z
        .number()
        .int()
        .min(0)
        .max(8192)
        .optional()
        .describe(
          "Maximum width or height in pixels before downscaling (default 2048; set 0 to disable resizing)."
        ),
    },
    async ({ paths, maxDimension }) => {
      const limit = maxDimension ?? 2048;
      const payloads: UploadImagePayload[] = [];
      const prepDetails: Record<
        string,
        {
          resolvedPath: string;
          mimeType: string;
          originalWidth?: number;
          originalHeight?: number;
          width?: number;
          height?: number;
          originalBytes: number;
          finalBytes: number;
          resized: boolean;
        }
      > = {};
      const errors: Record<string, string> = {};

      await Promise.all(
        paths.map(async (inputPath) => {
          try {
            const prepared = await loadAndPrepareLocalImage(inputPath, limit);
            payloads.push({
              key: inputPath,
              mimeType: prepared.mimeType,
              base64: prepared.base64,
              width: prepared.width,
              height: prepared.height,
            });
            prepDetails[inputPath] = {
              resolvedPath: prepared.resolvedPath,
              mimeType: prepared.mimeType,
              originalWidth: prepared.originalWidth,
              originalHeight: prepared.originalHeight,
              width: prepared.width,
              height: prepared.height,
              originalBytes: prepared.originalBytes,
              finalBytes: prepared.finalBytes,
              resized: prepared.resized,
            };
          } catch (err) {
            errors[inputPath] = serializeError(err).message;
          }
        })
      );

      if (payloads.length === 0) {
        return {
          isError: true as const,
          content: [
            {
              type: "text" as const,
              text: formatJsonText({
                ok: false,
                images: {},
                errors,
              }),
            },
          ],
        };
      }

      try {
        const uploadRes = await bridge.request(
          "upload_images",
          { images: payloads },
          Math.max(DEFAULT_REQUEST_TIMEOUT_MS, payloads.length * 10_000)
        );

        const imagesMap: Record<string, string> = {};
        const details: Record<string, unknown> = {};

        for (const [key, info] of Object.entries(uploadRes.results)) {
          imagesMap[key] = info.imageRef;
          details[key] = {
            imageRef: info.imageRef,
            ...prepDetails[key],
          };
        }

        const mergedErrors = {
          ...errors,
          ...uploadRes.errors,
        };

        return {
          isError: Object.keys(imagesMap).length === 0,
          content: [
            {
              type: "text" as const,
              text: formatJsonText({
                ok: Object.keys(mergedErrors).length === 0,
                images: imagesMap,
                details,
                ...(Object.keys(mergedErrors).length > 0
                  ? { errors: mergedErrors }
                  : {}),
                usageHint:
                  "Apply in use_mastergo via `node.fills = [{ type: 'IMAGE', imageRef: images[path], scaleMode: 'FILL' }]`.",
              }),
            },
          ],
        };
      } catch (err) {
        return formatErrorResponse(err);
      }
    }
  );

  // 4. screenshot_node
  server.tool(
    "screenshot_node",
    "Export any MasterGo node or artboard to PNG via `node.exportAsync()`, save it to disk, and optionally return the rendered image inline for immediate visual self-verification.",
    {
      nodeId: z
        .string()
        .min(1)
        .describe("MasterGo node ID (from mastergo_status or use_mastergo return value)."),
      scale: z
        .number()
        .min(0.25)
        .max(4)
        .optional()
        .describe("Export scale multiplier (default 1; use 2 for crisp retina inspection)."),
      savePath: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional local file path to save the exported PNG. Defaults to a temporary file in the OS temp directory."
        ),
      returnImage: z
        .boolean()
        .optional()
        .describe(
          "Whether to include the exported image inline in the MCP response (default true)."
        ),
    },
    async ({ nodeId, scale, savePath, returnImage }) => {
      const exportScale = scale ?? 1;
      const includeImage = returnImage ?? true;

      try {
        const exported = await bridge.request(
          "screenshot_node",
          {
            nodeId,
            scale: exportScale,
            format: "PNG",
          },
          DEFAULT_REQUEST_TIMEOUT_MS
        );

        const saved = await saveExportedScreenshot(exported.base64, {
          nodeId: exported.nodeId,
          nodeName: exported.nodeName,
          format: exported.format,
          savePath,
        });

        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [
          {
            type: "text",
            text: formatJsonText({
              ok: true,
              nodeId: exported.nodeId,
              nodeName: exported.nodeName,
              nodeType: exported.nodeType,
              width: exported.width,
              height: exported.height,
              scale: exported.scale,
              format: exported.format,
              byteLength: saved.byteLength,
              filePath: saved.filePath,
            }),
          },
        ];

        if (includeImage) {
          content.push({
            type: "image",
            data: exported.base64,
            mimeType: "image/png",
          });
        }

        return { content };
      } catch (err) {
        return formatErrorResponse(err);
      }
    }
  );

  return server;
}
