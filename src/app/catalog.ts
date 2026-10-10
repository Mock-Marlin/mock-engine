/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { DEFAULT_KEY_PREFIX } from "../constants.js";
import type { KeyLayout } from "../keys.js";
import type { MockStore } from "../store.js";
import type { ServedKind, ServedMock } from "./catalog-types.js";

export type { ServedKind, ServedMock } from "./catalog-types.js";

const KIND_ORDER: Record<ServedKind, number> = {
  rest: 0,
  sse: 1,
  websocket: 2,
  chunked: 3,
  stream: 4,
  graphql: 5,
  mcp: 6,
  grpc: 7,
};

/**
 * Routes currently stored for one workspace.
 * An unlistable store returns an empty catalog.
 */
export async function listServedMocks(options: {
  store: MockStore;
  workspaceId: string;
  keys: KeyLayout;
  basePath: string;
}): Promise<ServedMock[]> {
  if (options.store.list === undefined) {
    return [];
  }
  const root = storeRoot(options.keys);
  const listed = await options.store.list(`${root}:`);
  const routeHead = `${root}:route:${options.workspaceId}:`;
  const streamHead = `${root}:stream:${options.workspaceId}:`;
  const graphqlHead = `${root}:graphql:${options.workspaceId}:`;
  const grpcHead = `${root}:grpc:${options.workspaceId}:`;
  const rows: ServedMock[] = [];

  for (const key of listed) {
    if (key.startsWith(routeHead)) {
      const rest = key.slice(routeHead.length);
      const splitAt = rest.indexOf(":");
      if (splitAt <= 0) {
        continue;
      }
      const method = rest.slice(0, splitAt);
      const route = rest.slice(splitAt + 1);
      if (!route.startsWith("/")) {
        continue;
      }
      rows.push({ kind: "rest", method, target: publicPath(options.basePath, options.workspaceId, route) });
      continue;
    }
    if (key.startsWith(streamHead)) {
      const route = key.slice(streamHead.length);
      if (!route.startsWith("/")) {
        continue;
      }
      const raw = await options.store.get(key);
      rows.push({
        kind: streamKind(raw),
        method: "GET",
        target: publicPath(options.basePath, options.workspaceId, route),
      });
      continue;
    }
    if (key.startsWith(graphqlHead)) {
      const route = key.slice(graphqlHead.length);
      if (!route.startsWith("/")) {
        continue;
      }
      rows.push({
        kind: "graphql",
        method: "POST",
        target: publicPath(options.basePath, options.workspaceId, route),
      });
      continue;
    }
    if (key.startsWith(grpcHead)) {
      const rest = key.slice(grpcHead.length);
      const splitAt = rest.lastIndexOf(":");
      if (splitAt <= 0) {
        continue;
      }
      const service = rest.slice(0, splitAt);
      const method = rest.slice(splitAt + 1);
      if (method.length === 0) {
        continue;
      }
      rows.push({ kind: "grpc", method: "RPC", target: `${service}/${method}` });
    }
  }

  if (listed.includes(options.keys.mcp(options.workspaceId))) {
    rows.push(
      { kind: "mcp", method: "GET", target: publicPath(options.basePath, options.workspaceId, "/mcp/sse") },
      { kind: "mcp", method: "POST", target: publicPath(options.basePath, options.workspaceId, "/mcp/messages") },
    );
  }

  rows.sort((left, right) => {
    const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    if (byKind !== 0) {
      return byKind;
    }
    const byTarget = left.target.localeCompare(right.target);
    if (byTarget !== 0) {
      return byTarget;
    }
    return left.method.localeCompare(right.method);
  });
  return rows;
}

function storeRoot(keys: KeyLayout): string {
  const sample = keys.route("workspace", "GET", "/");
  const marker = ":route:workspace:";
  const at = sample.indexOf(marker);
  return at > 0 ? sample.slice(0, at) : DEFAULT_KEY_PREFIX;
}

function publicPath(basePath: string, workspaceId: string, route: string): string {
  const base = basePath.length > 1 && basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  if (route === "/") {
    return `${base}/${workspaceId}`;
  }
  return `${base}/${workspaceId}${route}`;
}

function streamKind(raw: string | null): ServedKind {
  if (raw === null) {
    return "stream";
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return "stream";
    }
    const protocol = (parsed as { protocol?: unknown }).protocol;
    if (protocol === "sse" || protocol === "websocket" || protocol === "chunked") {
      return protocol;
    }
  } catch {
    return "stream";
  }
  return "stream";
}
