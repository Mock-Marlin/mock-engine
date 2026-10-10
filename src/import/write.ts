/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { randomUUID } from "node:crypto";

import { createKeyLayout, type KeyLayout } from "../keys.js";
import type { MockStore } from "../store.js";
import type { HttpMethod, ImportedEndpoint } from "./types.js";

const IMPORT_PATH =
  /^\/(?:(?:[A-Za-z0-9._~-]+|:[A-Za-z_][A-Za-z0-9_-]*)(?:\/(?:[A-Za-z0-9._~-]+|:[A-Za-z_][A-Za-z0-9_-]*))*)?$/;

const PARAM_SEGMENT = /^:[A-Za-z_][A-Za-z0-9_-]*$/;

export class ImportWriteError extends Error {
  readonly code = "IMPORT_WRITE" as const;

  constructor(message: string) {
    super(message);
    this.name = "ImportWriteError";
  }
}

export interface RouteIndexEntry {
  method: HttpMethod;
  path: string;
  id: string;
}

/** Drop the query string and hash. The public router matches the pathname. */
export function storedImportPath(path: string): string {
  const withoutQuery = path.split("?")[0] ?? "";
  const withoutHash = withoutQuery.split("#")[0] ?? "";
  const trimmed = withoutHash.trim();
  if (trimmed.length === 0) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailing = withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
  return withoutTrailing.length === 0 ? "/" : withoutTrailing;
}

/**
 * Normalize parser output into the rows a writer will store.
 * Query strings are removed. The first method + path wins.
 */
export function prepareImportedEndpoints(imported: readonly ImportedEndpoint[]): ImportedEndpoint[] {
  const rows: ImportedEndpoint[] = [];
  const seen = new Set<string>();
  for (const endpoint of imported) {
    const path = storedImportPath(endpoint.path);
    if (!IMPORT_PATH.test(path) || path.length > 512) {
      throw new ImportWriteError(`Path ${endpoint.path} cannot be stored`);
    }
    if (!Number.isInteger(endpoint.statusCode) || endpoint.statusCode < 100 || endpoint.statusCode > 599) {
      throw new ImportWriteError(`Status for ${endpoint.method} ${path} is invalid`);
    }
    const key = `${endpoint.method} ${path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push({
      method: endpoint.method,
      path,
      statusCode: endpoint.statusCode,
      headers: endpoint.headers,
      payload: endpoint.payload,
    });
  }
  return rows;
}

export function patternMatches(pattern: string, actual: string): boolean {
  const left = pathSegments(pattern);
  const right = pathSegments(actual);
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const expected = left[index];
    const got = right[index];
    if (expected === undefined || got === undefined) {
      return false;
    }
    if (PARAM_SEGMENT.test(expected)) {
      continue;
    }
    if (expected !== got) {
      return false;
    }
  }
  return true;
}

export function matchRouteIndex(
  entries: readonly RouteIndexEntry[],
  method: string,
  path: string,
): string | null {
  for (const entry of entries) {
    if (entry.method === method && patternMatches(entry.path, path) && entry.id.length > 0) {
      return entry.id;
    }
  }
  return null;
}

export function readRouteIndex(raw: string | null): RouteIndexEntry[] {
  if (raw === null || raw.length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const entries: RouteIndexEntry[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const method = record["method"];
      const path = record["path"];
      const id = record["id"];
      if (typeof method !== "string" || typeof path !== "string" || typeof id !== "string" || id.length === 0) {
        continue;
      }
      entries.push({ method: method as HttpMethod, path, id });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Replace one workspace's REST mocks with these endpoints.
 * Parameter paths are stored in the route index. Exact paths are also
 * written as route keys so a lookup can hit them without scanning.
 */
export async function writeImportedRestMocks(
  store: MockStore,
  workspaceId: string,
  imported: readonly ImportedEndpoint[],
  keys: KeyLayout = createKeyLayout(),
): Promise<number> {
  const rows = prepareImportedEndpoints(imported);
  const previous = readRouteIndex(await store.get(keys.routeIndex(workspaceId)));
  for (const entry of previous) {
    await store.del(keys.route(workspaceId, entry.method, entry.path));
    await store.del(keys.mock(entry.id));
  }

  const index: RouteIndexEntry[] = [];
  for (const endpoint of rows) {
    const id = randomUUID();
    await store.set(keys.route(workspaceId, endpoint.method, endpoint.path), id);
    await store.set(
      keys.mock(id),
      JSON.stringify({
        statusCode: endpoint.statusCode,
        delayMs: 0,
        headers: endpoint.headers,
        fault: "none",
        template: false,
        payload: endpoint.payload,
      }),
    );
    index.push({ method: endpoint.method, path: endpoint.path, id });
  }
  await store.set(keys.routeIndex(workspaceId), JSON.stringify(index));
  return rows.length;
}

/**
 * Delete every document this layout stored for one workspace.
 * Mock bodies are addressed by id, so route keys are read before they are removed.
 */
export async function clearWorkspace(store: MockStore, workspaceId: string, keys: KeyLayout = createKeyLayout()): Promise<void> {
  if (store.list === undefined) {
    throw new ImportWriteError("This store cannot list keys");
  }
  const sample = keys.route(workspaceId, "GET", "/");
  const marker = `:route:${workspaceId}:`;
  const at = sample.indexOf(marker);
  const root = at > 0 ? sample.slice(0, at) : "";
  const listed = await store.list(`${root}:`);
  const routePrefix = `${root}:route:${workspaceId}:`;
  const mockIds: string[] = [];
  for (const key of listed) {
    if (!key.startsWith(routePrefix)) {
      continue;
    }
    const id = await store.get(key);
    if (id !== null && id.length > 0) {
      mockIds.push(id);
    }
  }
  const indexed = readRouteIndex(await store.get(keys.routeIndex(workspaceId)));
  for (const entry of indexed) {
    mockIds.push(entry.id);
  }
  for (const id of mockIds) {
    await store.del(keys.mock(id));
  }
  const prefixes = [
    routePrefix,
    `${root}:stream:${workspaceId}:`,
    `${root}:graphql:${workspaceId}:`,
    `${root}:grpc:${workspaceId}:`,
  ];
  const exact = new Set([keys.mcp(workspaceId), keys.grpcSchema(workspaceId), keys.routeIndex(workspaceId)]);
  for (const key of listed) {
    if (exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) {
      await store.del(key);
    }
  }
  await store.del(keys.routeIndex(workspaceId));
}

function pathSegments(path: string): string[] {
  if (path === "/") {
    return [];
  }
  return path.split("/").filter((part) => part.length > 0);
}
