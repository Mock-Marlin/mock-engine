/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";

import { DEFAULT_KEY_PREFIX, WORKSPACE_NAME } from "../constants.js";
import { ImportParseError, parseImportFile } from "../import/parse-file.js";
import type { HttpMethod, ImportedEndpoint, ImportedPayload } from "../import/types.js";
import {
  clearWorkspace,
  ImportWriteError,
  prepareImportedEndpoints,
  readRouteIndex,
  storedImportPath,
  type RouteIndexEntry,
} from "../import/write.js";
import type { KeyLayout } from "../keys.js";
import type { MockStore } from "../store.js";
import { listServedMocks } from "./catalog.js";
import {
  draftFromRecord,
  refOf,
  sameRef,
  type GraphqlDraft,
  type GrpcDraft,
  type McpDraft,
  type MockDraft,
  type MockRef,
  type RestDraft,
  type StreamDraft,
} from "./draft.js";

export type ClashPolicy = "reject" | "replace" | "skip";

export interface Clash {
  label: string;
}

export interface SaveResult {
  applied: boolean;
  action: "created" | "replaced" | "skipped" | "rejected";
  label: string;
  clashes: Clash[];
}

export interface ImportResult {
  applied: boolean;
  created: string[];
  replaced: string[];
  skipped: string[];
  clashes: Clash[];
  ignoredDuplicates: number;
}

export interface AdminMock {
  kind: string;
  method: string;
  path: string;
}

/** Admin request that the client should show, including route clashes. */
export class AdminError extends Error {
  readonly status: number;
  readonly clashes: Clash[];

  constructor(message: string, status: number, clashes: Clash[] = []) {
    super(message);
    this.name = "AdminError";
    this.status = status;
    this.clashes = clashes;
  }
}

export async function listWorkspaceNames(store: MockStore, keys: KeyLayout): Promise<string[]> {
  const raw = await store.get(registryKey(keys));
  if (raw === null || raw.length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string").sort();
  } catch {
    return [];
  }
}

export async function createWorkspace(store: MockStore, keys: KeyLayout, name: string): Promise<void> {
  assertWorkspaceName(name);
  const names = await listWorkspaceNames(store, keys);
  if (names.includes(name)) {
    throw new AdminError(`Workspace ${name} already exists`, 409);
  }
  await rememberWorkspace(store, keys, name);
}

export async function deleteWorkspace(store: MockStore, keys: KeyLayout, name: string): Promise<void> {
  assertWorkspaceName(name);
  const names = await listWorkspaceNames(store, keys);
  if (!names.includes(name)) {
    throw new AdminError(`No workspace named ${name}`, 404);
  }
  try {
    await clearWorkspace(store, name, keys);
  } catch (error: unknown) {
    if (error instanceof ImportWriteError) {
      throw new AdminError(error.message, 400);
    }
    throw error;
  }
  await store.set(
    registryKey(keys),
    JSON.stringify(names.filter((item) => item !== name)),
  );
}

export async function rememberWorkspace(store: MockStore, keys: KeyLayout, name: string): Promise<void> {
  assertWorkspaceName(name);
  const names = await listWorkspaceNames(store, keys);
  if (names.includes(name)) {
    return;
  }
  names.push(name);
  names.sort();
  await store.set(registryKey(keys), JSON.stringify(names));
}

export async function listAdminMocks(
  store: MockStore,
  keys: KeyLayout,
  workspace: string,
  basePath: string,
): Promise<AdminMock[]> {
  await assertKnownWorkspace(store, keys, workspace);
  const served = await listServedMocks({ store, workspaceId: workspace, keys, basePath });
  return served.map((mock) => ({
    kind: mock.kind,
    method: mock.method,
    path: mock.kind === "grpc" ? mock.target : relativePath(basePath, workspace, mock.target),
  }));
}

