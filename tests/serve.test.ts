/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { afterEach, describe, expect, it } from "vitest";

import { listServedMocks } from "../src/app/catalog.js";
import { startGrpcServer } from "../src/app/grpc-server.js";
import { formatTrafficLine, renderScreen, type TrafficEvent } from "../src/app/screen.js";
import { serve } from "../src/app/serve.js";
import { seedExamples } from "../src/examples.js";
import { parseImportFile } from "../src/import/parse-file.js";
import { parseOpenAPI } from "../src/import/openapi.js";
import { parsePostman } from "../src/import/postman.js";
import { clearWorkspace, ImportWriteError, writeImportedRestMocks } from "../src/import/write.js";
import { createKeyLayout, grpcHotKey, grpcSchemaKey, routeIndexKey } from "../src/keys.js";
import { createMemoryStore, toStore } from "../src/store.js";
import { createApp, WORKSPACE_ID } from "./support.js";

const PROTO = `syntax = "proto3";
package demo;
service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
}
message HelloRequest { string name = 1; }
message HelloReply { string message = 1; }
`;

const running: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.close();
  }
});

describe("memory store", () => {
  it("keeps values until they expire or are deleted", async () => {
    const store = createMemoryStore();
    await store.set("a", "1");
    expect(await store.get("a")).toBe("1");
    await store.expire("a", 60);
    expect(await store.get("a")).toBe("1");
    await store.expire("missing", 1);
    await store.expire("a", -1);
    expect(await store.get("a")).toBeNull();
    expect(await store.list?.("")).toEqual([]);
    expect(toStore({ get: async () => "x" }).list).toBeUndefined();
    expect(() => toStore(null)).toThrow(TypeError);
    expect(routeIndexKey("default")).toBe("mockmarlin:route-index:default");
  });
});

describe("importers", () => {
  it("uses the first Postman example as the response", () => {
    const imported = parsePostman(
      Buffer.from(
        JSON.stringify({
          item: [
            {
              request: { method: "GET", url: "https://example.test/users/{{id}}" },
              response: [{ code: 201, header: [{ key: "X-Example", value: "yes" }], body: { id: "u1" } }],
            },
            { request: { method: "POST", url: "/empty" } },
          ],
        }),
      ),
    );
    expect(imported[0]).toMatchObject({
      method: "GET",
      path: "/users/:id",
      statusCode: 201,
      headers: { "X-Example": "yes" },
    });
    expect(JSON.parse(imported[0]?.payload.body ?? "{}")).toEqual({ id: "u1" });
    expect(imported[1]).toMatchObject({ method: "POST", path: "/empty", statusCode: 200 });
    expect(imported[1]?.payload.body).toBe("{}");
  });

  it("prefers an OpenAPI example over the schema sample", () => {
    const imported = parseOpenAPI(
      JSON.stringify({
        openapi: "3.0.0",
        paths: {
          "/users/{id}": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { type: "object", properties: { id: { type: "string" } } },
                      example: { id: "from-example" },
                    },
                  },
                },
              },
            },
          },
          "/health": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { type: "object", properties: { status: { type: "string" } } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    expect(JSON.parse(imported[0]?.payload.body ?? "{}")).toEqual({ id: "from-example" });
    expect(imported[0]?.path).toBe("/users/:id");
    expect(JSON.parse(imported[1]?.payload.body ?? "{}")).toEqual({ status: "" });
  });

  it("sniffs a HAR file and keeps the recorded response", () => {
    const imported = parseImportFile(
      "trace.har",
      Buffer.from(
        JSON.stringify({
          log: {
            entries: [
              {
                request: { method: "GET", url: "https://example.test/items?q=1" },
                response: {
                  status: 200,
                  headers: [{ name: "Content-Type", value: "application/json" }],
                  content: { mimeType: "application/json", text: "{\"n\":2}" },
                },
              },
            ],
          },
        }),
      ),
    );
    expect(imported).toHaveLength(1);
    expect(imported[0]?.path).toBe("/items?q=1");
    expect(imported[0]?.payload.body).toBe('{"n":2}');
  });

  it("rejects a path that cannot be stored", async () => {
    await expect(
      writeImportedRestMocks(createMemoryStore(), "default", [
        {
          method: "GET",
          path: "/bad path",
          headers: {},
          statusCode: 200,
          payload: { type: "json", storage: "inline", sizeBytes: 2, body: "{}" },
        },
      ]),
    ).rejects.toThrow(ImportWriteError);
  });
});

