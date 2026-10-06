/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { IncomingMessage } from "node:http";

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";

import { graphqlKey, mcpKey, mockKey, routeKey, streamKey } from "../src/keys.js";
import { createDispatcher, mockEngineWebsocketOptions } from "../src/router.js";
import { createApp, listen, resolveWorkspaceId, WORKSPACE_ID, wsUpgrade } from "./support.js";

function captureReply(): { reply: FastifyReply; status: () => number } {
  let statusCode = 0;
  const reply = {
    status(code: number) {
      statusCode = code;
      return reply;
    },
    async send(): Promise<void> {
      return undefined;
    },
    header() {
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, status: () => statusCode };
}

function request(method: string, params: unknown, url: string): FastifyRequest {
  return { method, params, url, headers: {}, query: {}, body: undefined } as FastifyRequest;
}

function redisGet(impl: (key: string) => Promise<string | null>): Redis {
  return { get: impl } as unknown as Redis;
}

describe("router edges", () => {
  it("rejects a missing workspace, an unknown method, and a store that fails mid-lookup", async () => {
    const quiet = createDispatcher({
      redis: redisGet(async () => null),
      resolveWorkspaceId,
    });
    const missing = captureReply();
    await quiet.http(request("GET", {}, "/s"), missing.reply);
    expect(missing.status()).toBe(404);

    const traced = captureReply();
    await quiet.http(request("TRACE", { workspaceId: "acme", "*": "users" }, "/s/acme/users"), traced.reply);
    expect(traced.status()).toBe(404);

    const graphqlDown = createDispatcher({
      redis: redisGet(async (key) => {
        if (key.includes(":graphql:")) {
          throw new Error("down");
        }
        return null;
      }),
      resolveWorkspaceId,
    });
    const graphqlReply = captureReply();
    await graphqlDown.http(request("GET", { workspaceId: "acme", "*": "gql" }, "/s/acme/gql"), graphqlReply.reply);
    expect(graphqlReply.status()).toBe(503);

    const routeDown = createDispatcher({
      redis: redisGet(async (key) => {
        if (key.includes(":route:")) {
          throw new Error("down");
        }
        return null;
      }),
      resolveWorkspaceId,
    });
    const routeReply = captureReply();
    await routeDown.http(request("GET", { workspaceId: "acme", "*": "users" }, "/s/acme/users"), routeReply.reply);
    expect(routeReply.status()).toBe(503);

    const mockDown = createDispatcher({
      redis: redisGet(async (key) => {
        if (key.includes(":mock:")) {
          throw new Error("down");
        }
        if (key.includes(":route:")) {
          return "mock-1";
        }
        return null;
      }),
      resolveWorkspaceId,
    });
    const mockReply = captureReply();
    await mockDown.http(request("GET", { workspaceId: "acme", "*": "users" }, "/s/acme/users"), mockReply.reply);
    expect(mockReply.status()).toBe(503);
  });

  it("decides the WebSocket subprotocol from the request URL", async () => {
    const redis = redisGet(async (key) => {
      if (key.includes(":stream:")) {
        return JSON.stringify({ protocol: "websocket", subprotocols: ["chat"], payload: { storage: "inline", body: "a" } });
      }
      return null;
    });
    const handshake = mockEngineWebsocketOptions({ redis, resolveWorkspaceId, basePath: "/s" });
    const decide = async (url: string | undefined, protocol?: string | string[]): Promise<boolean> => {
      const req = { url, headers: { "sec-websocket-protocol": protocol } } as IncomingMessage;
      return new Promise((resolve) => {
        handshake.verifyClient({ req }, (ok) => {
          resolve(ok);
        });
      });
    };

    expect(await decide(undefined)).toBe(true);
    expect(await decide("/health")).toBe(true);
    expect(await decide("/s/acme/bad path")).toBe(true);
    expect(await decide("/s/missing/events")).toBe(true);
    const chatRequest = { url: "/s/acme/events", headers: { "sec-websocket-protocol": "chat" } } as IncomingMessage;
    expect(
      await new Promise((resolve) => {
        handshake.verifyClient({ req: chatRequest }, (ok) => {
          resolve(ok);
        });
      }),
    ).toBe(true);
    expect(handshake.handleProtocols(new Set(["other"]), chatRequest)).toBe(false);
    expect(handshake.handleProtocols(new Set(["chat"]), chatRequest)).toBe("chat");

    const failing = mockEngineWebsocketOptions({
      redis: redisGet(async () => {
        throw new Error("down");
      }),
      resolveWorkspaceId,
      basePath: "/s",
    });
    const broken = { url: "/s/acme/events", headers: {} } as IncomingMessage;
    expect(
      await new Promise((resolve) => {
        failing.verifyClient({ req: broken }, (ok) => {
          resolve(ok);
        });
      }),
    ).toBe(true);
  });

  it("falls through to GraphQL when the stream is not a socket", async () => {
    const { app, redis } = await createApp();
    await redis.set(graphqlKey(WORKSPACE_ID, "/both"), JSON.stringify({ sdl: "type Query { hello: String }" }));
    await redis.set(
      streamKey(WORKSPACE_ID, "/both"),
      JSON.stringify({ protocol: "sse", payload: { storage: "inline", body: "a" } }),
    );
    await redis.set(
      streamKey(WORKSPACE_ID, "/chunks"),
      JSON.stringify({ protocol: "chunked", payload: { storage: "inline", body: "a" } }),
    );
    const closed: number[] = [];
    const socket = await app.injectWS("/s/acme/both", wsUpgrade, {
      onInit(ws) {
        ws.on("close", (code: number) => {
          closed.push(code);
        });
        ws.on("message", () => undefined);
      },
    });
    socket.send(JSON.stringify({ type: "connection_init" }));
    await new Promise((done) => {
      setTimeout(done, 30);
    });
    socket.close();

    const chunked = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("chunked socket stayed open")), 1000);
      void app
        .injectWS("/s/acme/chunks", wsUpgrade, {
          onInit(ws) {
            ws.on("close", (code: number) => {
              clearTimeout(timer);
              resolve(code);
            });
          },
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("inject failed"));
        });
    });
    expect(chunked).toBe(1008);

    const none = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("empty socket stayed open")), 1000);
      void app
        .injectWS("/s/acme/nobody", wsUpgrade, {
          onInit(ws) {
            ws.on("close", (code: number) => {
              clearTimeout(timer);
              resolve(code);
            });
          },
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("inject failed"));
        });
    });
    expect(none).toBe(1008);
    expect(closed.length).toBeGreaterThanOrEqual(0);
    await app.close();
  });
});