export async function loadDraft(store: MockStore, keys: KeyLayout, workspace: string, ref: MockRef): Promise<MockDraft> {
  await assertKnownWorkspace(store, keys, workspace);
  if (ref.kind === "rest") {
    return loadRest(store, keys, workspace, ref);
  }
  if (ref.kind === "sse" || ref.kind === "websocket" || ref.kind === "chunked") {
    return loadStream(store, keys, workspace, ref.path);
  }
  if (ref.kind === "graphql") {
    return loadGraphql(store, keys, workspace, ref.path);
  }
  if (ref.kind === "mcp") {
    return loadMcp(store, keys, workspace);
  }
  return loadGrpc(store, keys, workspace, ref.service, ref.rpc);
}

export async function saveDraft(
  store: MockStore,
  keys: KeyLayout,
  workspace: string,
  draft: MockDraft,
  policy: ClashPolicy,
  previous?: MockRef,
): Promise<SaveResult> {
  assertWorkspaceName(workspace);
  const label = labelOf(draft);
  const existing = await findClash(store, keys, workspace, draft);
  const same = previous !== undefined && sameRef(previous, refOf(draft));
  if (existing !== null && !same && policy === "reject") {
    return { applied: false, action: "rejected", label, clashes: [{ label: existing }] };
  }
  if (existing !== null && !same && policy === "skip") {
    return { applied: true, action: "skipped", label, clashes: [{ label: existing }] };
  }
  await writeDraft(store, keys, workspace, draft);
  if (previous !== undefined && !sameRef(previous, refOf(draft))) {
    await removeRef(store, keys, workspace, previous);
  }
  await rememberWorkspace(store, keys, workspace);
  return {
    applied: true,
    action: existing === null ? "created" : "replaced",
    label,
    clashes: [],
  };
}

export async function importCollected(
  store: MockStore,
  keys: KeyLayout,
  workspace: string,
  files: readonly { filename: string; text: string }[],
  policy: ClashPolicy,
): Promise<ImportResult> {
  assertWorkspaceName(workspace);
  if (files.length === 0) {
    throw new AdminError("No Postman, OpenAPI, or HAR files were given", 400);
  }
  const parsed: ImportedEndpoint[] = [];
  for (const file of files) {
    try {
      parsed.push(...parseImportFile(file.filename, Buffer.from(file.text, "utf8")));
    } catch (error: unknown) {
      if (error instanceof ImportParseError) {
        throw new AdminError(error.message, 400);
      }
      throw error;
    }
  }
  let rows: ImportedEndpoint[];
  try {
    rows = prepareImportedEndpoints(parsed);
  } catch (error: unknown) {
    if (error instanceof ImportWriteError) {
      throw new AdminError(error.message, 400);
    }
    throw error;
  }
  const clashes: Clash[] = [];
  for (const row of rows) {
    const id = await store.get(keys.route(workspace, row.method, row.path));
    if (id !== null && id.length > 0) {
      clashes.push({ label: `${row.method} ${row.path}` });
    }
  }
  const ignoredDuplicates = parsed.length - rows.length;
  if (clashes.length > 0 && policy === "reject") {
    return { applied: false, created: [], replaced: [], skipped: [], clashes, ignoredDuplicates };
  }
  const created: string[] = [];
  const replaced: string[] = [];
  const skipped: string[] = [];
  let index = readRouteIndex(await store.get(keys.routeIndex(workspace)));
  for (const row of rows) {
    const label = `${row.method} ${row.path}`;
    const current = await store.get(keys.route(workspace, row.method, row.path));
    const exists = current !== null && current.length > 0;
    if (exists && policy === "skip") {
      skipped.push(label);
      continue;
    }
    const id = exists ? current : randomUUID();
    await store.set(keys.route(workspace, row.method, row.path), id);
    await store.set(keys.mock(id), restDocument(row.statusCode, 0, row.headers, row.payload));
    index = upsertIndex(index, { method: row.method, path: row.path, id });
    if (exists) {
      replaced.push(label);
    } else {
      created.push(label);
    }
  }
  await store.set(keys.routeIndex(workspace), JSON.stringify(index));
  await rememberWorkspace(store, keys, workspace);
  return { applied: true, created, replaced, skipped, clashes: [], ignoredDuplicates };
}

