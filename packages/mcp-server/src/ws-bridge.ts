import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  PROTOCOL_VERSION,
  serializeError,
  type BridgeMethod,
  type BridgeMethodMap,
  type BridgeRequestMessage,
  type BridgeResponseMessage,
  type DocumentSnapshot,
  type PluginCapabilities,
  type PluginToServerMessage,
  type SerializedError,
  type ServerToPluginMessage,
} from "@use-mastergo-mcp/protocol";

export interface BridgeOptions {
  host?: string;
  port?: number;
  serverVersion?: string;
  heartbeatIntervalMs?: number;
  maxPayloadBytes?: number;
  logger?: (message: string) => void;
}

export interface BridgeConnectionInfo {
  connected: boolean;
  host: string;
  port: number;
  url: string;
  connectedAt: string | null;
  pluginVersion: string | null;
  capabilities: PluginCapabilities | null;
  lastDocument: DocumentSnapshot | null;
}

export class BridgeExecutionError extends Error {
  readonly remoteError: SerializedError;
  readonly logs: string[];
  readonly durationMs: number;

  constructor(
    remoteError: SerializedError,
    logs: string[] = [],
    durationMs = 0
  ) {
    super(remoteError.message);
    this.name = remoteError.name || "BridgeExecutionError";
    this.remoteError = remoteError;
    this.logs = logs;
    this.durationMs = durationMs;
  }
}

interface PendingRequest {
  requestId: string;
  method: BridgeMethod;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  socket: WebSocket;
}

export class MasterGoWsBridge {
  private readonly host: string;
  private requestedPort: number;
  private actualPort: number;
  private readonly serverVersion: string;
  private readonly heartbeatIntervalMs: number;
  private readonly maxPayloadBytes: number;
  private readonly log: (message: string) => void;

