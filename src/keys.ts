/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { DEFAULT_KEY_PREFIX } from "./constants.js";

export { DEFAULT_KEY_PREFIX } from "./constants.js";

/** Names of the Redis keys the engine reads for one workspace. */
export interface KeyLayout {
  route(workspaceId: string, method: string, path: string): string;
  routeIndex(workspaceId: string): string;
  mock(id: string): string;
  stream(workspaceId: string, path: string): string;
  graphql(workspaceId: string, path: string): string;
  mcp(workspaceId: string): string;
  grpc(workspaceId: string, service: string, method: string): string;
  grpcSchema(workspaceId: string): string;
}

/** Build key names under `prefix`. A blank prefix uses `DEFAULT_KEY_PREFIX`. */
export function createKeyLayout(prefix?: string): KeyLayout {
  const root = normalizeKeyPrefix(prefix);
  const join = (...parts: string[]): string => [root, ...parts].join(":");
  return {
    route: (workspaceId, method, path) => join("route", workspaceId, method, path),
    routeIndex: (workspaceId) => join("route-index", workspaceId),
    mock: (id) => join("mock", id),
    stream: (workspaceId, path) => join("stream", workspaceId, path),
    graphql: (workspaceId, path) => join("graphql", workspaceId, path),
    mcp: (workspaceId) => join("mcp", workspaceId),
    grpc: (workspaceId, service, method) => join("grpc", workspaceId, service, method),
    grpcSchema: (workspaceId) => join("grpc-schema", workspaceId),
  };
}

const defaultKeys = createKeyLayout();

export function routeKey(workspaceId: string, method: string, path: string, prefix?: string): string {
  return layoutFor(prefix).route(workspaceId, method, path);
}

export function routeIndexKey(workspaceId: string, prefix?: string): string {
  return layoutFor(prefix).routeIndex(workspaceId);
}

export function mockKey(id: string, prefix?: string): string {
  return layoutFor(prefix).mock(id);
}

export function streamKey(workspaceId: string, path: string, prefix?: string): string {
  return layoutFor(prefix).stream(workspaceId, path);
}

export function graphqlKey(workspaceId: string, path: string, prefix?: string): string {
  return layoutFor(prefix).graphql(workspaceId, path);
}

export function mcpKey(workspaceId: string, prefix?: string): string {
  return layoutFor(prefix).mcp(workspaceId);
}

export function grpcHotKey(workspaceId: string, service: string, method: string, prefix?: string): string {
  return layoutFor(prefix).grpc(workspaceId, service, method);
}

export function grpcSchemaKey(workspaceId: string, prefix?: string): string {
  return layoutFor(prefix).grpcSchema(workspaceId);
}

function layoutFor(prefix: string | undefined): KeyLayout {
  return prefix === undefined ? defaultKeys : createKeyLayout(prefix);
}

function normalizeKeyPrefix(prefix: string | undefined): string {
  if (prefix === undefined) {
    return DEFAULT_KEY_PREFIX;
  }
  const trimmed = prefix.trim().replace(/:+$/, "");
  return trimmed.length === 0 ? DEFAULT_KEY_PREFIX : trimmed;
}