export async function removeMock(store: MockStore, keys: KeyLayout, workspace: string, ref: MockRef): Promise<void> {
  await assertKnownWorkspace(store, keys, workspace);
  const removed = await removeRef(store, keys, workspace, ref);
  if (!removed) {
    throw new AdminError(`No mock ${labelOfRef(ref)}`, 404);
  }
}

export function registerAdmin(
  app: FastifyInstance,
  options: { store: MockStore; keys: KeyLayout; basePath: string },
): void {
  const { store, keys, basePath } = options;

  app.get("/_admin/workspaces", async (_request, reply) => {
    await reply.send({ workspaces: await listWorkspaceNames(store, keys) });
  });

  app.post("/_admin/workspaces", async (request, reply) => {
    try {
      const name = stringField(record(request.body)["name"], "name");
      await createWorkspace(store, keys, name);
      await reply.status(201).send({ name });
    } catch (error: unknown) {
      sendFailure(reply, error);
    }
  });

  app.delete<{ Params: { name: string } }>("/_admin/workspaces/:name", async (request, reply) => {
    try {
      await deleteWorkspace(store, keys, request.params.name);
      await reply.send({ deleted: request.params.name });
    } catch (error: unknown) {
      sendFailure(reply, error);
    }
  });

  app.get<{ Params: { name: string } }>("/_admin/workspaces/:name/mocks", async (request, reply) => {
    try {
      const mocks = await listAdminMocks(store, keys, request.params.name, basePath);
      await reply.send({ mocks });
    } catch (error: unknown) {
      sendFailure(reply, error);
    }
  });

  app.get<{ Params: { name: string }; Querystring: Record<string, string | undefined> }>(
    "/_admin/workspaces/:name/draft",
    async (request, reply) => {
      try {
        const draft = await loadDraft(store, keys, request.params.name, refFromQuery(request.query));
        await reply.send({ draft });
      } catch (error: unknown) {
        sendFailure(reply, error);
      }
    },
  );

  app.put<{ Params: { name: string } }>("/_admin/workspaces/:name/draft", async (request, reply) => {
    try {
      const body = record(request.body);
      const draft = readDraft(body["draft"]);
      const policy = policyFrom(body["clash"]);
      const previous = body["previous"] === undefined ? undefined : refFromRecord(body["previous"]);
      const result = await saveDraft(store, keys, request.params.name, draft, policy, previous);
      await reply.status(result.applied ? 200 : 409).send(result);
    } catch (error: unknown) {
      sendFailure(reply, error);
    }
  });

  app.delete<{ Params: { name: string }; Querystring: Record<string, string | undefined> }>(
    "/_admin/workspaces/:name/draft",
    async (request, reply) => {
      try {
        await removeMock(store, keys, request.params.name, refFromQuery(request.query));
        await reply.send({ deleted: true });
      } catch (error: unknown) {
        sendFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    "/_admin/workspaces/:name/import",
    { bodyLimit: 8_000_000 },
    async (request, reply) => {
      try {
        const body = record(request.body);
        const files = fileList(body["files"]);
        const result = await importCollected(store, keys, request.params.name, files, policyFrom(body["clash"]));
        await reply.status(result.applied ? 200 : 409).send(result);
      } catch (error: unknown) {
        sendFailure(reply, error);
      }
    },
  );
}

async function writeDraft(store: MockStore, keys: KeyLayout, workspace: string, draft: MockDraft): Promise<void> {
  if (draft.kind === "rest") {
    await writeRest(store, keys, workspace, draft);
    return;
  }
  if (draft.kind === "sse" || draft.kind === "websocket" || draft.kind === "chunked") {
    await store.set(keys.stream(workspace, draft.path), JSON.stringify(streamDocument(draft)));
    return;
  }
  if (draft.kind === "graphql") {
    await store.set(keys.graphql(workspace, draft.path), JSON.stringify({ sdl: draft.sdl }));
    return;
  }
  if (draft.kind === "mcp") {
    await store.set(keys.mcp(workspace), JSON.stringify(mcpDocument(draft)));
    return;
  }
  if (draft.kind !== "grpc") {
    throw new AdminError("kind must be rest, sse, websocket, chunked, graphql, mcp, or grpc", 400);
  }
  const body = isRecord(draft.body) ? draft.body : { value: draft.body };
  await store.set(
    keys.grpc(workspace, draft.service, draft.rpc),
    JSON.stringify({ responsePayload: body, latencyMs: draft.latencyMs, errorCode: draft.errorCode }),
  );
}

async function writeRest(store: MockStore, keys: KeyLayout, workspace: string, draft: RestDraft): Promise<void> {
  let rows: ImportedEndpoint[];
  try {
    rows = prepareImportedEndpoints([endpointFromRest(draft)]);
  } catch (error: unknown) {
    if (error instanceof ImportWriteError) {
      throw new AdminError(error.message, 400);
    }
    throw error;
  }
  const row = rows[0];
  if (row === undefined) {
    throw new AdminError("Mock could not be stored", 400);
  }
  const current = await store.get(keys.route(workspace, row.method, row.path));
  const id = current !== null && current.length > 0 ? current : randomUUID();
  await store.set(keys.route(workspace, row.method, row.path), id);
  await store.set(keys.mock(id), restDocument(row.statusCode, draft.delayMs, row.headers, row.payload));
  const index = upsertIndex(readRouteIndex(await store.get(keys.routeIndex(workspace))), {
    method: row.method,
    path: row.path,
    id,
  });
  await store.set(keys.routeIndex(workspace), JSON.stringify(index));
}

async function findClash(store: MockStore, keys: KeyLayout, workspace: string, draft: MockDraft): Promise<string | null> {
  if (draft.kind === "rest") {
    const path = storedImportPath(draft.path);
    const id = await store.get(keys.route(workspace, draft.method, path));
    return id !== null && id.length > 0 ? `${draft.method} ${path}` : null;
  }
  if (draft.kind === "sse" || draft.kind === "websocket" || draft.kind === "chunked") {
    const raw = await store.get(keys.stream(workspace, draft.path));
    return raw === null ? null : `${draft.kind} ${draft.path}`;
  }
  if (draft.kind === "graphql") {
    const raw = await store.get(keys.graphql(workspace, draft.path));
    return raw === null ? null : `graphql ${draft.path}`;
  }
  if (draft.kind === "mcp") {
    const raw = await store.get(keys.mcp(workspace));
    return raw === null ? null : "mcp";
  }
  if (draft.kind !== "grpc") {
    return null;
  }
  const raw = await store.get(keys.grpc(workspace, draft.service, draft.rpc));
  return raw === null ? null : `grpc ${draft.service}/${draft.rpc}`;
}

async function removeRef(store: MockStore, keys: KeyLayout, workspace: string, ref: MockRef): Promise<boolean> {
  if (ref.kind === "rest") {
    const id = await store.get(keys.route(workspace, ref.method, ref.path));
    if (id === null || id.length === 0) {
      return false;
    }
    await store.del(keys.route(workspace, ref.method, ref.path));
    await store.del(keys.mock(id));
    const index = readRouteIndex(await store.get(keys.routeIndex(workspace))).filter(
      (entry) => !(entry.method === ref.method && entry.path === ref.path),
    );
    await store.set(keys.routeIndex(workspace), JSON.stringify(index));
    return true;
  }
  if (ref.kind === "sse" || ref.kind === "websocket" || ref.kind === "chunked") {
    return deleteIfPresent(store, keys.stream(workspace, ref.path));
  }
  if (ref.kind === "graphql") {
    return deleteIfPresent(store, keys.graphql(workspace, ref.path));
  }
  if (ref.kind === "mcp") {
    return deleteIfPresent(store, keys.mcp(workspace));
  }
  return deleteIfPresent(store, keys.grpc(workspace, ref.service, ref.rpc));
}

async function deleteIfPresent(store: MockStore, key: string): Promise<boolean> {
  const raw = await store.get(key);
  if (raw === null) {
    return false;
  }
  await store.del(key);
  return true;
}

async function loadRest(store: MockStore, keys: KeyLayout, workspace: string, ref: MockRef): Promise<RestDraft> {
  const id = await store.get(keys.route(workspace, ref.method, ref.path));
  if (id === null || id.length === 0) {
    throw new AdminError(`No mock ${ref.method} ${ref.path}`, 404);
  }
  const raw = await store.get(keys.mock(id));
  if (raw === null) {
    throw new AdminError(`No mock ${ref.method} ${ref.path}`, 404);
  }
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) {
    throw new AdminError("Stored mock is invalid", 500);
  }
  const payload = isRecord(parsed["payload"]) ? parsed["payload"] : {};
  const bodyText = typeof payload["body"] === "string" ? payload["body"] : "";
  const type = payload["type"];
  let body: unknown = bodyText;
  if (type === "json" && bodyText.length > 0) {
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      body = bodyText;
    }
  }
  const headers = isRecord(parsed["headers"]) ? stringMap(parsed["headers"]) : {};
  const method = ref.method;
  if (!isHttpMethodValue(method)) {
    throw new AdminError("Stored method is invalid", 500);
  }
  return {
    kind: "rest",
    method,
    path: ref.path,
    status: typeof parsed["statusCode"] === "number" ? parsed["statusCode"] : 200,
    delayMs: typeof parsed["delayMs"] === "number" ? parsed["delayMs"] : 0,
    headers,
    body,
  };
}

