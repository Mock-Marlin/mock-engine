/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { ServerResponse } from "node:http";

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GrpcHandler } from "../src/handlers/GrpcHandler.js";
import { grpcHotKey } from "../src/keys.js";
import { SessionManager } from "../src/mcp/SessionManager.js";
import { createRedis, resolveWorkspaceId, WORKSPACE_ID } from "./support.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("handler edges", () => {
  it("stops a gRPC call when the client already aborted or Redis is down", async () => {
    const redis = createRedis();
    await redis.set(
      grpcHotKey(WORKSPACE_ID, "demo.Greeter", "SayHello"),
      JSON.stringify({ responsePayload: { message: "hi" }, latencyMs: 0, errorCode: "OK" }),
    );
    const handler = new GrpcHandler({ redis, resolveWorkspaceId });
    let wrote = false;
    const request = {
      headers: { "content-type": "application/grpc" },
      raw: { aborted: true },
    } as unknown as FastifyRequest;
    const reply = {
      hijack(): void {
        wrote = true;
      },
      raw: {
        writeHead(): void {
          wrote = true;
        },
        end(): void {
          wrote = true;
        },
      },
      status(code: number) {
        wrote = code !== 0;
        return reply;
      },
      async send(): Promise<void> {
        wrote = true;
      },
    } as unknown as FastifyReply;
    await handler.handle(request, reply, WORKSPACE_ID, "demo.Greeter/SayHello");
    expect(wrote).toBe(false);

    const down = new GrpcHandler({
      redis: {
        async get(): Promise<string> {
          throw new Error("down");
        },
      } as unknown as Redis,
      resolveWorkspaceId,
    });
    let statusCode = 0;
    const downReply = {
      status(code: number) {
        statusCode = code;
        return downReply;
      },
      async send(): Promise<void> {
        return undefined;
      },
    } as unknown as FastifyReply;
    await down.handle(
      { headers: { "content-type": "application/grpc" }, raw: { aborted: false } } as unknown as FastifyRequest,
      downReply,
      WORKSPACE_ID,
      "demo.Greeter/SayHello",
    );
    expect(statusCode).toBe(503);
  });

  it("forgets an MCP session once its response is closed", () => {
    vi.useFakeTimers();
    const listeners = new Map<string, Array<() => void>>();
    const raw = {
      destroyed: false,
      writableEnded: false,
      write(): boolean {
        return true;
      },
      setTimeout(): void {
        return undefined;
      },
      on(event: string, listener: () => void): void {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
      },
    };
    const sessions = new SessionManager();
    const sessionId = sessions.open(raw as unknown as ServerResponse, "/s/acme/mcp/messages");
    expect(sessions.has(sessionId)).toBe(true);
    vi.advanceTimersByTime(15_000);
    raw.destroyed = true;
    expect(sessions.has(sessionId)).toBe(false);
    expect(sessions.emit(sessionId, { ok: true })).toBe(false);

    const ended = { ...raw, destroyed: false, writableEnded: true, write: () => true };
    const endedId = sessions.open(ended as unknown as ServerResponse, "/s/acme/mcp/messages");
    expect(sessions.has(endedId)).toBe(false);
  });
});
