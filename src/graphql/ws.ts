/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

export const GRAPHQL_TRANSPORT_WS_PROTOCOL = "graphql-transport-ws";
export const GRAPHQL_SUBSCRIPTION_HTTP_MESSAGE =
  "Subscriptions use the graphql-transport-ws subprotocol on this URL.";

const INIT_TIMEOUT_MS = 10_000;
const WS_OPEN = 1;

interface GraphqlSocket {
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "close" | "error", listener: () => void): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
}

interface SocketState {
  acknowledged: boolean;
  closed: boolean;
  initTimer: ReturnType<typeof setTimeout> | null;
  readonly active: Map<string, AbortController>;
}

export interface GraphqlSocketResult {
  delayMs: number;
  envelopes: AsyncIterable<unknown> | readonly unknown[];
}

export type GraphqlSocketRunner = (payload: unknown) => Promise<GraphqlSocketResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFrom(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return null;
}

function send(socket: GraphqlSocket, message: Record<string, unknown>): void {
  if (socket.readyState !== undefined && socket.readyState !== WS_OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The peer already went away.
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clearInitTimer(state: SocketState): void {
  if (state.initTimer !== null) {
    clearTimeout(state.initTimer);
    state.initTimer = null;
  }
}

function closeSocket(socket: GraphqlSocket, state: SocketState, code: number, reason: string): void {
  if (state.closed) {
    return;
  }
  state.closed = true;
  clearInitTimer(state);
  for (const controller of state.active.values()) {
    controller.abort();
  }
  state.active.clear();
  try {
    socket.close(code, reason);
  } catch {
    // Already closed.
  }
}

async function runOperation(
  socket: GraphqlSocket,
  state: SocketState,
  id: string,
  run: GraphqlSocketRunner,
  payload: unknown,
): Promise<void> {
  const controller = new AbortController();
  state.active.set(id, controller);
  try {
    const result = await run(payload);
    if (result.delayMs > 0) {
      await delay(result.delayMs);
    }
    if (controller.signal.aborted || state.closed) {
      return;
    }
    for await (const envelope of result.envelopes) {
      if (controller.signal.aborted || state.closed) {
        return;
      }
      send(socket, { id, type: "next", payload: envelope });
    }
    if (!controller.signal.aborted && !state.closed) {
      send(socket, { id, type: "complete" });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "GraphQL execution failed";
    send(socket, { id, type: "error", payload: [{ message }] });
  } finally {
    state.active.delete(id);
  }
}

function handleMessage(
  socket: GraphqlSocket,
  state: SocketState,
  run: GraphqlSocketRunner,
  raw: unknown,
  isBinary: boolean,
): void {
  if (state.closed || isBinary) {
    closeSocket(socket, state, 4400, "Expected a text JSON message");
    return;
  }
  const text = textFrom(raw);
  if (text === null) {
    closeSocket(socket, state, 4400, "Expected a text JSON message");
    return;
  }

  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    closeSocket(socket, state, 4400, "Invalid JSON");
    return;
  }
  if (!isRecord(message) || typeof message["type"] !== "string") {
    closeSocket(socket, state, 4400, "Invalid message");
    return;
  }

  const type = message["type"];
  if (!state.acknowledged) {
    if (type === "ping") {
      send(socket, { type: "pong" });
      return;
    }
    if (type !== "connection_init") {
      closeSocket(socket, state, 4401, "Unauthorized");
      return;
    }
    state.acknowledged = true;
    clearInitTimer(state);
    send(socket, { type: "connection_ack" });
    return;
  }

  if (type === "ping") {
    send(socket, { type: "pong" });
    return;
  }
  if (type === "pong" || type === "connection_ack") {
    return;
  }
  if (type === "connection_init") {
    closeSocket(socket, state, 4429, "Too many initialisation requests");
    return;
  }

  const id = message["id"];
  if (type === "complete") {
    if (typeof id === "string") {
      state.active.get(id)?.abort();
      state.active.delete(id);
    }
    return;
  }
  if (type !== "subscribe") {
    closeSocket(socket, state, 4400, "Unknown message type");
    return;
  }
  if (typeof id !== "string" || id.length === 0) {
    closeSocket(socket, state, 4400, "Subscribe id is required");
    return;
  }
  if (state.active.has(id)) {
    closeSocket(socket, state, 4409, `Subscriber for ${id} already exists`);
    return;
  }

  void runOperation(socket, state, id, run, message["payload"]);
}

/** Speak `graphql-transport-ws` on an already accepted socket. */
export function handleGraphqlSocket(socket: GraphqlSocket, run: GraphqlSocketRunner): void {
  const state: SocketState = {
    acknowledged: false,
    closed: false,
    initTimer: null,
    active: new Map(),
  };

  state.initTimer = setTimeout(() => {
    if (!state.acknowledged) {
      closeSocket(socket, state, 4408, "Connection initialisation timeout");
    }
  }, INIT_TIMEOUT_MS);

  let chain = Promise.resolve();
  socket.on("message", (data, isBinary) => {
    chain = chain
      .then(() => {
        handleMessage(socket, state, run, data, isBinary);
      })
      .catch(() => {
        closeSocket(socket, state, 1011, "GraphQL socket failed");
      });
  });
  socket.on("close", () => {
    clearInitTimer(state);
    state.closed = true;
    for (const controller of state.active.values()) {
      controller.abort();
    }
    state.active.clear();
  });
  socket.on("error", () => {
    clearInitTimer(state);
    state.closed = true;
    for (const controller of state.active.values()) {
      controller.abort();
    }
    state.active.clear();
  });
}