async function loadStream(store: MockStore, keys: KeyLayout, workspace: string, path: string): Promise<StreamDraft> {
  const raw = await store.get(keys.stream(workspace, path));
  if (raw === null) {
    throw new AdminError(`No stream ${path}`, 404);
  }
  const parsed = parseJson(raw);
  if (!isRecord(parsed) || (parsed["protocol"] !== "sse" && parsed["protocol"] !== "websocket" && parsed["protocol"] !== "chunked")) {
    throw new AdminError("Stored stream is invalid", 500);
  }
  const payload = isRecord(parsed["payload"]) ? parsed["payload"] : {};
  return {
    kind: parsed["protocol"],
    path,
    body: typeof payload["body"] === "string" ? payload["body"] : "",
  };
}

async function loadGraphql(store: MockStore, keys: KeyLayout, workspace: string, path: string): Promise<GraphqlDraft> {
  const raw = await store.get(keys.graphql(workspace, path));
  if (raw === null) {
    throw new AdminError(`No graphql mock ${path}`, 404);
  }
  const parsed = parseJson(raw);
  if (!isRecord(parsed) || typeof parsed["sdl"] !== "string") {
    throw new AdminError("Stored GraphQL mock is invalid", 500);
  }
  return { kind: "graphql", path, sdl: parsed["sdl"] };
}