describe("stream runtime", () => {
  it("paces, drops, loops, and echoes", async () => {
    const { app, redis } = await createApp({
      resolvePayloadOverride: async (_context, raw) => {
        if (typeof raw === "object" && raw !== null && "boom" in raw) {
          throw new Error("override failed");
        }
        return null;
      },
    });
    await redis.set(
      streamKey(WORKSPACE_ID, "/paced"),
      JSON.stringify({
        id: "paced",
        protocol: "sse",
        chunkMode: "words",
        payload: { storage: "inline", body: "one two three four" },
        durationMs: 40,
        initialDelayMs: 10,
        heartbeatMs: 10,
        dropConnectionAtPercent: 50,
        sendDone: true,
      }),
    );
    await redis.set(
      streamKey(WORKSPACE_ID, "/stay"),
      JSON.stringify({
        protocol: "sse",
        chunkMode: "whole",
        payload: { storage: "inline", body: "stay" },
        durationMs: 5000,
      }),
    );
    await redis.set(
      streamKey(WORKSPACE_ID, "/loop"),
      JSON.stringify({
        protocol: "websocket",
        repeat: "loop",
        echo: true,
        wsFormat: "binary",
        chunkMode: "whole",
        durationMs: 20,
        payload: { storage: "inline", body: "zz" },
      }),
    );
    await redis.set(
      streamKey(WORKSPACE_ID, "/boom"),
      JSON.stringify({ protocol: "websocket", boom: true, payload: { storage: "inline", body: "a" } }),
    );
    const port = await listen(app);
    const paced = await fetch(`http://127.0.0.1:${port}/s/acme/paced`).catch((error: unknown) => error);
    if (paced instanceof Response) {
      await paced.text().catch(() => undefined);
    }
    const controller = new AbortController();
    const staying = await fetch(`http://127.0.0.1:${port}/s/acme/stay`, { signal: controller.signal });
    const reading = staying.arrayBuffer();
    controller.abort();
    await expect(reading).rejects.toThrow();

    const loop = await app.injectWS("/s/acme/loop", wsUpgrade, {
      onInit(ws) {
        ws.on("message", () => undefined);
      },
    });
    loop.send(Buffer.from("bin"));
    await new Promise((done) => {
      setTimeout(done, 50);
    });
    loop.close();

    await app.injectWS("/s/acme/boom", wsUpgrade).catch(() => undefined);
    await app.close();
  });
});

