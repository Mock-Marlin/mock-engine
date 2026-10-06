/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FastifyReply, FastifyRequest } from "fastify";

import { StreamHandler } from "../src/handlers/StreamHandler.js";
import type { EngineSocket, RequestContext } from "../src/types.js";
import { createRedis, resolveWorkspaceId, WORKSPACE_ID } from "./support.js";

afterEach(() => {
  vi.useRealTimers();
});

interface FakeResponse {
  writableEnded: boolean;
  destroyed: boolean;
  failWrite: boolean;
  chunks: string[];
  on(event: string, listener: () => void): void;
  emit(event: string): void;
}

function httpExchange(method = "GET"): {
  request: FastifyRequest;
  reply: FastifyReply & { statusCode: number; body: unknown };
  raw: FakeResponse;
  closeRequest(): void;
} {
  const requestListeners = new Map<string, Array<() => void>>();
  const responseListeners = new Map<string, Array<() => void>>();
  const raw: FakeResponse = {
    writableEnded: false,
    destroyed: false,
    failWrite: false,
    chunks: [],
    on(event: string, listener: () => void): void {
      const list = responseListeners.get(event) ?? [];
      list.push(listener);
      responseListeners.set(event, list);
    },
    emit(event: string): void {
      for (const listener of responseListeners.get(event) ?? []) {
        listener();
      }
    },
  };
  const request = {
    method,
    headers: {} as Record<string, unknown>,
    raw: {
      setTimeout(): void {
        return undefined;
      },
      on(event: string, listener: () => void): void {
        const list = requestListeners.get(event) ?? [];
        list.push(listener);
        requestListeners.set(event, list);
      },
    },
  } as unknown as FastifyRequest;
  const reply = {
    statusCode: 200,
    body: undefined as unknown,
    raw: {
      setTimeout(): void {
        return undefined;
      },
      get writableEnded(): boolean {
        return raw.writableEnded;
      },
      get destroyed(): boolean {
        return raw.destroyed;
      },
      writeHead(): void {
        return undefined;
      },
      write(chunk: string): void {
        if (raw.failWrite || raw.writableEnded || raw.destroyed) {
          throw new Error("write failed");
        }
        raw.chunks.push(chunk);
      },
      end(): void {
        raw.writableEnded = true;
      },
      destroy(): void {
        raw.destroyed = true;
      },
      on: raw.on.bind(raw),
    },
    hijack(): void {
      return undefined;
    },
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    async send(body: unknown): Promise<void> {
      reply.body = body;
    },
  };
  return {
    request,
    reply: reply as unknown as FastifyReply & { statusCode: number; body: unknown },
    raw,
    closeRequest(): void {
      for (const listener of requestListeners.get("close") ?? []) {
        listener();
      }
    },
  };
}

interface FakeSocket extends EngineSocket {
  readyState: number;
  sent: Array<string | Buffer>;
  pinged: number;
  terminated: boolean;
  closed: { code?: number | undefined; reason?: string | undefined } | null;
  emit(event: "message" | "close" | "error", ...args: unknown[]): void;
}

function fakeSocket(): FakeSocket {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const socket: FakeSocket = {
    readyState: 1,
    sent: [],
    pinged: 0,
    terminated: false,
    closed: null,
    send(data: string | Buffer): void {
      if (socket.readyState !== 1) {
        throw new Error("not open");
      }
      socket.sent.push(data);
    },
    ping(): void {
      if (socket.readyState !== 1) {
        throw new Error("not open");
      }
      socket.pinged += 1;
    },
    close(code?: number, reason?: string): void {
      socket.closed = { code, reason };
      socket.readyState = 3;
    },
    terminate(): void {
      socket.terminated = true;
      socket.readyState = 3;
    },
    on(event, listener): void {
      const list = listeners.get(event) ?? [];
      list.push(listener as (...args: unknown[]) => void);
      listeners.set(event, list);
    },
    emit(event, ...args): void {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
  };
  return socket;
}

function context(): RequestContext {
  return {
    workspaceId: WORKSPACE_ID,
    method: "GET",
    path: "/events",
    headers: {},
    query: {},
    body: undefined,
  };
}

function handler(extra: { throwLog?: boolean; throwOverride?: boolean } = {}): StreamHandler {
  return new StreamHandler({
    redis: createRedis(),
    resolveWorkspaceId,
    ...(extra.throwLog
      ? {
          onInspectorLog: async () => {
            throw new Error("inspector failed");
          },
        }
      : {}),
    ...(extra.throwOverride
      ? {
          resolvePayloadOverride: async () => {
            throw new Error("override failed");
          },
        }
      : {}),
  });
}

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "events",
    protocol: "sse",
    chunkMode: "whole",
    durationMs: 40,
    payload: { storage: "inline", body: "hello" },
    ...overrides,
  };
}