async function loadMcp(store: MockStore, keys: KeyLayout, workspace: string): Promise<McpDraft> {
  const raw = await store.get(keys.mcp(workspace));
  if (raw === null) {
    throw new AdminError("No MCP mock", 404);
  }
  const parsed = parseJson(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed["tools"])) {
    throw new AdminError("Stored MCP mock is invalid", 500);
  }
  const tools = parsed["tools"].map((item) => {
    if (!isRecord(item) || typeof item["name"] !== "string") {
      throw new AdminError("Stored MCP tool is invalid", 500);
    }
    return {
      name: item["name"],
      description: typeof item["description"] === "string" ? item["description"] : "",
      body: item["payload"] === undefined ? {} : item["payload"],
    };
  });
  return {
    kind: "mcp",
    tools,
    resources: Array.isArray(parsed["resources"]) ? parsed["resources"] : [],
    prompts: Array.isArray(parsed["prompts"]) ? parsed["prompts"] : [],
  };
}

async function loadGrpc(store: MockStore, keys: KeyLayout, workspace: string, service: string, rpc: string): Promise<GrpcDraft> {
  const raw = await store.get(keys.grpc(workspace, service, rpc));
  if (raw === null) {
    throw new AdminError(`No gRPC mock ${service}/${rpc}`, 404);
  }
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) {
    throw new AdminError("Stored gRPC mock is invalid", 500);
  }
  const errorCode = parsed["errorCode"];
  return {
    kind: "grpc",
    service,
    rpc,
    latencyMs: typeof parsed["latencyMs"] === "number" ? parsed["latencyMs"] : 0,
    errorCode: typeof errorCode === "string" && errorCode.length > 0 ? errorCode : null,
    body: parsed["responsePayload"] === undefined ? {} : parsed["responsePayload"],
  };
}

