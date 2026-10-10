/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { createKeyLayout, type KeyLayout } from "./keys.js";
import type { MockStore } from "./store.js";

const EXAMPLE_PROTO = `syntax = "proto3";
package demo;
service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
}
message HelloRequest {
  string name = 1;
}
message HelloReply {
  string message = 1;
}
`;

function restDocument(body: string): string {
  return JSON.stringify({
    statusCode: 200,
    delayMs: 0,
    headers: {},
    fault: "none",
    template: false,
    payload: {
      type: "json",
      storage: "inline",
      mimeType: "application/json",
      sizeBytes: Buffer.byteLength(body),
      body,
    },
  });
}

function streamDocument(id: string, protocol: "sse" | "websocket" | "chunked", body: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    protocol,
    chunkMode: "whole",
    durationMs: 50,
    payload: { storage: "inline", body },
    ...extra,
  });
}

/** One example of each protocol, written under `workspaceId`. */
export async function seedExamples(
  store: MockStore,
  workspaceId: string,
  keys: KeyLayout = createKeyLayout(),
): Promise<void> {
  const hello = JSON.stringify({ ok: true, kind: "rest" });
  await store.set(keys.route(workspaceId, "GET", "/hello"), "example-rest");
  await store.set(keys.mock("example-rest"), restDocument(hello));
  await store.set(
    keys.stream(workspaceId, "/events"),
    streamDocument("example-sse", "sse", "hello from sse"),
  );
  await store.set(
    keys.stream(workspaceId, "/ws"),
    streamDocument("example-ws", "websocket", "hello from websocket"),
  );
  await store.set(
    keys.stream(workspaceId, "/chunked"),
    streamDocument("example-chunked", "chunked", "hello from chunked", { chunkedFormat: "text" }),
  );
  await store.set(
    keys.graphql(workspaceId, "/graphql"),
    JSON.stringify({ sdl: "type Query { hello: String }" }),
  );
  await store.set(
    keys.mcp(workspaceId),
    JSON.stringify({
      tools: [
        {
          name: "echo",
          description: "Echoes arguments",
          inputSchema: { type: "object" },
          payload: { ok: true, kind: "mcp" },
        },
      ],
      resources: [],
      prompts: [],
    }),
  );
  await store.set(
    keys.grpcSchema(workspaceId),
    JSON.stringify({ files: [{ name: "demo.proto", content: EXAMPLE_PROTO }] }),
  );
  await store.set(
    keys.grpc(workspaceId, "demo.Greeter", "SayHello"),
    JSON.stringify({
      responsePayload: { message: "hello" },
      latencyMs: 0,
      errorCode: null,
    }),
  );
}
