/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { Readable } from "node:stream";

import type { FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { graphqlKey, grpcHotKey, grpcSchemaKey, mcpKey, mockKey, routeKey, streamKey } from "../src/keys.js";
import { createDispatcher } from "../src/router.js";
import { SessionManager } from "../src/mcp/SessionManager.js";
import type { EngineSocket, InspectorLog } from "../src/index.js";
import { createApp, listen, resolveWorkspaceId, WORKSPACE_ID, wsUpgrade } from "./support.js";

const PROTO = `
syntax = "proto3";
package demo;
service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
  rpc Watch (HelloRequest) returns (stream HelloReply);
}
message HelloRequest { string name = 1; }
message HelloReply { string message = 1; int32 count = 2; }
`;

function inline(body: string, type = "json"): Record<string, unknown> {
  return { type, storage: "inline", body };
}

async function seedRest(redis: Redis, id: string, path: string, config: Record<string, unknown>, method = "GET"): Promise<void> {
  await redis.set(routeKey(WORKSPACE_ID, method, path), id);
  await redis.set(mockKey(id), JSON.stringify(config));
}

describe("REST serving", () => {
  const logs: InspectorLog[] = [];
  const stored = new Map<string, string>([["blob", "stored-body"]]);
  const { promise: appPromise, resolve } = (() => {
    let resolveApp: (value: Awaited<ReturnType<typeof createApp>>) => void = () => undefined;
    const promise = new Promise<Awaited<ReturnType<typeof createApp>>>((done) => {
      resolveApp = done;
    });
    return { promise, resolve: resolveApp };
  })();

  beforeAll(async () => {
    resolve(
      await createApp({
        onInspectorLog: async (entry) => {
          if (entry.id === "explode") {
            throw new Error("inspector failed");
          }
          logs.push(entry);
        },
        readStoredObject: async (key) => {
          if (key === "missing") {
            const error = new Error("gone");
            error.name = "MissingStoredObjectError";
            throw error;
          }
          if (key === "boom") {
            throw "storage failed";
          }
          const body = stored.get(key);
          if (body === undefined) {
            const error = new Error("gone");
            error.name = "MissingStoredObjectError";
            throw error;
          }
          return Readable.from([body]);
        },
        resolvePayloadOverride: async (_context, config) => {
          if (config["id"] !== "ruled") {
            return null;
          }
          return {
            statusCode: 201,
            payload: inline('{"ruled":true}'),
            delayMs: 15,
            headers: { "x-rule": "yes", "": "skip" },
            matchedRuleId: "rule-1",
            matchedRuleName: "First",
          };
        },
      }),
    );
  });

  afterAll(async () => {
    const { app } = await appPromise;
    await app.close();
  });

  it("serves text, markup, binary, templates, and a ruled override", async () => {
    const { app, redis } = await appPromise;
    await seedRest(redis, "text", "/text", {
      payload: inline("hello", "text"),
      headers: { "x-one": "1", "x-skip": 2, "": "no", "set-cookie": "a=b" },
    });
    await seedRest(redis, "html", "/page", { payload: inline("<b>hi</b>", "html"), statusCode: 201 });
    await seedRest(redis, "xml", "/feed", { payload: { ...inline("<a/>", "xml"), mimeType: "application/xml" } });
    await seedRest(redis, "bin", "/file", { template: true, payload: inline(Buffer.from("hi").toString("base64"), "binary") });
    await seedRest(redis, "tmpl", "/greet", {
      template: true,
      payload: inline("{{method}} {{query.name}}", "text"),
      headers: { "x-path": "{{path}}" },
    }, "POST");
    await seedRest(redis, "ruled", "/ruled", { id: "ruled", payload: inline("{}", "text") });
    await seedRest(redis, "explode", "/explode", { payload: inline("ok", "text") });
    await seedRest(redis, "bad", "/bad", { payload: { type: "json" } });
    await seedRest(redis, "blob", "/blob", {
      payload: { type: "text", storage: "object", body: "blob", sizeBytes: 11 },
    });
    await seedRest(redis, "missing", "/missing-object", {
      payload: { type: "text", storage: "object", body: "missing", sizeBytes: 1 },
    });
    await seedRest(redis, "boom", "/boom", {
      payload: { type: "text", storage: "object", body: "boom", sizeBytes: 1 },
    });
    await seedRest(redis, "slow", "/slow", { delayMs: 15, payload: inline("{}", "json") });
    await redis.set(routeKey(WORKSPACE_ID, "GET", "/empty"), "");
    await redis.set(routeKey(WORKSPACE_ID, "GET", "/junk"), "junk");
    await redis.set(mockKey("junk"), "not-json");

    const text = await app.inject({ method: "GET", url: "/s/acme/text" });
    expect(text.body).toBe("hello");
    expect(text.headers["x-one"]).toBe("1");
    expect(text.headers["set-cookie"]).toBeUndefined();
    expect(text.headers["x-content-type-options"]).toBe("nosniff");
    expect(text.headers["content-type"]).toContain("text/plain");

    const page = await app.inject({ method: "GET", url: "/s/acme/page" });
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["content-security-policy"]).toContain("sandbox");
    expect((await app.inject({ method: "GET", url: "/s/acme/feed" })).headers["content-type"]).toBe("application/xml");
    expect((await app.inject({ method: "GET", url: "/s/acme/file" })).rawPayload.toString()).toBe("hi");

    const templated = await app.inject({ method: "POST", url: "/s/acme/greet?name=ada", payload: { name: "ada" } });
    expect(templated.body).toContain("POST");
    expect(templated.body).toContain("ada");

    const ruled = await app.inject({ method: "GET", url: "/s/acme/ruled" });
    expect(ruled.statusCode).toBe(201);
    expect(ruled.json()).toEqual({ ruled: true });
    expect(ruled.headers["x-rule"]).toBe("yes");
    expect(logs.some((entry) => entry.id === "ruled" && entry.matchedRuleName === "First")).toBe(true);

    expect((await app.inject({ method: "GET", url: "/s/acme/explode" })).body).toBe("ok");
    expect((await app.inject({ method: "GET", url: "/s/acme/bad" })).statusCode).toBe(500);
    expect((await app.inject({ method: "GET", url: "/s/acme/blob" })).body).toBe("stored-body");
    expect((await app.inject({ method: "GET", url: "/s/acme/missing-object" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/s/acme/boom" })).statusCode).toBe(500);
    expect((await app.inject({ method: "GET", url: "/s/acme/slow" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/s/acme/empty" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/s/acme/junk" })).statusCode).toBe(404);
    expect((await app.inject({ method: "OPTIONS", url: "/s/acme/text" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/s/acme/${"a".repeat(257)}` })).statusCode).toBe(404);
  });

  it("answers 503 when Redis is down", async () => {
    const redis = {
      get: async (): Promise<string | null> => {
        throw new Error("down");
      },
    } as unknown as Redis;
    const { app } = await createApp({ redis });
    const response = await app.inject({ method: "GET", url: "/s/acme/users" });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("resets, truncates, and hangs until the client aborts", async () => {
    const { app, redis } = await createApp();
    await seedRest(redis, "reset", "/reset", { fault: "reset", payload: inline("reset-me", "text") });
    await seedRest(redis, "partial", "/partial", {
      fault: "partial",
      headers: { "x-cut": "1" },
      payload: inline("abcdefghijklmnopqrstuvwxyz", "text"),
    });
    await seedRest(redis, "partial-bin", "/partial-bin", {
      fault: "partial",
      payload: { type: "binary", storage: "inline", body: Buffer.from("abcdefghijklmnopqrstuvwxyz").toString("base64") },
    });
    await seedRest(redis, "partial-obj", "/partial-obj", {
      fault: "partial",
      payload: { type: "text", storage: "object", body: "blob", sizeBytes: 4 },
    });
    await seedRest(redis, "hang", "/hang", { fault: "hang", payload: inline("nope", "text") });
    const port = await listen(app);
    const base = `http://127.0.0.1:${port}`;

    await expect(fetch(`${base}/s/acme/reset`)).rejects.toThrow();

    await expect(fetch(`${base}/s/acme/partial`).then((response) => response.arrayBuffer())).rejects.toThrow();
    await expect(fetch(`${base}/s/acme/partial-bin`).then((response) => response.arrayBuffer())).rejects.toThrow();
    await expect(fetch(`${base}/s/acme/partial-obj`).then((response) => response.arrayBuffer())).rejects.toThrow();

    const controller = new AbortController();
    const hanging = fetch(`${base}/s/acme/hang`, { signal: controller.signal });
    await new Promise((done) => {
      setTimeout(done, 30);
    });
    controller.abort();
    await expect(hanging).rejects.toThrow();
    await app.close();
  });
});

describe("streams, GraphQL, and MCP", () => {
  const { promise: appPromise, resolve } = (() => {
    let resolveApp: (value: Awaited<ReturnType<typeof createApp>>) => void = () => undefined;
    const promise = new Promise<Awaited<ReturnType<typeof createApp>>>((done) => {
      resolveApp = done;
    });
    return { promise, resolve: resolveApp };
  })();

  beforeAll(async () => {
    resolve(
      await createApp({
        onInspectorLog: async () => undefined,
        resolvePayloadOverride: async (_context, raw) => {
          if (typeof raw === "object" && raw !== null && "name" in raw && (raw as { name?: string }).name === "echo") {
            return { statusCode: 200, payload: { echoed: true } };
          }
          if (typeof raw === "object" && raw !== null && "rewrite" in raw) {
            return {
              statusCode: 200,
              payload: null,
              config: {
                protocol: "sse",
                id: "rewritten",
                chunkMode: "whole",
                payload: { storage: "inline", body: "over" },
              },
            };
          }
          return null;
        },
      }),
    );
  });

  afterAll(async () => {
    const { app } = await appPromise;
    await app.close();
  });

  it("serves SSE and chunked streams and rejects the wrong client", async () => {
    const { app, redis } = await appPromise;
    await redis.set(
      streamKey(WORKSPACE_ID, "/events"),
      JSON.stringify({ id: "events", protocol: "sse", chunkMode: "words", eventIds: true, payload: { storage: "inline", body: "a b" } }),
    );
    await redis.set(
      streamKey(WORKSPACE_ID, "/ws-only"),
      JSON.stringify({ protocol: "websocket", payload: { storage: "inline", body: "x" } }),
    );
    await redis.set(
      streamKey(WORKSPACE_ID, "/lines"),
      JSON.stringify({ protocol: "chunked", chunkedFormat: "ndjson", chunkMode: "whole", payload: { storage: "inline", body: '{"n":1}' } }),
    );
    await redis.set(streamKey(WORKSPACE_ID, "/bad-stream"), "not-json");
    await redis.set(streamKey(WORKSPACE_ID, "/rewrite"), JSON.stringify({ protocol: "sse", rewrite: true, payload: { storage: "inline", body: "old" } }));

    const port = await listen(app);
    const sse = await fetch(`http://127.0.0.1:${port}/s/acme/events`, { headers: { "last-event-id": "1" } });
    expect(await sse.text()).toContain("data: b");
    expect((await app.inject({ method: "GET", url: "/s/acme/ws-only" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/s/acme/events" })).statusCode).toBe(405);
    expect((await app.inject({ method: "GET", url: "/s/acme/missing-stream", headers: { accept: "text/event-stream" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/s/acme/bad-stream" })).statusCode).toBe(404);

    const chunked = await fetch(`http://127.0.0.1:${port}/s/acme/lines`);
    expect(chunked.headers.get("content-type")).toContain("ndjson");
    expect(await chunked.text()).toContain('{"n":1}');
    const rewritten = await fetch(`http://127.0.0.1:${port}/s/acme/rewrite`);
    expect(await rewritten.text()).toContain("over");
    const head = await fetch(`http://127.0.0.1:${port}/s/acme/events`, { method: "HEAD" });
    expect(head.status).toBe(200);
  });

  it("serves GraphQL playgrounds, queries, and hook responses", async () => {
    const { app, redis } = await appPromise;
    const sdl = "type Query { hello: String }";
    await redis.set(graphqlKey(WORKSPACE_ID, "/graphql"), JSON.stringify({ sdl }));
    await redis.set(graphqlKey(WORKSPACE_ID, "/broken"), JSON.stringify({ sdl: "not sdl" }));
    await redis.set(graphqlKey(WORKSPACE_ID, "/empty"), JSON.stringify({ sdl: "" }));

    const playground = await app.inject({ method: "GET", url: "/s/acme/graphql", headers: { accept: "text/html" } });
    expect(playground.headers["content-type"]).toContain("text/html");
    expect(playground.headers["content-security-policy"]).toContain("script-src");
    expect(String(playground.headers["content-security-policy"])).not.toContain("sandbox");
    expect(playground.headers["x-mockmarlin-trusted-document"]).toBeUndefined();
    expect(playground.body).toContain("GraphQL Playground");

    const posted = await app.inject({
      method: "POST",
      url: "/s/acme/graphql",
      headers: { "content-type": "application/json" },
      payload: { query: "{ hello }" },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json()).toHaveProperty("data");

    const queried = await app.inject({ method: "GET", url: "/s/acme/graphql?query=%7B%20hello%20%7D" });
    expect(queried.statusCode).toBe(200);

    const raw = await app.inject({
      method: "POST",
      url: "/s/acme/graphql",
      headers: { "content-type": "application/graphql" },
      payload: "{ hello }",
    });
    expect(raw.statusCode).toBe(200);

    expect((await app.inject({ method: "POST", url: "/s/acme/graphql", payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/s/acme/nowhere", headers: { "content-type": "application/graphql" }, payload: "{ hello }" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/s/acme/empty", payload: { query: "{ hello }" } })).statusCode).toBe(404);
    const broken = await app.inject({ method: "POST", url: "/s/acme/broken", payload: { query: "{ hello }" } });
    expect(broken.json()).toMatchObject({ errors: [expect.any(Object)] });
  });

  it("dispatches MCP tool calls on the workspace session", async () => {
    const { app, redis } = await appPromise;
    await redis.set(
      mcpKey(WORKSPACE_ID),
      JSON.stringify({
        tools: [
          { name: "echo", inputSchema: { type: "object" }, payload: { said: "hi" } },
          { name: "described", description: "A tool", inputSchema: { type: "object" } },
          { nope: true },
        ],
        resources: [{ uri: "file://a" }],
        prompts: [{ name: "hi" }],
      }),
    );
    const port = (app.server.address() as { port: number }).port;
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
    const call = async (body: unknown): Promise<number> => {
      const response = await fetch(`http://127.0.0.1:${port}/s/acme/mcp/messages?sessionId=${sessionId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.status;
    };

    expect(await call({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(202);
    expect(await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: {} } })).toBe(202);
    expect(await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "described", arguments: {} } })).toBe(202);
    expect(await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "missing" } })).toBe(202);
    while (!text.includes("Unknown tool")) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text).toContain("echo");
    expect(text).toContain("echoed");
    expect(text).toContain("Unknown tool");
    await reader.cancel();

    expect((await app.inject({ method: "GET", url: "/s/acme/mcp/messages" })).statusCode).toBe(405);
    expect((await app.inject({ method: "POST", url: "/s/acme/mcp/sse" })).statusCode).toBe(405);
    expect((await app.inject({ method: "POST", url: "/s/acme/mcp/messages" })).statusCode).toBe(404);
  });
});

describe("gRPC-web", () => {
  it("encodes a unary mock and rejects the methods it cannot serve", async () => {
    const { app, redis } = await createApp();
    await redis.set(
      grpcSchemaKey(WORKSPACE_ID),
      JSON.stringify({ files: [{ name: "demo.proto", content: PROTO }, { name: "../evil.proto", content: "nope" }] }),
    );
    await redis.set(
      grpcHotKey(WORKSPACE_ID, "demo.Greeter", "SayHello"),
      JSON.stringify({ responsePayload: { message: "hi", count: 1 }, latencyMs: 5, errorCode: "OK" }),
    );
    await redis.set(
      grpcHotKey(WORKSPACE_ID, "demo.Greeter", "Watch"),
      JSON.stringify({ responsePayload: { message: "hi" }, errorCode: null }),
    );
    const port = await listen(app);
    const call = async (path: string, contentType: string, hot?: string): Promise<Response> => {
      if (hot !== undefined) {
        await redis.set(grpcHotKey(WORKSPACE_ID, "demo.Greeter", "SayHello"), hot);
      }
      return fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: Buffer.from([0, 0, 0, 0, 0]),
      });
    };

    const web = await call("/s/acme/demo.Greeter/SayHello", "application/grpc-web");
    const webBody = Buffer.from(await web.arrayBuffer());
    expect(
      webBody.length,
      JSON.stringify({
        status: web.status,
        type: web.headers.get("content-type"),
        grpc: web.headers.get("grpc-status"),
        message: web.headers.get("grpc-message"),
      }),
    ).toBeGreaterThan(0);
    const again = await call("/s/acme/demo.Greeter/SayHello", "application/grpc");
    expect(again.headers.get("grpc-status")).toBe("0");
    const text = await call("/s/acme/demo.Greeter/SayHello", "application/grpc-web-text");
    expect(text.headers.get("content-type")).toContain("grpc-web-text");

    const missing = await call("/s/acme/demo.Greeter/Other", "application/grpc");
    expect(missing.headers.get("grpc-status")).not.toBe("0");
    const stream = await call("/s/acme/demo.Greeter/Watch", "application/grpc");
    expect(stream.headers.get("grpc-status")).not.toBe("0");
    const bare = await call("/s/acme/only", "application/grpc");
    expect(bare.status).toBe(200);

    const webError = await call(
      "/s/acme/demo.Greeter/SayHello",
      "application/grpc-web",
      JSON.stringify({ responsePayload: { message: "x" }, errorCode: "NOT_FOUND" }),
    );
    expect(Buffer.from(await webError.arrayBuffer()).length).toBeGreaterThan(0);
    const notFound = await call(
      "/s/acme/demo.Greeter/SayHello",
      "application/grpc",
      JSON.stringify({ responsePayload: { message: "x" }, errorCode: "NOT_FOUND" }),
    );
    expect(notFound.headers.get("grpc-status")).not.toBe("0");
    const unknown = await call(
      "/s/acme/demo.Greeter/SayHello",
      "application/grpc",
      JSON.stringify({ responsePayload: { message: "x" }, errorCode: "NOPE" }),
    );
    expect(unknown.headers.get("grpc-message")).toBe("NOPE");
    const invalid = await call("/s/acme/demo.Greeter/SayHello", "application/grpc", "not-json");
    expect(invalid.headers.get("grpc-status")).not.toBe("0");
    const arrayPayload = await call(
      "/s/acme/demo.Greeter/SayHello",
      "application/grpc",
      JSON.stringify({ responsePayload: [], errorCode: "OK" }),
    );
    expect(arrayPayload.headers.get("grpc-status")).not.toBe("0");
    const badCount = await call(
      "/s/acme/demo.Greeter/SayHello",
      "application/grpc",
      JSON.stringify({ responsePayload: { message: "x", count: "nope" }, errorCode: "OK" }),
    );
    expect(badCount.status).toBe(200);

    await redis.set(grpcSchemaKey(WORKSPACE_ID), JSON.stringify({ files: [{ name: "demo.proto", content: "not a proto" }] }));
    const badProto = await call(
      "/s/acme/demo.Greeter/SayHello",
      "application/grpc",
      JSON.stringify({ responsePayload: { message: "x" }, errorCode: "OK" }),
    );
    expect(badProto.headers.get("grpc-status")).not.toBe("0");
    await redis.set(grpcSchemaKey(WORKSPACE_ID), JSON.stringify({ files: "nope" }));
    const badFiles = await call("/s/acme/demo.Greeter/SayHello", "application/grpc");
    expect(badFiles.headers.get("grpc-status")).not.toBe("0");
    await redis.set(
      grpcSchemaKey(WORKSPACE_ID),
      JSON.stringify({ files: [null, { name: "x" }, { name: "ok.proto", content: 1 }] }),
    );
    const skippedFiles = await call("/s/acme/demo.Greeter/SayHello", "application/grpc");
    expect(skippedFiles.headers.get("grpc-status")).not.toBe("0");
    await redis.set(grpcHotKey(WORKSPACE_ID, "demo.Greeter", "SayHello"), "[]");
    const arrayHot = await call("/s/acme/demo.Greeter/SayHello", "application/grpc");
    expect(arrayHot.headers.get("grpc-status")).not.toBe("0");
    await redis.set(
      grpcHotKey(WORKSPACE_ID, "demo.Greeter", "SayHello"),
      JSON.stringify({ responsePayload: { message: "x" }, errorCode: "OK" }),
    );
    await redis.del(grpcSchemaKey(WORKSPACE_ID));
    const missingSchema = await call("/s/acme/demo.Greeter/SayHello", "application/grpc");
    expect(missingSchema.headers.get("grpc-status")).not.toBe("0");
    await redis.set(grpcSchemaKey(WORKSPACE_ID), "not-json");
    const noSchema = await call("/s/acme/demo.Greeter/SayHello", "application/grpc");
    expect(noSchema.headers.get("grpc-status")).not.toBe("0");

    await app.close();
  });
});

describe("sockets", () => {
  it("routes GraphQL and WebSocket streams, and closes everything else", async () => {
    const { app, redis } = await createApp();
    const sdl = "type Query { hello: String }";
    await redis.set(graphqlKey(WORKSPACE_ID, "/graphql"), JSON.stringify({ sdl }));
    await redis.set(graphqlKey(WORKSPACE_ID, "/bad-graphql"), "not-json");
    await redis.set(
      streamKey(WORKSPACE_ID, "/events"),
      JSON.stringify({
        protocol: "websocket",
        echo: true,
        repeat: "loop",
        chunkMode: "whole",
        durationMs: 5000,
        subprotocols: ["chat"],
        payload: { storage: "inline", body: "tick" },
      }),
    );
    await redis.set(
      streamKey(WORKSPACE_ID, "/sse"),
      JSON.stringify({ protocol: "sse", payload: { storage: "inline", body: "a" } }),
    );
    await redis.set(
      streamKey(WORKSPACE_ID, "/chunked"),
      JSON.stringify({ protocol: "chunked", payload: { storage: "inline", body: "a" } }),
    );

    const frames: string[] = [];
    const socket = await app.injectWS(
      "/s/acme/graphql",
      { ...wsUpgrade, headers: { "sec-websocket-protocol": "graphql-transport-ws" } },
      {
        onInit(ws) {
          ws.on("message", (data: unknown) => {
            frames.push(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
          });
        },
      },
    );
    socket.send(JSON.stringify({ type: "connection_init" }));
    socket.send(JSON.stringify({ id: "1", type: "subscribe", payload: { query: "{ hello }" } }));
    await new Promise((done) => {
      setTimeout(done, 50);
    });
    expect(frames.some((frame) => frame.includes("connection_ack"))).toBe(true);
    socket.close();

    const echoed: string[] = [];
    const stream = await app.injectWS(
      "/s/acme/events",
      { ...wsUpgrade, headers: { "sec-websocket-protocol": "chat" } },
      {
        onInit(ws) {
          ws.on("message", (data: unknown) => {
            echoed.push(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
          });
        },
      },
    );
    stream.send("ping-me");
    await new Promise((done) => {
      setTimeout(done, 30);
    });
    expect(echoed).toContain("ping-me");
    stream.close();

    await expect(
      app.injectWS("/s/acme/events", { ...wsUpgrade, headers: { "sec-websocket-protocol": "nope" } }),
    ).rejects.toThrow();

    const closed = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket stayed open")), 1000);
      void app
        .injectWS("/s/missing/events", wsUpgrade, {
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
    expect(closed).toBe(1008);
    await app.close();
  });

  it("closes the socket when the store or the handler fails", async () => {
    const redis = {
      async get(key: string): Promise<string | null> {
        if (key.includes(":graphql:")) {
          return null;
        }
        throw new Error("down");
      },
    } as unknown as Redis;
    const failing = createDispatcher({ redis, resolveWorkspaceId, basePath: "/s" });
    const closed: Array<number | undefined> = [];
    const request = {
      params: { workspaceId: "acme", "*": "events" },
      headers: {},
      url: "/s/acme/events",
      method: "GET",
      query: {},
    } as FastifyRequest;
    await failing.socket(
      {
        close(code?: number): void {
          closed.push(code);
        },
        terminate(): void {
          closed.push(0);
        },
        send(): void {},
        ping(): void {},
        on(): void {},
      },
      request,
    );
    expect(closed).toContain(1011);

    let terminated = false;
    const exploding = createDispatcher({
      redis: { get: async () => { throw new Error("store"); } } as unknown as Redis,
      resolveWorkspaceId: async () => {
        throw new Error("lookup");
      },
      basePath: "/s",
    });
    await exploding.socket(
      {
        close(): void {
          throw new Error("close failed");
        },
        terminate(): void {
          terminated = true;
        },
        send(): void {},
        ping(): void {},
        on(): void {},
      },
      request,
    );
    expect(terminated).toBe(true);

    const mcp = createDispatcher({
      redis: { get: async () => null } as unknown as Redis,
      resolveWorkspaceId,
    });
    const reasons: string[] = [];
    await mcp.socket(
      {
        close(_code?: number, reason?: string): void {
          reasons.push(reason ?? "");
        },
        terminate(): void {},
        send(): void {},
        ping(): void {},
        on(): void {},
      } satisfies EngineSocket,
      { ...request, params: { workspaceId: "acme", "*": "mcp/sse" }, url: "/s/acme/mcp/sse" } as FastifyRequest,
    );
    expect(reasons[0]).toContain("MCP");
  });
});

describe("SSE sessions", () => {
  it("drops a session when the response ends", () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const writes: string[] = [];
    const raw = {
      destroyed: false,
      writableEnded: false,
      write(chunk: string): boolean {
        writes.push(chunk);
        return true;
      },
      on(event: string, listener: () => void): void {
        listeners.set(event, listener);
      },
    };
    const sessions = new SessionManager();
    const id = sessions.open(raw as unknown as import("node:http").ServerResponse, "/s/acme/mcp/messages");
    vi.advanceTimersByTime(15_000);
    expect(writes.some((chunk) => chunk.includes("keepalive"))).toBe(true);
    expect(sessions.has(id)).toBe(true);
    expect(sessions.emit(id, { ok: true })).toBe(true);
    raw.destroyed = true;
    vi.advanceTimersByTime(15_000);
    expect(sessions.has(id)).toBe(false);
    expect(sessions.emit(id, { ok: false })).toBe(false);
    raw.writableEnded = true;
    listeners.get("close")?.();
    listeners.get("error")?.();
    vi.useRealTimers();
  });
});