function endpointFromRest(draft: RestDraft): ImportedEndpoint {
  return {
    method: draft.method,
    path: draft.path,
    statusCode: draft.status,
    headers: draft.headers,
    payload: payloadFromBody(draft.body),
  };
}

function payloadFromBody(body: unknown): ImportedPayload {
  if (typeof body === "string") {
    return inlinePayload("text", body, "text/plain");
  }
  return inlinePayload("json", JSON.stringify(body === undefined ? {} : body), "application/json");
}

function inlinePayload(type: "json" | "text", body: string, mimeType: string): ImportedPayload {
  return { type, storage: "inline", mimeType, sizeBytes: Buffer.byteLength(body), body };
}

function restDocument(statusCode: number, delayMs: number, headers: Record<string, string>, payload: ImportedPayload): string {
  return JSON.stringify({ statusCode, delayMs, headers, fault: "none", template: false, payload });
}

function streamDocument(draft: StreamDraft): Record<string, unknown> {
  return {
    id: `stream${draft.path}`,
    protocol: draft.kind,
    chunkMode: "whole",
    durationMs: 50,
    payload: { storage: "inline", body: draft.body },
    ...(draft.kind === "chunked" ? { chunkedFormat: "text" } : {}),
  };
}

function mcpDocument(draft: McpDraft): Record<string, unknown> {
  return {
    tools: draft.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: "object" },
      payload: tool.body,
    })),
    resources: draft.resources,
    prompts: draft.prompts,
  };
}

function upsertIndex(entries: readonly RouteIndexEntry[], entry: RouteIndexEntry): RouteIndexEntry[] {
  return [...entries.filter((item) => !(item.method === entry.method && item.path === entry.path)), entry];
}

function labelOf(draft: MockDraft): string {
  return labelOfRef(refOf(draft));
}

function labelOfRef(ref: MockRef): string {
  if (ref.kind === "rest") {
    return `${ref.method} ${ref.path}`;
  }
  if (ref.kind === "grpc") {
    return `grpc ${ref.service}/${ref.rpc}`;
  }
  if (ref.kind === "mcp") {
    return "mcp";
  }
  return `${ref.kind} ${ref.path}`;
}

async function assertKnownWorkspace(store: MockStore, keys: KeyLayout, name: string): Promise<void> {
  assertWorkspaceName(name);
  const names = await listWorkspaceNames(store, keys);
  if (!names.includes(name)) {
    throw new AdminError(`No workspace named ${name}`, 404);
  }
}

function assertWorkspaceName(name: string): void {
  if (!WORKSPACE_NAME.test(name)) {
    throw new AdminError("Workspace names use letters, numbers, dots, underscores, and dashes", 400);
  }
}

