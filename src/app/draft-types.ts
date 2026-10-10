/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { HttpMethod } from "../import/types.js";

/** Protocol of one mock in a spec or in the client editor. */
export type MockKind = "rest" | "sse" | "websocket" | "chunked" | "graphql" | "mcp" | "grpc";

/** REST mock edited as YAML and stored by method and path. */
export interface RestDraft {
  kind: "rest";
  method: HttpMethod;
  path: string;
  status: number;
  delayMs: number;
  headers: Record<string, string>;
  body: unknown;
}

/** SSE, WebSocket, or chunked HTTP mock. The body is the stream text. */
export interface StreamDraft {
  kind: "sse" | "websocket" | "chunked";
  path: string;
  body: string;
}

/** GraphQL mock. `sdl` is the schema served at `path`. */
export interface GraphqlDraft {
  kind: "graphql";
  path: string;
  sdl: string;
}

/** One MCP tool returned by an MCP mock. */
export interface McpToolDraft {
  name: string;
  description: string;
  body: unknown;
}

/** MCP server mock: tools, resources, and prompts. */
export interface McpDraft {
  kind: "mcp";
  tools: McpToolDraft[];
  resources: unknown[];
  prompts: unknown[];
}

/** Unary gRPC mock. `errorCode` is null when the call succeeds. */
export interface GrpcDraft {
  kind: "grpc";
  service: string;
  rpc: string;
  latencyMs: number;
  errorCode: string | null;
  body: unknown;
}

/** Any mock the spec and the client editor can store. */
export type MockDraft = RestDraft | StreamDraft | GraphqlDraft | McpDraft | GrpcDraft;

/** Identity used to find, replace, or describe a stored mock. */
export interface MockRef {
  kind: MockKind;
  method: string;
  path: string;
  service: string;
  rpc: string;
}
