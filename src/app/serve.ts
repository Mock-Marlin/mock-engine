/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { seedExamples } from "../examples.js";
import { normalizeBasePath } from "../http.js";
import { parseImportFile } from "../import/parse-file.js";
import type { ImportedEndpoint } from "../import/types.js";
import { clearWorkspace, writeImportedRestMocks } from "../import/write.js";
import { mockEngine, mockEngineWebsocketOptions } from "../index.js";
import { createKeyLayout, type KeyLayout } from "../keys.js";
import { openRedisStore } from "../redis-store.js";
import { DEFAULT_GRPC_PORT, DEFAULT_HOST, DEFAULT_HTTP_PORT, DEFAULT_WORKSPACE, IMPORT_FILE_PATTERN } from "../constants.js";
import { applySpec, discoverSpecFile, loadSpecFile, type MockSpec } from "../spec.js";
import { createMemoryStore, type MockStore } from "../store.js";
import type { MockEngineOptions } from "../types.js";
import { listWorkspaceNames, registerAdmin, rememberWorkspace } from "./admin.js";
import { listServedMocks } from "./catalog.js";
import { startGrpcServer } from "./grpc-server.js";
import type { RunningServer, ServeOptions, StartupSource } from "./serve-types.js";

export { DEFAULT_GRPC_PORT, DEFAULT_HOST, DEFAULT_HTTP_PORT, DEFAULT_WORKSPACE } from "../constants.js";
export type { RunningServer, ServeOptions, StartupSource } from "./serve-types.js";

/**
 * Start a local mock server.
 * Memory is the store unless `store` is passed or `redisUrl` is set.
 * A spec file replaces the built-in examples. So does `importPaths`.
 * With neither, one example of each protocol is seeded.
 * `examples: true` forces those examples and ignores a spec file.
 */
export async function serve(options: ServeOptions = {}): Promise<RunningServer> {
  const host = options.host ?? DEFAULT_HOST;
  const keys = createKeyLayout(options.keyPrefix);
  const opened = await openStore(options);
  const store = opened.store;
  const engine = engineOptions(options, store, keys);
  const importPaths = options.importPaths ?? [];
  let imported: number | null = null;
  let source: StartupSource = "examples";
  let app: ReturnType<typeof Fastify> | null = null;
  let grpc: Awaited<ReturnType<typeof startGrpcServer>> | null = null;
  try {
    const spec = await selectSpec(options);
    const workspace = options.workspace ?? spec?.workspace ?? DEFAULT_WORKSPACE;
    await clearWorkspace(store, workspace, keys);
    if (spec !== null) {
      const endpoints = spec.imports.length > 0 ? await loadImports(spec.imports) : [];
      imported = await applySpec(store, keys, workspace, spec, endpoints);
      source = "spec";
    } else if (options.examples !== true && importPaths.length > 0) {
      const endpoints = await loadImports(importPaths);
      imported = await writeImportedRestMocks(store, workspace, endpoints, keys);
      source = "import";
    } else {
      await seedExamples(store, workspace, keys);
      source = "examples";
    }
    const basePath = normalizeBasePath(options.basePath);
    await rememberWorkspace(store, keys, workspace);
    const mocks = await listServedMocks({ store, workspaceId: workspace, keys, basePath });

    app = Fastify();
    registerAdmin(app, { store, keys, basePath });
    if (options.onTraffic !== undefined) {
      const notify = options.onTraffic;
      app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
        const pathOnly = request.url.split("?")[0] ?? request.url;
        if (pathOnly.startsWith("/_admin")) {
          return;
        }
        notify({
          at: Date.now(),
          kind: "http",
          method: request.method,
          target: pathOnly,
          status: String(reply.statusCode),
          durationMs: Math.max(0, Math.round(reply.elapsedTime)),
        });
      });
    }
    await app.register(websocket, { options: mockEngineWebsocketOptions(engine) });
    await app.register(mockEngine, engine);
    await app.listen({ host, port: options.port ?? DEFAULT_HTTP_PORT });
    const port = boundPort(app.server.address());
    grpc = await startGrpcServer({
      store,
      workspaceId: workspace,
      host,
      port: options.grpcPort ?? DEFAULT_GRPC_PORT,
      keys,
      ...(options.onTraffic === undefined
        ? {}
        : {
            onCall: (event) => {
              options.onTraffic?.({
                at: Date.now(),
                kind: "grpc",
                method: "RPC",
                target: `${event.service}/${event.method}`,
                status: event.status,
                durationMs: event.durationMs,
              });
            },
          }),
    });
    const http = app;
    const grpcServer = grpc;
    const running: RunningServer = {
      host,
      port,
      grpcPort: grpc.port,
      workspace,
      basePath,
      storeKind: opened.kind,
      source,
      imported,
      grpcServices: grpc.serviceCount,
      mocks,
      async reload() {
        running.mocks = await listServedMocks({ store, workspaceId: workspace, keys, basePath });
      },
      async close() {
        await grpcServer.close();
        await http.close();
        await opened.close();
      },
    };
    return running;
  } catch (error: unknown) {
    await grpc?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await opened.close();
    throw error;
  }
}

