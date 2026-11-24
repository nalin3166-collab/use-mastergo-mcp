import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
} from "@use-mastergo-mcp/protocol";
import { createMasterGoMcpServer, SERVER_VERSION } from "./server.js";
import { MasterGoWsBridge } from "./ws-bridge.js";

function parsePort(argv: string[], env: NodeJS.ProcessEnv): number {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      const next = argv[i + 1];
      const parsed = Number(next);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
        return parsed;
      }
      throw new Error(`Invalid --port value: "${next ?? ""}"`);
    }
    if (arg.startsWith("--port=")) {
      const parsed = Number(arg.slice("--port=".length));
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
        return parsed;
      }
      throw new Error(`Invalid --port value: "${arg}"`);
    }
  }

  if (env.MASTERGO_BRIDGE_PORT) {
    const parsed = Number(env.MASTERGO_BRIDGE_PORT);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
    throw new Error(
      `Invalid MASTERGO_BRIDGE_PORT env value: "${env.MASTERGO_BRIDGE_PORT}"`
    );
  }

  return DEFAULT_BRIDGE_PORT;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stderr.write(
      [
        `use-mastergo-mcp v${SERVER_VERSION}`,
        "",
        "Usage:",
        "  use-mastergo-mcp [--port <port>]",
        "",
        "Environment:",
        `  MASTERGO_BRIDGE_PORT  Local WebSocket port (default: ${DEFAULT_BRIDGE_PORT})`,
        "",
        `Security: Always binds strictly to ${DEFAULT_BRIDGE_HOST} (loopback only).`,
        "",
      ].join("\n")
    );
    process.exit(0);
  }

  const port = parsePort(process.argv.slice(2), process.env);
  const bridge = new MasterGoWsBridge({
    host: DEFAULT_BRIDGE_HOST,
    port,
    serverVersion: SERVER_VERSION,
  });

  await bridge.start();

  const mcpServer = createMasterGoMcpServer(bridge);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  process.stderr.write(
    `[use-mastergo-mcp] MCP stdio server ready (v${SERVER_VERSION}), waiting for MasterGo plugin on ${bridge.url}\n`
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[use-mastergo-mcp] Received ${signal}, shutting down...\n`);
    await bridge.stop();
    await mcpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(
    `[use-mastergo-mcp] Fatal startup error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`
  );
  process.exit(1);
});
