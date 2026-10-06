/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { Readable } from "node:stream";

import type { Redis } from "ioredis";

import type { KeyLayout } from "./keys.js";

/**
 * Optional callback that can replace a stored mock before it is sent.
 *
 * The engine reads the document store and this callback. It does not evaluate
 * rules and it does not open a database. Return a response to replace the
 * loaded document. Return `null` when the stored payload, status, headers, and
 * delay should be served as written.
 *
 * `rawMockConfig` is the stored JSON for the matched route: a REST mock, a
 * stream document, a GraphQL document, or one MCP tool. `context.body` is
 * the HTTP body, or the GraphQL operation / tool arguments when the handler
 * invokes the hook for one call.
 */
export type RuleDatasetResolver = (
  context: RequestContext,
  rawMockConfig: any,
) => Promise<ResolvedMockResponse | null>;

/**
 * One public request after the URL workspace key has been resolved to a workspace id.
 * Header names are lower-case. `query` and `body` are whatever Fastify parsed.
 */
export interface RequestContext {
  /** Workspace id returned by {@link MockEngineOptions.resolveWorkspaceId}. */
  workspaceId: string;
  /** HTTP method, for example `GET` or `POST`. */
  method: string;
  /** Route under the workspace, such as `/users` or `/mcp/messages`. `/` is the workspace root. */
  path: string;
  /** Incoming headers. Values are strings. Multi-value headers are joined with a comma. */
  headers: Record<string, any>;
  /** Parsed query string. Empty object when the request has no query. */
  query: Record<string, any>;
  /** Parsed body. A string for unknown content types, an object for JSON, or `undefined` when absent. */
  body: any;
}

/** Finished body, or a rewritten Redis document in `config`. */
export interface ResolvedMockResponse {
  statusCode: number;
  headers?: Record<string, string>;
  payload: unknown;
  delayMs?: number;
  fault?: "none" | "hang" | "reset" | "partial";
  /** Replaces the Redis document before stream or GraphQL execution. */
  config?: unknown;
  matchedRuleId?: string | null;
  matchedRuleName?: string | null;
}

export interface InspectorLog {
  kind: "rest" | "stream";
  id: string;
  method?: string;
  protocol?: string;
  headers: Record<string, string>;
  query: unknown;
  body?: unknown;
  timestamp: string;
  matchedRuleId: string | null;
  matchedRuleName: string;
}

/** Which protocols the plugin will answer. Omitted fields stay enabled. */
export interface ProtocolSwitches {
  /** REST mocks looked up by method and path. */
  rest: boolean;
  /** Server-Sent Events, WebSocket, and chunked HTTP. */
  stream: boolean;
  /** GraphQL HTTP, the HTML playground, and `graphql-transport-ws`. */
  graphql: boolean;
  /** MCP over SSE at `mcp/sse` and `mcp/messages`. */
  mcp: boolean;
  /** Unary gRPC-Web calls. */
  grpc: boolean;
}

/**
 * Seconds applied with Redis `EXPIRE` after a successful read of that key.
 * Omit a field, or omit {@link MockEngineOptions.ttl} entirely, and the engine
 * leaves that key's expiry untouched. Persistent mocks are stored without an
 * expiry and stay up until they are deleted. `0` and negative numbers also
 * leave expiry untouched. Memory mode ignores these values.
 */
export interface KeyTtlSeconds {
  route?: number;
  mock?: number;
  stream?: number;
  graphql?: number;
  mcp?: number;
  grpc?: number;
  grpcSchema?: number;
}

/**
 * Options shared by Redis mode and memory mode.
 *
 * Register the plugin on a Fastify app that already has `@fastify/websocket`.
 * The plugin only reads documents. In Redis mode it refreshes a key's TTL when
 * {@link MockEngineOptions.ttl} asks it to. Memory mode serves the snapshot in
 * `data` and ignores TTL.
 */
interface MockEngineCommonOptions {
  /**
   * URL prefix for every protocol. Defaults to `/s`.
   * A workspace is then served at `{basePath}/{workspaceKey}/...`.
   */
  basePath?: string;
  /**
   * Key namespace. Defaults to `mockmarlin`, which produces keys such as
   * `mockmarlin:route:{workspaceId}:{METHOD}:{path}`. Ignored when {@link keys} is set.
   */
  keyPrefix?: string;
  /**
   * Replaces the key names entirely. Use this when a prefix is not enough.
   * When set, {@link keyPrefix} is ignored.
   */
  keys?: KeyLayout;
  /**
   * Refresh Redis expiry after a successful read. Omit it and stored TTLs stay as written.
   * Do not set this for mocks that should stay until they are turned off.
   * Memory mode ignores this option.
   */
  ttl?: KeyTtlSeconds;
  /**
   * Turn protocols off. Omitted fields stay on. A disabled protocol is not looked up.
   * `mcp/*` and `Content-Type: application/grpc` answer 404 when that protocol is off,
   * instead of falling through to REST.
   */
  protocols?: Partial<ProtocolSwitches>;
  /**
   * Map the workspace key from the URL to the workspace id stored in document keys.
   * Return `null` when the workspace does not exist. The engine answers 404
   * and does not read the document store.
   */
  resolveWorkspaceId: (workspaceKey: string) => Promise<string | null>;
  /**
   * Optional rules and dataset hook. When it returns a response, that
   * response is served. When it returns `null`, or when this option is
   * omitted, the engine serves the stored document unchanged.
   */
  resolvePayloadOverride?: RuleDatasetResolver;
  /**
   * Fire-and-forget inspector hook for accepted REST and stream traffic.
   * The engine still sends the mock response if this rejects.
   */
  onInspectorLog?: (log: InspectorLog) => Promise<void>;
  /**
   * Reads an object-storage payload by key for this workspace. Required for
   * REST mocks whose payload `storage` is `object`. The package does not
   * import an S3 client. Refuse keys the workspace does not own.
   */
  readStoredObject?: (objectKey: string, workspaceId: string) => Promise<Readable>;
}

/**
 * Options for the mock gateway.
 *
 * Omit `mode`, or set it to `"redis"`, and pass an `ioredis` client. Set
 * `mode` to `"memory"` and pass `data` to serve a static snapshot with no
 * Redis client. The two modes are mutually exclusive.
 */
export type MockEngineOptions = MockEngineCommonOptions &
  (
    | {
        /** `"redis"` reads `redis`. Omitted means Redis. */
        mode?: "redis";
        /** Shared Redis connection. The engine reads mock documents and does not create its own client. */
        redis: Redis;
        data?: never;
      }
    | {
        /** `"memory"` reads the copied `data` map and never contacts Redis. */
        mode: "memory";
        redis?: never;
        /**
         * Static documents copied when the plugin and the WebSocket handshake open.
         * Keys and string values match the Redis layout. Later edits to this object
         * do not change a running server.
         */
        data: Readonly<Record<string, string>>;
      }
  );

export interface EngineSocket {
  readonly readyState?: number;
  send(data: string | Buffer): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "close" | "error", listener: () => void): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
}
