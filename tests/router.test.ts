/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { Socket } from "node:net";

import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mockEngine, mockEngineWebsocketOptions } from "../src/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function resolveWorkspaceId(slugOrId: string): Promise<string | null> {
  return Promise.resolve(slugOrId === "acme" ? WORKSPACE_ID : null);
}

describe("mockEngine router", () => {
  const redis = new RedisMock() as unknown as Redis;
  let app: FastifyInstance;
  let port = 0;

  beforeAll(async () => {
    app = Fastify();
    await app.register(websocket, {
      options: mockEngineWebsocketOptions({
        redis,
        resolveWorkspaceId,
        basePath: "/s",
      }),
    });
    await app.register(mockEngine, {
      redis,
      basePath: "/s",
      resolveWorkspaceId,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves an inline REST payload from Redis", async () => {
    const mockId = "users-get";
    await redis.set(`mockmarlin:route:${WORKSPACE_ID}:GET:/users`, mockId);
    await redis.set(
      `mockmarlin:mock:${mockId}`,
      JSON.stringify({
        statusCode: 200,
        payload: {
          type: "json",
          storage: "inline",
          body: JSON.stringify({ ok: true }),
        },
      }),
    );

    const response = await app.inject({ method: "GET", url: "/s/acme/users" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("serves a WebSocket stream frame from Redis", async () => {
    await redis.set(
      `mockmarlin:stream:${WORKSPACE_ID}:/events`,
      JSON.stringify({
        protocol: "websocket",
        chunkMode: "whole",
        payload: { storage: "inline", body: "hello" },
      }),
    );

    const frame = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("WebSocket frame was not received"));
      }, 2000);
      void app
        .injectWS(
          "/s/acme/events",
          { socket: { authorized: false, encrypted: false } as unknown as Socket },
          {
            onInit(ws) {
              ws.on("message", (data: unknown) => {
                clearTimeout(timer);
                ws.close();
                if (typeof data === "string") {
                  resolve(data);
                  return;
                }
                if (data instanceof Buffer) {
                  resolve(data.toString("utf8"));
                  return;
                }
                resolve(String(data));
              });
            },
          },
        )
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("WebSocket inject failed"));
        });
    });

    expect(await frame).toBe("hello");
  });

  it("answers an MCP ping on the workspace SSE session", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test server did not bind a TCP port");
    }
    port = address.port;

    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/s/acme/mcp/sse`, {
      signal: controller.signal,
    });
    expect(stream.ok).toBe(true);
    expect(stream.body).not.toBeNull();

    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 2000;
    while (!text.includes("sessionId=") && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }

    const sessionId = /sessionId=([^&\s]+)/.exec(text)?.[1];
    expect(sessionId).toBeTruthy();

    const posted = await fetch(
      `http://127.0.0.1:${port}/s/acme/mcp/messages?sessionId=${sessionId ?? ""}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      },
    );
    expect(posted.status).toBe(202);

    const messageDeadline = Date.now() + 2000;
    while (!text.includes("event: message") && Date.now() < messageDeadline) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();

    expect(text).toContain("event: message");
    expect(text).toContain('"result":{}');
  });

  it("returns 404 when the workspace cannot be resolved", async () => {
    const response = await app.inject({ method: "GET", url: "/s/missing/users" });

    expect(response.statusCode).toBe(404);
  });
});
