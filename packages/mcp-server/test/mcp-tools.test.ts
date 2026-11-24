import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@use-mastergo-mcp/protocol";
import { createMasterGoMcpServer } from "../src/server.js";
import { MasterGoWsBridge } from "../src/ws-bridge.js";

describe("MCP server 4 tools end-to-end", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
      await fn();
    }
  });

  it("handles mastergo_status, use_mastergo, upload_local_images, and screenshot_node", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "use-mastergo-e2e-"));
    cleanups.push(() => rm(tempDir, { recursive: true, force: true }));

    const samplePng = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 4,
        background: { r: 64, g: 180, b: 96, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const imgPath = join(tempDir, "cover.png");
    await sharp(samplePng).toFile(imgPath);

    const bridge = new MasterGoWsBridge({
      port: 0,
      heartbeatIntervalMs: 0,
      logger: () => {},
    });
    await bridge.start();
    cleanups.push(() => bridge.stop());

    const server = createMasterGoMcpServer(bridge);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    cleanups.push(() => server.close());

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    cleanups.push(() => client.close());

    // 1. Disconnected status returns clear instructions without throwing
    const disconnected = await client.callTool({
      name: "mastergo_status",
      arguments: {},
    });
    const disconnectedJson = JSON.parse(
      (disconnected.content as Array<{ text: string }>)[0].text
    );
    expect(disconnectedJson.connected).toBe(false);
    expect(disconnectedJson.howToConnect.length).toBeGreaterThan(0);

    // Connect mock MasterGo plugin over WS
    const ws = new WebSocket(bridge.url);
    cleanups.push(async () => {
      ws.close();
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf8"));
      if (msg.type !== "request") return;

      if (msg.method === "status") {
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            ok: true,
            durationMs: 2,
            result: {
              connected: true,
              pluginVersion: "0.1.0",
              capabilities: { dynamicEval: true, apiVersion: "1.0.0" },
              document: {
                id: "0:0",
                name: "Demo Design",
                currentPageId: "0:1",
                currentPageName: "Home",
                pages: [
                  { id: "0:1", name: "Home", childCount: 2, isCurrent: true },
                ],
                selection: [],
              },
            },
          })
        );
      } else if (msg.method === "execute") {
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            ok: true,
            durationMs: 8,
            result: {
              value: { createdFrameId: "10:1" },
              logs: ["created frame"],
              durationMs: 8,
            },
          })
        );
      } else if (msg.method === "upload_images") {
        const results: Record<string, { imageRef: string }> = {};
        for (const item of msg.params.images) {
          results[item.key] = { imageRef: `mg-img-${item.width}x${item.height}` };
        }
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            ok: true,
            durationMs: 4,
            result: { results, errors: {} },
          })
        );
      } else if (msg.method === "screenshot_node") {
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            ok: true,
            durationMs: 10,
            result: {
              nodeId: msg.params.nodeId,
              nodeName: "Hero Frame",
              nodeType: "FRAME",
              width: 32,
              height: 32,
              format: "PNG",
              scale: msg.params.scale ?? 1,
              base64: samplePng.toString("base64"),
              byteLength: samplePng.byteLength,
            },
          })
        );
      }
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            protocolVersion: PROTOCOL_VERSION,
            pluginVersion: "0.1.0",
            capabilities: { dynamicEval: true },
          })
        );
        resolve();
      });
      ws.once("error", reject);
    });

    // 2. Connected status
    const statusRes = await client.callTool({
      name: "mastergo_status",
      arguments: {},
    });
    const statusJson = JSON.parse(
      (statusRes.content as Array<{ text: string }>)[0].text
    );
    expect(statusJson.connected).toBe(true);
    expect(statusJson.document.name).toBe("Demo Design");

    // 3. use_mastergo
    const execRes = await client.callTool({
      name: "use_mastergo",
      arguments: {
        description: "Create hero frame",
        code: "return { createdFrameId: '10:1' }",
      },
    });
    const execJson = JSON.parse(
      (execRes.content as Array<{ text: string }>)[0].text
    );
    expect(execJson.ok).toBe(true);
    expect(execJson.result.createdFrameId).toBe("10:1");
    expect(execJson.logs).toEqual(["created frame"]);

    // 4. upload_local_images
    const uploadRes = await client.callTool({
      name: "upload_local_images",
      arguments: { paths: [imgPath] },
    });
    const uploadJson = JSON.parse(
      (uploadRes.content as Array<{ text: string }>)[0].text
    );
    expect(uploadJson.ok).toBe(true);
    expect(uploadJson.images[imgPath]).toBe("mg-img-32x32");

    // 5. screenshot_node
    const shotPath = join(tempDir, "hero.png");
    const shotRes = await client.callTool({
      name: "screenshot_node",
      arguments: { nodeId: "10:1", scale: 2, savePath: shotPath },
    });
    const shotContent = shotRes.content as Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    >;
    expect(shotContent).toHaveLength(2);
    const shotMeta = JSON.parse((shotContent[0] as { text: string }).text);
    expect(shotMeta.filePath).toBe(shotPath);
    expect(shotContent[1].type).toBe("image");
  });
});