describe("parameter routes", () => {
  it("serves an imported pattern only when matchParams is on", async () => {
    const endpoint = {
      method: "GET" as const,
      path: "/users/:id",
      headers: { "X-From": "import" },
      statusCode: 200,
      payload: {
        type: "json" as const,
        storage: "inline" as const,
        sizeBytes: 11,
        body: '{"id":"1"}',
      },
    };
    const off = await createApp();
    await writeImportedRestMocks(toStore(off.redis), WORKSPACE_ID, [endpoint]);
    expect((await off.app.inject({ method: "GET", url: "/s/acme/users/123" })).statusCode).toBe(404);
    await off.app.close();

    const on = await createApp({ matchParams: true });
    await writeImportedRestMocks(toStore(on.redis), WORKSPACE_ID, [endpoint, endpoint]);
    const response = await on.app.inject({ method: "GET", url: "/s/acme/users/123" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "1" });
    expect(response.headers["x-from"]).toBe("import");
    const root = {
      ...endpoint,
      path: "/",
      payload: { ...endpoint.payload, body: '{"root":true}', sizeBytes: 13 },
    };
    await writeImportedRestMocks(toStore(on.redis), WORKSPACE_ID, [root]);
    expect((await on.app.inject({ method: "GET", url: "/s/acme" })).json()).toEqual({ root: true });
    await on.app.close();
  });
});

