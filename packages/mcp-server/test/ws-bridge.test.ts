import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  type BridgeRequestMessage,
  type PluginToServerMessage,
} from "@use-mastergo-mcp/protocol";
import { BridgeExecutionError, MasterGoWsBridge } from "../src/ws-bridge.js";

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

describe("MasterGoWsBridge", () => {
  const bridges: MasterGoWsBridge[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    for (const bridge of bridges.splice(0)) {
      await bridge.stop();
    }
  });

  it("binds exclusively to 127.0.0.1 and completes plugin handshake", async () => {
    const bridge = new MasterGoWsBridge({
      port: 0,
      heartbeatIntervalMs: 0,
      logger: () => {},
    });
    bridges.push(bridge);

    const port = await bridge.start();
    expect(port).toBeGreaterThan(0);
    expect(bridge.url).toBe(`ws://127.0.0.1:${port}`);
    expect(bridge.isConnected).toBe(false);

    const ws = new WebSocket(bridge.url);
    sockets.push(ws);

    const welcomePromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
    });

    await waitForOpen(ws);
    const welcome = await welcomePromise;
    expect(welcome.type).toBe("welcome");
    expect(welcome.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(welcome.port).toBe(port);

    const hello: PluginToServerMessage = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      pluginVersion: "0.1.0",
      capabilities: { dynamicEval: true, apiVersion: "1.0.0" },
    };
    ws.send(JSON.stringify(hello));

    await new Promise((r) => setTimeout(r, 30));
    const info = bridge.getConnectionInfo();
    expect(info.connected).toBe(true);
    expect(info.pluginVersion).toBe("0.1.0");
    expect(info.capabilities?.dynamicEval).toBe(true);
  });

  it("correlates concurrent out-of-order responses strictly by requestId", async () => {
    const bridge = new MasterGoWsBridge({
      port: 0,
      heartbeatIntervalMs: 0,
      logger: () => {},
    });
    bridges.push(bridge);
    await bridge.start();

    const ws = new WebSocket(bridge.url);
    sockets.push(ws);

    const received: BridgeRequestMessage[] = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf8"));
      if (msg.type === "request") {
        received.push(msg);
        if (received.length === 2) {
          // Intentionally reply in reverse order
          const [first, second] = received;
          ws.send(
            JSON.stringify({
              type: "response",
              requestId: second.requestId,
              ok: true,
              durationMs: 5,
              result: { value: "second-result", logs: [], durationMs: 5 },
            })
          );
          ws.send(
            JSON.stringify({
              type: "response",
              requestId: first.requestId,
              ok: true,
              durationMs: 12,
              result: { value: "first-result", logs: [], durationMs: 12 },
            })
          );
        }
      }
    });

    await waitForOpen(ws);

    const [res1, res2] = await Promise.all([
      bridge.request("execute", { code: "return 1", description: "first" }),
      bridge.request("execute", { code: "return 2", description: "second" }),
    ]);

    expect(res1.value).toBe("first-result");
    expect(res2.value).toBe("second-result");
  });

  it("rejects with timeout error when plugin does not respond in time", async () => {
    const bridge = new MasterGoWsBridge({
      port: 0,
      heartbeatIntervalMs: 0,
      logger: () => {},
    });
    bridges.push(bridge);
    await bridge.start();

    const ws = new WebSocket(bridge.url);
    sockets.push(ws);
    await waitForOpen(ws);

    await expect(
      bridge.request(
        "execute",
        { code: "await new Promise(() => {})", description: "hang" },
        1_000
      )
    ).rejects.toThrow(/timed out/i);
  });

  it("propagates remote execution errors and console logs via BridgeExecutionError", async () => {
    const bridge = new MasterGoWsBridge({
      port: 0,
      heartbeatIntervalMs: 0,
      logger: () => {},
    });
    bridges.push(bridge);
    await bridge.start();

    const ws = new WebSocket(bridge.url);
    sockets.push(ws);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf8"));
      if (msg.type === "request") {
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            ok: false,
            durationMs: 3,
            logs: ["step 1 ok"],
            error: {
              name: "TypeError",
              message: "Cannot read properties of null",
              stack: "TypeError: Cannot read properties of null\n    at eval:2:5",
            },
          })
        );
      }
    });

    await waitForOpen(ws);

    try {
      await bridge.request("execute", {
        code: "null.foo()",
        description: "boom",
      });
      expect.unreachable("should have rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeExecutionError);
      const bridgeErr = err as BridgeExecutionError;
      expect(bridgeErr.remoteError.name).toBe("TypeError");
      expect(bridgeErr.logs).toEqual(["step 1 ok"]);
    }
  });
});
