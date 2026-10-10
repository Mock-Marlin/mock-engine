/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { Readable } from "node:stream";

import type { KeyLayout } from "./keys.js";
import type { MockStore } from "./store.js";

/** Host hook that can replace a stored mock. Return null to send the stored document. */
export type RuleDatasetResolver = (
  context: RequestContext,
  rawMockConfig: any,
) => Promise<ResolvedMockResponse | null>;

/** One public request after the URL workspace key has been resolved to a workspace id. */
export interface RequestContext {
  workspaceId: string;
  method: string;
  path: string;
  headers: Record<string, any>;
  query: Record<string, any>;
  body: any;
}

/** Body to send, or a stored document rewritten in `config` before stream or GraphQL execution. */
export interface ResolvedMockResponse {
  statusCode: number;
  headers?: Record<string, string>;
  payload: unknown;
  delayMs?: number;
  fault?: "none" | "hang" | "reset" | "partial";
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

/** Which protocols the plugin answers. Omitted fields stay enabled. */
export interface ProtocolSwitches {
  rest: boolean;
  stream: boolean;
  graphql: boolean;
  mcp: boolean;
  grpc: boolean;
}

/** Seconds applied with EXPIRE after a successful read. Omit a field, or use 0, to leave expiry alone. */
export interface KeyTtlSeconds {
  route?: number;
  mock?: number;
  stream?: number;
  graphql?: number;
  mcp?: number;
  grpc?: number;
  grpcSchema?: number;
}

/** Options for the mock gateway. The plugin reads `store` and does not open its own database. */
export interface MockEngineOptions {
  store: MockStore;
  basePath?: string;
  keyPrefix?: string;
  keys?: KeyLayout;
  ttl?: KeyTtlSeconds;
  protocols?: Partial<ProtocolSwitches>;
  resolveWorkspaceId: (workspaceKey: string) => Promise<string | null>;
  matchParams?: boolean;
  resolvePayloadOverride?: RuleDatasetResolver;
  onInspectorLog?: (log: InspectorLog) => Promise<void>;
  readStoredObject?: (objectKey: string, workspaceId: string) => Promise<Readable>;
}

export interface EngineSocket {
  readonly readyState?: number;
  send(data: string | Buffer): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "close" | "error", listener: () => void): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
}