describe("serve", () => {
  it("seeds one example of each protocol on an ephemeral port", async () => {
    const seen: TrafficEvent[] = [];
    const server = await serve({
      port: 0,
      grpcPort: 0,
      onTraffic(event) {
        seen.push(event);
      },
    });
    running.push(server);
    expect(server.storeKind).toBe("memory");
    expect(server.source).toBe("examples");
    expect(server.imported).toBeNull();
    expect(server.grpcServices).toBe(1);
    expect(server.mocks.map((mock) => `${mock.method} ${mock.kind} ${mock.target}`)).toEqual([
      "GET rest /s/default/hello",
      "GET sse /s/default/events",
      "GET websocket /s/default/ws",
      "GET chunked /s/default/chunked",
      "POST graphql /s/default/graphql",
      "POST mcp /s/default/mcp/messages",
      "GET mcp /s/default/mcp/sse",
      "RPC grpc demo.Greeter/SayHello",
    ]);

    const hello = await fetch(`http://127.0.0.1:${String(server.port)}/s/default/hello`);
    expect(await hello.json()).toEqual({ ok: true, kind: "rest" });
    const events = await fetch(`http://127.0.0.1:${String(server.port)}/s/default/events`);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    await events.body?.cancel();

    const reply = await callGreeter(server.host, server.grpcPort);
    expect(reply).toEqual({ message: "hello" });
    expect(seen.some((event) => event.kind === "http" && event.target.endsWith("/hello") && event.status === "200")).toBe(true);
    expect(seen.some((event) => event.kind === "grpc" && event.target === "demo.Greeter/SayHello" && event.status === "OK")).toBe(true);
  });

  it("replaces the examples with an imported collection", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mock-engine-import-"));
    await writeFile(
      path.join(directory, "api.json"),
      JSON.stringify({
        item: [
          {
            request: { method: "GET", url: "/widgets" },
            response: [{ code: 200, body: { items: [1] } }],
          },
        ],
      }),
    );
    const server = await serve({ port: 0, grpcPort: 0, importPaths: [directory] });
    running.push(server);
    expect(server.imported).toBe(1);
    expect(server.source).toBe("import");
    expect(server.grpcServices).toBe(0);
    expect(server.mocks).toEqual([{ kind: "rest", method: "GET", target: "/s/default/widgets" }]);
    const widgets = await fetch(`http://127.0.0.1:${String(server.port)}/s/default/widgets`);
    expect(await widgets.json()).toEqual({ items: [1] });
    const hello = await fetch(`http://127.0.0.1:${String(server.port)}/s/default/hello`);
    expect(hello.status).toBe(404);
  });

  it("clears a workspace and reports a missing import", async () => {
    const store = createMemoryStore();
    await seedExamples(store, "default");
    await clearWorkspace(store, "default");
    expect(await store.get("mockmarlin:mock:example-rest")).toBeNull();
    const unlistable = {
      get: async () => null,
      set: async () => undefined,
      expire: async () => undefined,
      del: async () => undefined,
    };
    await expect(clearWorkspace(unlistable, "default")).rejects.toThrow(ImportWriteError);
    await expect(serve({ port: 0, grpcPort: 0, importPaths: ["/no/such/import.json"] })).rejects.toThrow(/not found/);
    await expect(serve({ port: 0, grpcPort: 0, redisUrl: "redis://127.0.0.1:1" })).rejects.toThrow(/unreachable|ECONNREFUSED|Redis/);
    const memory = createMemoryStore();
    const seen: TrafficEvent[] = [];
    const server = await serve({
      port: 0,
      grpcPort: 0,
      store: memory,
      basePath: "/mocks",
      keyPrefix: "widgets",
      workspace: "demo",
      onTraffic(event) {
        seen.push(event);
      },
    });
    running.push(server);
    expect(server.mocks.some((mock) => mock.target === "/mocks/demo/hello")).toBe(true);
    const hello = await fetch(`http://127.0.0.1:${String(server.port)}/mocks/demo/hello`);
    expect(hello.status).toBe(200);
    await memory.set(
      grpcHotKey("demo", "demo.Greeter", "SayHello", "widgets"),
      JSON.stringify({ responsePayload: { message: "nope" }, errorCode: "NOT_FOUND" }),
    );
    await expect(callGreeter(server.host, server.grpcPort)).rejects.toThrow();
    expect(seen.some((event) => event.kind === "grpc" && event.status === "NOT_FOUND")).toBe(true);
    const hotKey = grpcHotKey("demo", "demo.Greeter", "SayHello", "widgets");
    await memory.set(hotKey, "not-json");
    await expect(callGreeter(server.host, server.grpcPort)).rejects.toThrow();
    await memory.set(hotKey, JSON.stringify({ responsePayload: { message: "slow" }, latencyMs: 5, errorCode: null }));
    expect(await callGreeter(server.host, server.grpcPort)).toEqual({ message: "slow" });

    await memory.set(routeIndexKey("other", "widgets"), "not-json");
    await clearWorkspace(memory, "other", createKeyLayout("widgets"));
    await memory.set(routeIndexKey("demo", "widgets"), JSON.stringify([{ method: 1 }, { method: "GET", path: "/", id: "" }]));
    await clearWorkspace(memory, "demo", createKeyLayout("widgets"));
  });

  it("starts gRPC with no services when the schema cannot be loaded", async () => {
    const store = createMemoryStore();
    const keys = createKeyLayout();
    await store.set(grpcSchemaKey("plain"), JSON.stringify({ files: "nope" }));
    const empty = await startGrpcServer({ store, workspaceId: "plain", host: "127.0.0.1", port: 0, keys });
    expect(empty.serviceCount).toBe(0);
    await empty.close();

    await store.set(grpcSchemaKey("bad"), "not-json");
    const broken = await startGrpcServer({ store, workspaceId: "bad", host: "127.0.0.1", port: 0, keys });
    expect(broken.serviceCount).toBe(0);
    await broken.close();

    await store.set(
      grpcSchemaKey("proto"),
      JSON.stringify({ files: [{ name: "bad.proto", content: "this is not a proto" }] }),
    );
    await expect(
      startGrpcServer({ store, workspaceId: "proto", host: "127.0.0.1", port: 0, keys }),
    ).rejects.toThrow();
  });

  it("skips keys that are not routes and ignores a store that cannot list", async () => {
    const store = createMemoryStore();
    await store.set("mockmarlin:route:default:NOPE", "x");
    await store.set("mockmarlin:route:default:GET:hello", "x");
    await store.set("mockmarlin:route:default:GET:/", "root");
    await store.set("mockmarlin:route:default:GET:/same", "a");
    await store.set("mockmarlin:route:default:POST:/same", "b");
    await store.set("mockmarlin:grpc:default:demo.Greeter:", "{}");
    await store.set("mockmarlin:stream:default:/bad", "not-json");
    await store.set("mockmarlin:stream:default:events", "not-json");
    await store.set("mockmarlin:stream:default:/odd", JSON.stringify({ protocol: "nope" }));
    await store.set("mockmarlin:stream:default:/num", "1");
    await store.set("mockmarlin:stream:default:/nil", "null");
    await store.set("mockmarlin:graphql:default:bare", "{}");
    await store.set("mockmarlin:grpc:default:only", "{}");
    await store.set("mockmarlin:mock:example-rest", "{}");
    const rows = await listServedMocks({
      store,
      workspaceId: "default",
      keys: createKeyLayout(),
      basePath: "/s",
    });
    expect(rows.map((row) => `${row.method} ${row.kind} ${row.target}`)).toEqual([
      "GET rest /s/default",
      "GET rest /s/default/same",
      "POST rest /s/default/same",
      "GET stream /s/default/bad",
      "GET stream /s/default/nil",
      "GET stream /s/default/num",
      "GET stream /s/default/odd",
    ]);
    const keys = createKeyLayout();
    await listServedMocks({
      store,
      workspaceId: "default",
      keys: { ...keys, route: () => "nomarker" },
      basePath: "/s",
    });
    const unlistable = {
      get: async () => null,
      set: async () => undefined,
      expire: async () => undefined,
      del: async () => undefined,
    };
    expect(await listServedMocks({ store: unlistable, workspaceId: "default", keys: createKeyLayout(), basePath: "/s" })).toEqual([]);
    const hollow = {
      get: async () => null,
      set: async () => undefined,
      expire: async () => undefined,
      del: async () => undefined,
      list: async () => ["mockmarlin:stream:default:/gone"],
    };
    expect(
      await listServedMocks({ store: hollow, workspaceId: "default", keys: createKeyLayout(), basePath: "/s/" }),
    ).toEqual([{ kind: "stream", method: "GET", target: "/s/default/gone" }]);
  });
});