async function selectSpec(options: ServeOptions): Promise<MockSpec | null> {
  if (options.examples === true) {
    return null;
  }
  const importPaths = options.importPaths ?? [];
  if (options.specPath !== undefined) {
    if (importPaths.length > 0) {
      throw new Error("Pass either a config file or --import, not both");
    }
    return loadSpecFile(options.specPath);
  }
  const found = await discoverSpecFile();
  if (found === null) {
    return null;
  }
  return loadSpecFile(found);
}

export async function loadImports(paths: readonly string[]): Promise<ImportedEndpoint[]> {
  const files = await collectImportFiles(paths);
  const endpoints: ImportedEndpoint[] = [];
  for (const file of files) {
    endpoints.push(...parseImportFile(file.filename, file.buffer));
  }
  return endpoints;
}

export async function collectImportFiles(paths: readonly string[]): Promise<Array<{ filename: string; buffer: Buffer }>> {
  const files: Array<{ filename: string; buffer: Buffer }> = [];
  for (const input of paths) {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(input);
    } catch {
      throw new Error(`Import path not found: ${input}`);
    }
    if (info.isDirectory()) {
      const names = (await readdir(input)).filter((name) => IMPORT_FILE_PATTERN.test(name)).sort();
      if (names.length === 0) {
        throw new Error(`Import directory has no Postman, OpenAPI, or HAR files: ${input}`);
      }
      for (const name of names) {
        const full = path.join(input, name);
        const child = await stat(full);
        if (!child.isFile()) {
          continue;
        }
        files.push({ filename: name, buffer: await readFile(full) });
      }
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`Import path is not a file: ${input}`);
    }
    files.push({ filename: path.basename(input), buffer: await readFile(input) });
  }
  return files;
}

function engineOptions(options: ServeOptions, store: MockStore, keys: KeyLayout): MockEngineOptions {
  const engine: MockEngineOptions = {
    store,
    matchParams: true,
    resolveWorkspaceId: async (key) => {
      const names = await listWorkspaceNames(store, keys);
      return names.includes(key) ? key : null;
    },
  };
  if (options.basePath !== undefined) {
    engine.basePath = options.basePath;
  }
  if (options.keyPrefix !== undefined) {
    engine.keyPrefix = options.keyPrefix;
  }
  return engine;
}

async function openStore(options: ServeOptions): Promise<{ store: MockStore; kind: "memory" | "redis"; close: () => Promise<void> }> {
  if (options.store !== undefined) {
    return { store: options.store, kind: "memory", close: () => Promise.resolve() };
  }
  if (options.redisUrl !== undefined && options.redisUrl.length > 0) {
    const opened = await openRedisStore(options.redisUrl);
    return { store: opened.store, kind: "redis", close: () => opened.close() };
  }
  return { store: createMemoryStore(), kind: "memory", close: () => Promise.resolve() };
}

function boundPort(address: string | { port: number } | null): number {
  if (address === null || typeof address === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return address.port;
}