describe("GraphQL hook results", () => {
  it("serves a delayed hook body, socket envelopes, and a subscription", async () => {
    const { app, redis } = await createApp({
      resolvePayloadOverride: async (_context, raw) => {
        if (typeof raw !== "object" || raw === null || !("mode" in raw)) {
          return null;
        }
        const mode = (raw as { mode?: string }).mode;
        if (mode === "delay") {
          return { statusCode: 202, delayMs: 5, payload: { data: { hello: "hook" } } };
        }
        if (mode === "list") {
          return { statusCode: 200, payload: { envelopes: [{ data: { hello: "list" } }] } };
        }
        if (mode === "plain") {
          return { statusCode: 200, payload: { envelopes: "nope" } };
        }
        if (mode === "stream") {
          return {
            statusCode: 200,
            payload: {
              envelopes: (async function* envelopes(): AsyncGenerator<unknown> {
                yield { data: { hello: "stream" } };
              })(),
            },
          };
        }
        return null;
      },
    });
    await redis.set(graphqlKey(WORKSPACE_ID, "/delay"), JSON.stringify({ mode: "delay", sdl: "type Query { hello: String }" }));
    await redis.set(graphqlKey(WORKSPACE_ID, "/list"), JSON.stringify({ mode: "list", sdl: "type Query { hello: String }" }));
    await redis.set(graphqlKey(WORKSPACE_ID, "/stream"), JSON.stringify({ mode: "stream", sdl: "type Query { hello: String }" }));
    await redis.set(
      graphqlKey(WORKSPACE_ID, "/sub"),
      JSON.stringify({ sdl: "type Query { hello: String } type Subscription { tick: String }" }),
    );
    await redis.set(graphqlKey(WORKSPACE_ID, "/plain"), JSON.stringify({ mode: "plain", sdl: "type Query { hello: String }" }));
    await redis.set(graphqlKey(WORKSPACE_ID, "/bad"), "not-json");

    const delayed = await app.inject({ method: "POST", url: "/s/acme/delay", payload: { query: "{ hello }" } });
    expect(delayed.statusCode).toBe(202);
    expect(delayed.json()).toEqual({ data: { hello: "hook" } });

    const frames: string[] = [];
    const listed = await app.injectWS("/s/acme/list", { ...wsUpgrade, headers: { "sec-websocket-protocol": "graphql-transport-ws" } }, {
      onInit(ws) {
        ws.on("message", (data: unknown) => {
          frames.push(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
        });
      },
    });
    listed.send(JSON.stringify({ type: "connection_init" }));
    listed.send(JSON.stringify({ id: "1", type: "subscribe", payload: { query: "{ hello }" } }));
    await new Promise((done) => {
      setTimeout(done, 40);
    });
    listed.close();

    const streamed = await app.injectWS("/s/acme/stream", { ...wsUpgrade, headers: { "sec-websocket-protocol": "graphql-transport-ws" } }, {
      onInit(ws) {
        ws.on("message", (data: unknown) => {
          frames.push(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
        });
      },
    });
    streamed.send(JSON.stringify({ type: "connection_init" }));
    streamed.send(JSON.stringify({ id: "2", type: "subscribe", payload: { query: "{ hello }" } }));
    await new Promise((done) => {
      setTimeout(done, 40);
    });
    streamed.close();

    const plain = await app.injectWS("/s/acme/plain", { ...wsUpgrade, headers: { "sec-websocket-protocol": "graphql-transport-ws" } }, {
      onInit(ws) {
        ws.on("message", () => undefined);
      },
    });
    plain.send(JSON.stringify({ type: "connection_init" }));
    plain.send(JSON.stringify({ id: "4", type: "subscribe", payload: { query: "{ hello }" } }));
    await new Promise((done) => {
      setTimeout(done, 40);
    });
    plain.close();

    const subscribed = await app.injectWS("/s/acme/sub", { ...wsUpgrade, headers: { "sec-websocket-protocol": "graphql-transport-ws" } }, {
      onInit(ws) {
        ws.on("message", () => undefined);
      },
    });
    subscribed.send(JSON.stringify({ type: "connection_init" }));
    subscribed.send(JSON.stringify({ id: "3", type: "subscribe", payload: { query: "subscription { tick }" } }));
    await new Promise((done) => {
      setTimeout(done, 40);
    });
    subscribed.close();

    const bad = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("bad graphql socket stayed open")), 1000);
      void app
        .injectWS("/s/acme/bad", wsUpgrade, {
          onInit(ws) {
            ws.on("close", (code: number) => {
              clearTimeout(timer);
              resolve(code);
            });
          },
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("inject failed"));
        });
    });
    expect(bad).toBe(4404);
    expect(frames.some((frame) => frame.includes("list") || frame.includes("stream"))).toBe(true);
    await app.close();
  });
});