function registryKey(keys: KeyLayout): string {
  const sample = keys.route("workspace", "GET", "/");
  const marker = ":route:workspace:";
  const at = sample.indexOf(marker);
  const root = at > 0 ? sample.slice(0, at) : DEFAULT_KEY_PREFIX;
  return `${root}:workspaces`;
}

function relativePath(basePath: string, workspace: string, target: string): string {
  const prefix = `${basePath}/${workspace}`;
  if (target === prefix) {
    return "/";
  }
  if (target.startsWith(`${prefix}/`)) {
    return target.slice(prefix.length);
  }
  return target;
}

function policyFrom(value: unknown): ClashPolicy {
  if (value === undefined || value === "reject") {
    return "reject";
  }
  if (value === "replace" || value === "skip") {
    return value;
  }
  throw new AdminError("clash must be replace, skip, or reject", 400);
}

function fileList(value: unknown): Array<{ filename: string; text: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AdminError("files must list the collections to import", 400);
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new AdminError("each file needs a filename and text", 400);
    }
    return {
      filename: stringField(item["filename"], "filename"),
      text: typeof item["text"] === "string" ? item["text"] : "",
    };
  });
}

function refFromQuery(query: Record<string, string | undefined>): MockRef {
  return refFromRecord({
    kind: query["kind"],
    method: query["method"],
    path: query["path"],
    service: query["service"],
    rpc: query["rpc"],
  });
}

function refFromRecord(value: unknown): MockRef {
  if (!isRecord(value) || typeof value["kind"] !== "string") {
    throw new AdminError("kind is required", 400);
  }
  const kind = value["kind"];
  const method = typeof value["method"] === "string" ? value["method"] : "";
  const path = typeof value["path"] === "string" ? value["path"] : "";
  const service = typeof value["service"] === "string" ? value["service"] : "";
  const rpc = typeof value["rpc"] === "string" ? value["rpc"] : "";
  if (kind === "rest") {
    if (!isHttpMethodValue(method) || path.length === 0) {
      throw new AdminError("REST mocks need a method and path", 400);
    }
    return { kind, method, path, service: "", rpc: "" };
  }
  if (kind === "sse" || kind === "websocket" || kind === "chunked" || kind === "graphql") {
    if (path.length === 0) {
      throw new AdminError("A path is required", 400);
    }
    return { kind, method: kind === "graphql" ? "POST" : "GET", path, service: "", rpc: "" };
  }
  if (kind === "mcp") {
    return { kind, method: "POST", path: "/mcp", service: "", rpc: "" };
  }
  if (kind === "grpc") {
    if (service.length === 0 || rpc.length === 0) {
      throw new AdminError("gRPC mocks need a service and rpc", 400);
    }
    return { kind, method: "RPC", path: `${service}/${rpc}`, service, rpc };
  }
  throw new AdminError("kind must be rest, sse, websocket, chunked, graphql, mcp, or grpc", 400);
}

function sendFailure(reply: FastifyReply, error: unknown): void {
  if (error instanceof AdminError) {
    const body = error.clashes.length > 0 ? { error: error.message, clashes: error.clashes } : { error: error.message };
    void reply.status(error.status).send(body);
    return;
  }
  const message = error instanceof Error ? error.message : "Admin request failed";
  void reply.status(500).send({ error: message });
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AdminError("Expected a JSON object", 400);
  }
  return value;
}

function readDraft(value: unknown): MockDraft {
  try {
    return draftFromRecord(value);
  } catch (error: unknown) {
    if (error instanceof AdminError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Could not read that mock";
    throw new AdminError(message, 400);
  }
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AdminError(`${name} is required`, 400);
  }
  return value.trim();
}

function stringMap(value: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, header] of Object.entries(value)) {
    if (typeof header === "string") {
      headers[key] = header;
    }
  }
  return headers;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isHttpMethodValue(value: string): value is HttpMethod {
  return value === "GET" || value === "HEAD" || value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE" || value === "OPTIONS";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