  private wss: WebSocketServer | null = null;
  private activeSocket: WebSocket | null = null;
  private connectedAt: string | null = null;
  private pluginVersion: string | null = null;
  private capabilities: PluginCapabilities | null = null;
  private lastDocument: DocumentSnapshot | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: BridgeOptions = {}) {
    this.host = options.host ?? DEFAULT_BRIDGE_HOST;
    this.requestedPort = options.port ?? DEFAULT_BRIDGE_PORT;
    this.actualPort = this.requestedPort;
    this.serverVersion = options.serverVersion ?? "0.1.0";
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 64 * 1024 * 1024;
    this.log = options.logger ?? ((msg) => process.stderr.write(`[use-mastergo-mcp] ${msg}\n`));
  }

  get port(): number {
    return this.actualPort;
  }

  get url(): string {
    return `ws://${this.host}:${this.actualPort}`;
  }

  get isConnected(): boolean {
    return (
      this.activeSocket !== null &&
      this.activeSocket.readyState === WebSocket.OPEN
    );
  }

  getConnectionInfo(): BridgeConnectionInfo {
    return {
      connected: this.isConnected,
      host: this.host,
      port: this.actualPort,
      url: this.url,
      connectedAt: this.connectedAt,
      pluginVersion: this.pluginVersion,
      capabilities: this.capabilities,
      lastDocument: this.lastDocument,
    };
  }

  async start(): Promise<number> {
    if (this.wss) {
      return this.actualPort;
    }

    await new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({
        host: this.host,
        port: this.requestedPort,
        maxPayload: this.maxPayloadBytes,
      });

      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };

      const onListening = () => {
        server.off("error", onError);
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this.actualPort = addr.port;
        }
        this.wss = server;
        this.setupServerListeners(server);
        this.startHeartbeat();
        this.log(`WebSocket bridge listening on ${this.url}`);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
    });

    return this.actualPort;
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.rejectPendingRequests(new Error("WebSocket bridge server is shutting down."));

    if (this.activeSocket) {
      try {
        this.activeSocket.close(1001, "Server shutting down");
      } catch {
        // Ignore close errors during shutdown
      }
      this.activeSocket = null;
    }

    if (this.wss) {
      const server = this.wss;
      this.wss = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  async request<M extends BridgeMethod>(
    method: M,
    params: BridgeMethodMap[M]["params"],
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<BridgeMethodMap[M]["result"]> {
    const socket = this.activeSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(
        `No MasterGo desktop plugin is connected on ${this.url}. Open MasterGo, launch the "use-mastergo-mcp Bridge" plugin, and ensure it shows Connected.`
      );
    }

    const boundedTimeout = Math.max(
      1_000,
      Math.min(timeoutMs, MAX_REQUEST_TIMEOUT_MS)
    );
    const requestId = randomUUID();
    const message: BridgeRequestMessage<M> = {
      type: "request",
      requestId,
      method,
      params,
      timeoutMs: boundedTimeout,
    };

    return await new Promise<BridgeMethodMap[M]["result"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(
            `MasterGo request "${method}" (${requestId}) timed out after ${boundedTimeout}ms.`
          )
        );
      }, boundedTimeout);

      this.pending.set(requestId, {
        requestId,
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        socket,
      });

      try {
        socket.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(
          err instanceof Error ? err : new Error(serializeError(err).message)
        );
      }
    });
  }

  private setupServerListeners(server: WebSocketServer): void {
    server.on("connection", (socket) => {
      // Replace any stale active socket cleanly.
      if (this.activeSocket && this.activeSocket !== socket) {
        const previous = this.activeSocket;
        this.rejectPendingRequestsForSocket(
          previous,
          new Error("MasterGo plugin reconnected with a new session.")
        );
        try {
          previous.close(1000, "Replaced by newer plugin connection");
        } catch {
          // Ignore close error
        }
      }

      this.activeSocket = socket;
      this.connectedAt = new Date().toISOString();
      this.pluginVersion = null;
      this.capabilities = null;
      this.log("MasterGo plugin connected.");

      this.sendMessage(socket, {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: this.serverVersion,
        port: this.actualPort,
      });

      socket.on("message", (raw) => {
        this.handleRawMessage(socket, raw.toString("utf8"));
      });

      socket.on("close", () => {
        this.rejectPendingRequestsForSocket(
          socket,
          new Error("MasterGo plugin disconnected while a request was in flight.")
        );
        if (this.activeSocket === socket) {
          this.activeSocket = null;
          this.connectedAt = null;
          this.log("MasterGo plugin disconnected.");
        }
      });

      socket.on("error", (err) => {
        this.log(`WebSocket client error: ${err.message}`);
      });
    });

    server.on("error", (err) => {
      this.log(`WebSocket server error: ${err.message}`);
    });
  }

  private handleRawMessage(socket: WebSocket, raw: string): void {
    let parsed: PluginToServerMessage;
    try {
      parsed = JSON.parse(raw) as PluginToServerMessage;
    } catch {
      this.log("Ignored malformed JSON message from plugin.");
      return;
    }

    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      return;
    }

    switch (parsed.type) {
      case "hello": {
        if (socket === this.activeSocket) {
          this.pluginVersion = parsed.pluginVersion;
          this.capabilities = parsed.capabilities;
          this.lastDocument = parsed.document ?? null;
          this.log(
            `Plugin handshake OK (v${parsed.pluginVersion}, dynamicEval=${parsed.capabilities.dynamicEval})`
          );
        }
        break;
      }
      case "response": {
        this.handleResponse(parsed);
        break;
      }
      case "pong": {
        break;
      }
      default:
        break;
    }
  }

  private handleResponse(message: BridgeResponseMessage): void {
    const entry = this.pending.get(message.requestId);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(message.requestId);

    if (message.ok) {
      if (entry.method === "status" && message.result && typeof message.result === "object") {
        const statusRes = message.result as {
          pluginVersion?: string;
          capabilities?: PluginCapabilities;
          document?: DocumentSnapshot;
        };
        if (statusRes.pluginVersion) this.pluginVersion = statusRes.pluginVersion;
        if (statusRes.capabilities) this.capabilities = statusRes.capabilities;
        if (statusRes.document) this.lastDocument = statusRes.document;
      }
      entry.resolve(message.result);
    } else {
      entry.reject(
        new BridgeExecutionError(
          message.error,
          message.logs ?? [],
          message.durationMs
        )
      );
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatIntervalMs <= 0) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.activeSocket && this.activeSocket.readyState === WebSocket.OPEN) {
        this.sendMessage(this.activeSocket, { type: "ping", ts: Date.now() });
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private sendMessage(socket: WebSocket, message: ServerToPluginMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  private rejectPendingRequestsForSocket(socket: WebSocket, error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      if (entry.socket === socket) {
        clearTimeout(entry.timer);
        entry.reject(error);
        this.pending.delete(id);
      }
    }
  }
}