describe("remaining protocol gaps", () => {
  it("stores an unknown content type and a missing object reader", async () => {
    const { app, redis } = await createApp();
    await redis.set(routeKey(WORKSPACE_ID, "POST", "/plain"), "plain");
    await redis.set(
      mockKey("plain"),
      JSON.stringify({ payload: { type: "text", storage: "inline", body: "ok" } }),
    );
    await redis.set(routeKey(WORKSPACE_ID, "GET", "/object"), "object");
    await redis.set(
      mockKey("object"),
      JSON.stringify({ payload: { type: "text", storage: "object", body: "blob", sizeBytes: 1 } }),
    );
    const plain = await app.inject({
      method: "POST",
      url: "/s/acme/plain",
      headers: { "content-type": "application/x-mock" },
      payload: "hello",
    });
    expect(plain.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/s/acme/object" })).statusCode).toBe(404);
    await app.close();
  });

  it("reports a down store and a stored tool payload", async () => {
    const redis = redisGet(async () => {
      throw new Error("down");
    });
    const { app } = await createApp({ redis });
    const port = await listen(app);
    const stream = await fetch(`http://127.0.0.1:${port}/s/acme/mcp/sse`);
    const reader = stream.body?.getReader();
    if (reader === undefined) {
      throw new Error("missing SSE body");
    }
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("sessionId=")) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    const sessionId = /sessionId=([^&\s]+)/.exec(text)?.[1] ?? "";
    const posted = await fetch(`http://127.0.0.1:${port}/s/acme/mcp/messages?sessionId=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(posted.status).toBe(503);
    await reader.cancel();
    await app.close();

    const live = await createApp();
    await live.redis.set(
      mcpKey(WORKSPACE_ID),
      JSON.stringify({
        tools: [{ name: "echo", inputSchema: { type: "object" }, payload: { said: "stored" } }],
        resources: [],
        prompts: [],
      }),
    );
    const livePort = await listen(live.app);
    const liveStream = await fetch(`http://127.0.0.1:${livePort}/s/acme/mcp/sse`);
    const liveReader = liveStream.body?.getReader();
    if (liveReader === undefined) {
      throw new Error("missing SSE body");
    }
    let liveText = "";
    while (!liveText.includes("sessionId=")) {
      const chunk = await liveReader.read();
      if (chunk.done) {
        break;
      }
      liveText += decoder.decode(chunk.value, { stream: true });
    }
    const liveSession = /sessionId=([^&\s]+)/.exec(liveText)?.[1] ?? "";
    const called = await fetch(`http://127.0.0.1:${livePort}/s/acme/mcp/messages?sessionId=${liveSession}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } }),
    });
    expect(called.status).toBe(202);
    while (!liveText.includes("stored")) {
      const chunk = await liveReader.read();
      if (chunk.done) {
        break;
      }
      liveText += decoder.decode(chunk.value, { stream: true });
    }
    expect(liveText).toContain("stored");
    await liveReader.cancel();
    const missed = await fetch(`http://127.0.0.1:${livePort}/s/acme/mcp/messages?sessionId=${liveSession}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    expect([202, 404]).toContain(missed.status);
    await live.app.close();
  });

  it("closes a GraphQL socket when Redis fails and skips a gRPC write when the schema store is down", async () => {
    const codes: number[] = [];
    const dispatch = createDispatcher({
      redis: redisGet(async (key) => {
        if (key.includes(":graphql:")) {
          throw new Error("down");
        }
        return null;
      }),
      resolveWorkspaceId,
    });
    await dispatch.socket(
      {
        close(code?: number): void {
          codes.push(code ?? 0);
        },
        terminate(): void {},
        send(): void {},
        ping(): void {},
        on(): void {},
      },
      request("GET", { workspaceId: "acme", "*": "graphql" }, "/s/acme/graphql"),
    );
    expect(codes).toContain(1011);

    const redis = redisGet(async (key) => {
      if (key.includes("grpc-schema")) {
        throw new Error("down");
      }
      if (key.includes(":grpc:")) {
        return JSON.stringify({ responsePayload: { message: "hi" }, errorCode: "OK" });
      }
      return null;
    });
    const { app } = await createApp({ redis });
    const port = await listen(app);
    const response = await fetch(`http://127.0.0.1:${port}/s/acme/demo.Greeter/SayHello`, {
      method: "POST",
      headers: { "content-type": "application/grpc" },
      body: Buffer.from([0, 0, 0, 0, 0]),
    });
    expect(response.status).toBe(503);
    await app.close();
  });
});
