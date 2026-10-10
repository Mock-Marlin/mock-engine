/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import type { KeyLayout } from "../keys.js";
import type { MockStore } from "../store.js";

interface ProtoFile {
  name: string;
  content: string;
}

const PROTO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.proto$/;

export interface GrpcCallEvent {
  service: string;
  method: string;
  status: string;
  durationMs: number;
}

export interface GrpcListener {
  port: number;
  serviceCount: number;
  close(): Promise<void>;
}

/**
 * Native unary gRPC server for one workspace.
 * With no proto in the store it still listens and reports zero services.
 */
export async function startGrpcServer(options: {
  store: MockStore;
  workspaceId: string;
  host: string;
  port: number;
  keys: KeyLayout;
  onCall?: (event: GrpcCallEvent) => void;
}): Promise<GrpcListener> {
  const files = await readSchemaFiles(options.store, options.keys.grpcSchema(options.workspaceId));
  const server = new grpc.Server();
  let serviceCount = 0;
  if (files.length > 0) {
    const services = await loadServices(files);
    for (const service of services) {
      server.addService(service.service, implementation(service, options));
      serviceCount += 1;
    }
  }
  const bound = await bind(server, options.host, options.port);
  return {
    port: bound,
    serviceCount,
    async close() {
      await new Promise<void>((resolve) => {
        server.tryShutdown(() => {
          resolve();
        });
      });
    },
  };
}

function implementation(
  service: grpc.ServiceClientConstructor,
  options: {
    store: MockStore;
    workspaceId: string;
    keys: KeyLayout;
    onCall?: (event: GrpcCallEvent) => void;
  },
): grpc.UntypedServiceImplementation {
  const handlers: grpc.UntypedServiceImplementation = {};
  for (const [name, method] of Object.entries(service.service)) {
    const parsed = /^\/([^/]+)\/([^/]+)$/.exec(method.path);
    const serviceName = parsed?.[1] ?? "";
    const methodName = parsed?.[2] ?? "";
    if (method.requestStream || method.responseStream) {
      handlers[name] = (call: grpc.ServerDuplexStream<unknown, unknown>) => {
        call.emit("error", statusError(grpc.status.UNIMPLEMENTED, "Streaming RPCs are not mocked"));
      };
      continue;
    }
    handlers[name] = (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      const started = Date.now();
      void respond(
        call,
        (error, value) => {
          reportCall(options.onCall, serviceName, methodName, error, started);
          callback(error, value);
        },
        options,
        serviceName,
        methodName,
      );
    };
  }
  return handlers;
}

async function respond(
  _call: grpc.ServerUnaryCall<unknown, unknown>,
  callback: grpc.sendUnaryData<unknown>,
  options: { store: MockStore; workspaceId: string; keys: KeyLayout },
  serviceName: string,
  methodName: string,
): Promise<void> {
  if (serviceName.length === 0 || methodName.length === 0) {
    callback(statusError(grpc.status.UNIMPLEMENTED, "Unknown gRPC method"));
    return;
  }
  let raw: string | null;
  try {
    raw = await options.store.get(options.keys.grpc(options.workspaceId, serviceName, methodName));
  } catch {
    callback(statusError(grpc.status.UNAVAILABLE, "Mock store is unreachable"));
    return;
  }
  if (raw === null) {
    callback(statusError(grpc.status.UNIMPLEMENTED, "No mock configured for this method"));
    return;
  }
  const hot = readHot(raw);
  if (hot === null) {
    callback(statusError(grpc.status.INTERNAL, "Mock response is invalid"));
    return;
  }
  if (hot.latencyMs > 0) {
    await delay(hot.latencyMs);
  }
  if (hot.errorCode !== null && hot.errorCode !== "OK") {
    const table = grpc.status as unknown as Record<string, number>;
    const code = table[hot.errorCode];
    callback(statusError(typeof code === "number" ? code : grpc.status.UNKNOWN, hot.errorCode));
    return;
  }
  if (!isRecord(hot.responsePayload)) {
    callback(statusError(grpc.status.INTERNAL, "Mock response payload must be a JSON object"));
    return;
  }
  callback(null, hot.responsePayload);
}

function bind(server: grpc.Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.bindAsync(`${host}:${String(port)}`, grpc.ServerCredentials.createInsecure(), (error, bound) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(bound);
    });
  });
}

async function loadServices(files: readonly ProtoFile[]): Promise<grpc.ServiceClientConstructor[]> {
  const directory = await mkdtemp(path.join(tmpdir(), "mockmarlin-grpc-"));
  try {
    const paths: string[] = [];
    for (const file of files) {
      const filePath = path.join(directory, file.name);
      await writeFile(filePath, file.content, "utf8");
      paths.push(filePath);
    }
    const packageDefinition = await protoLoader.load(paths, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [directory],
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition);
    const services: grpc.ServiceClientConstructor[] = [];
    collectServices(loaded, services);
    return services;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function collectServices(root: grpc.GrpcObject, into: grpc.ServiceClientConstructor[]): void {
  for (const value of Object.values(root)) {
    if (isServiceConstructor(value)) {
      into.push(value);
      continue;
    }
    if (isNamespace(value)) {
      collectServices(value, into);
    }
  }
}

function isServiceConstructor(value: unknown): value is grpc.ServiceClientConstructor {
  return typeof value === "function" && "service" in value;
}

function isNamespace(value: unknown): value is grpc.GrpcObject {
  return typeof value === "object" && value !== null && !("format" in value);
}

async function readSchemaFiles(store: MockStore, key: string): Promise<ProtoFile[]> {
  const raw = await store.get(key);
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed["files"])) {
      return [];
    }
    const files: ProtoFile[] = [];
    for (const item of parsed["files"]) {
      if (!isRecord(item) || typeof item["name"] !== "string" || typeof item["content"] !== "string") {
        continue;
      }
      if (!PROTO_NAME.test(item["name"])) {
        continue;
      }
      files.push({ name: item["name"], content: item["content"] });
    }
    return files;
  } catch {
    return [];
  }
}

function readHot(raw: string): { responsePayload: unknown; latencyMs: number; errorCode: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }
    const latency = parsed["latencyMs"];
    const errorCode = parsed["errorCode"];
    return {
      responsePayload: parsed["responsePayload"],
      latencyMs: typeof latency === "number" && Number.isFinite(latency) ? latency : 0,
      errorCode: typeof errorCode === "string" && errorCode.length > 0 ? errorCode : null,
    };
  } catch {
    return null;
  }
}

function reportCall(
  onCall: ((event: GrpcCallEvent) => void) | undefined,
  service: string,
  method: string,
  error: unknown,
  started: number,
): void {
  if (onCall === undefined) {
    return;
  }
  onCall({
    service,
    method,
    status: grpcStatusName(error),
    durationMs: Math.max(0, Date.now() - started),
  });
}

function grpcStatusName(error: unknown): string {
  if (error === null || error === undefined) {
    return "OK";
  }
  if (typeof error !== "object" || !("code" in error) || typeof error.code !== "number") {
    return "UNKNOWN";
  }
  const named = grpc.status[error.code];
  return typeof named === "string" ? named : "UNKNOWN";
}

function statusError(code: number, message: string): grpc.ServiceError {
  const error = new Error(message) as grpc.ServiceError;
  error.code = code;
  error.details = message;
  error.metadata = new grpc.Metadata();
  return error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