describe("screen", () => {
  const startedAt = 1_700_000_000_000;

  function model(overrides: Partial<Parameters<typeof renderScreen>[0]> = {}): Parameters<typeof renderScreen>[0] {
    return {
      storeKind: "memory",
      httpUrl: "http://127.0.0.1:4080/s/default",
      grpcUrl: "127.0.0.1:50052",
      grpcServices: 1,
      startedAt,
      now: startedAt + 3661_000,
      mocks: [{ kind: "rest", method: "GET", target: "/s/default/hello" }],
      mockOffset: 0,
      events: [],
      totalRequests: 0,
      ...overrides,
    };
  }

  it("shows the served mocks and waits for traffic", () => {
    const frame = renderScreen(model(), 80, 24, false);
    expect(frame).toContain("GET");
    expect(frame).toContain("/s/default/hello");
    expect(frame).toContain("waiting for traffic");
    expect(frame).toContain("up 01:01:01");
    expect(frame).toContain("0 requests");
    expect(frame).not.toContain("\x1b[");
    expect(renderScreen(model({ hint: "client: mock-engine client" }), 80, 24, false)).toContain("mock-engine client");
    const colored = renderScreen(
      model({
        totalRequests: 1,
        events: [
          { at: startedAt, kind: "http", method: "GET", target: "/s/default/hello", status: "200", durationMs: 4 },
          { at: startedAt, kind: "http", method: "GET", target: "/missing", status: "404", durationMs: 1 },
          { at: startedAt, kind: "http", method: "POST", target: "/gone", status: "500", durationMs: 2 },
          { at: startedAt, kind: "http", method: "GET", target: "/redir", status: "301", durationMs: 3 },
          { at: startedAt, kind: "grpc", method: "RPC", target: "demo.Greeter/SayHello", status: "NOT_FOUND", durationMs: 5 },
          { at: startedAt, kind: "grpc", method: "RPC", target: "demo.Greeter/SayHello", status: "OK", durationMs: 6 },
          { at: startedAt, kind: "grpc", method: "RPC", target: "demo.Greeter/SayHello", status: "UNKNOWN", durationMs: 7 },
        ],
        grpcServices: 2,
      }),
      40,
      40,
      true,
    );
    expect(colored).toContain("\x1b[32m");
    expect(colored).toContain("\x1b[33m");
    expect(colored).toContain("\x1b[31m");
    expect(colored).toContain("\x1b[36m");
    expect(colored).toContain("2 services");
    expect(colored).toContain("1 request");
    expect(formatTrafficLine({ at: startedAt, kind: "http", method: "GET", target: "/s/default/hello", status: "200", durationMs: 4 })).toContain("200");
    const scrolled = renderScreen(
      model({
        mocks: Array.from({ length: 30 }, (_, index) => ({
          kind: "rest" as const,
          method: "GET",
          target: `/s/default/item-${String(index)}`,
        })),
        mockOffset: 100,
      }),
      30,
      20,
      false,
    );
    expect(scrolled).toContain("j/k");
    expect(renderScreen(model({ mocks: [], httpUrl: "http://example.test/" + "x".repeat(80) }), 20, 24, false)).toContain("nothing served yet");
    const many = Array.from({ length: 30 }, (_, index) => ({
      kind: "rest" as const,
      method: "GET",
      target: `/s/default/item-${String(index)}`,
    }));
    expect(renderScreen(model({ mocks: many, mockOffset: -3 }), 80, 24, false)).toContain("item-0");
    expect(renderScreen(model({ mocks: many, mockOffset: 1 }), 80, 24, false)).toContain("j/k");
  });
});

function callGreeter(host: string, port: number): Promise<{ message?: string }> {
  const directory = path.join(tmpdir(), `mock-engine-proto-${String(port)}`);
  return (async () => {
    const { mkdir, writeFile: write } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "demo.proto");
    await write(file, PROTO);
    const loaded = grpc.loadPackageDefinition(
      protoLoader.loadSync(file, { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true }),
    );
    const greeter = loaded["demo"] as { Greeter: grpc.ServiceClientConstructor };
    const client = new greeter.Greeter(`${host}:${String(port)}`, grpc.credentials.createInsecure());
    return await new Promise((resolve, reject) => {
      const call = client["sayHello"] as (
        request: { name: string },
        callback: (error: Error | null, response: { message?: string }) => void,
      ) => void;
      call.call(client, { name: "ada" }, (error, response) => {
        client.close();
        if (error) {
          reject(error);
          return;
        }
        resolve(response);
      });
    });
  })();
}