describe("stream playback", () => {
  it("rejects a missing document, a socket-only stream, and the wrong method", async () => {
    const playback = handler();
    const missing = httpExchange();
    await playback.handleHttp(missing.request, missing.reply, null, context());
    expect(missing.reply.statusCode).toBe(404);

    const socketOnly = httpExchange();
    await playback.handleHttp(socketOnly.request, socketOnly.reply, document({ protocol: "websocket" }), context());
    expect(socketOnly.reply.statusCode).toBe(400);

    const posted = httpExchange("POST");
    await playback.handleHttp(posted.request, posted.reply, document(), context());
    expect(posted.reply.statusCode).toBe(405);
  });

  it("drops, loops, heartbeats, and stops when the client leaves", async () => {
    vi.useFakeTimers();
    const playback = handler({ throwLog: true });

    const immediate = httpExchange();
    await playback.handleHttp(
      immediate.request,
      immediate.reply,
      document({ dropConnectionAtPercent: 0, chunkMode: "words", payload: { storage: "inline", body: "one two" } }),
      context(),
    );
    await vi.runAllTimersAsync();
    expect(immediate.raw.destroyed).toBe(true);

    const afterChunk = httpExchange();
    await playback.handleHttp(
      afterChunk.request,
      afterChunk.reply,
      document({ dropConnectionAtPercent: 100, sendDone: true }),
      context(),
    );
    await vi.runAllTimersAsync();
    expect(afterChunk.raw.destroyed).toBe(true);

    const trailer = httpExchange();
    trailer.raw.failWrite = false;
    let writes = 0;
    const originalWrite = trailer.reply.raw.write.bind(trailer.reply.raw);
    trailer.reply.raw.write = ((chunk: string) => {
      writes += 1;
      if (writes > 1) {
        throw new Error("trailer failed");
      }
      originalWrite(chunk);
    }) as typeof trailer.reply.raw.write;
    await playback.handleHttp(trailer.request, trailer.reply, document({ sendDone: true }), context());
    await vi.runAllTimersAsync();
    expect(trailer.raw.chunks.length).toBe(1);

    const closed = httpExchange();
    closed.raw.writableEnded = true;
    await playback.handleHttp(closed.request, closed.reply, document(), context());
    await vi.runAllTimersAsync();
    expect(closed.raw.chunks).toEqual([]);

    const paced = httpExchange();
    await playback.handleHttp(
      paced.request,
      paced.reply,
      document({
        chunkMode: "words",
        payload: { storage: "inline", body: "one two three" },
        durationMs: 100,
        heartbeatMs: 10,
        initialDelayMs: 15,
        repeat: "loop",
      }),
      context(),
    );
    expect(paced.raw.chunks).toEqual([]);
    await vi.advanceTimersByTimeAsync(40);
    expect(paced.raw.chunks.some((chunk) => chunk.includes("keepalive"))).toBe(true);
    paced.closeRequest();
    await vi.runOnlyPendingTimersAsync();
    expect(paced.raw.writableEnded).toBe(false);
  });

  it("echoes socket frames, pings, and closes for the other protocols", async () => {
    vi.useFakeTimers();
    const playback = handler();
    const echoed = fakeSocket();
    await playback.handleSocket(
      echoed,
      document({
        protocol: "websocket",
        echo: true,
        wsFormat: "binary",
        repeat: "loop",
        heartbeatMs: 10,
        wsHeartbeat: "protocol",
        chunkMode: "words",
        payload: { storage: "inline", body: "aa bb" },
        durationMs: 80,
      }),
      context(),
    );
    echoed.emit("message", Buffer.from("buf"), false);
    echoed.emit("message", new ArrayBuffer(2), true);
    echoed.emit("message", [Buffer.from("a"), Buffer.from("b")], false);
    echoed.emit("message", "text", false);
    echoed.emit("message", 5, false);
    await vi.advanceTimersByTimeAsync(15);
    expect(echoed.pinged).toBeGreaterThan(0);
    echoed.readyState = 3;
    echoed.emit("message", "late", false);
    await vi.advanceTimersByTimeAsync(15);
    echoed.emit("close");

    const dropped = fakeSocket();
    await playback.handleSocket(
      dropped,
      document({ protocol: "websocket", dropConnectionAtPercent: 0 }),
      context(),
    );
    await vi.runAllTimersAsync();
    expect(dropped.terminated).toBe(true);

    const finished = fakeSocket();
    finished.send = () => {
      finished.readyState = 3;
    };
    await playback.handleSocket(finished, document({ protocol: "websocket" }), context());
    await vi.runAllTimersAsync();
    expect(finished.closed).toBeNull();

    const missing = fakeSocket();
    await playback.handleSocket(missing, null, context());
    expect(missing.closed?.reason).toBe("Stream endpoint not found or expired");

    const chunked = fakeSocket();
    await playback.handleSocket(chunked, document({ protocol: "chunked" }), context());
    expect(chunked.closed?.reason).toBe("This stream is HTTP chunked; use fetch");

    const sse = fakeSocket();
    await playback.handleSocket(sse, document({ protocol: "sse" }), context());
    expect(sse.closed?.reason).toBe("This stream is SSE-only");

    const exploded = handler({ throwOverride: true });
    const boom = fakeSocket();
    await exploded.handleSocket(boom, document({ protocol: "websocket" }), context());
    expect(boom.terminated).toBe(true);
  });
});
