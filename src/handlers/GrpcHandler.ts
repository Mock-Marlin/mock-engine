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
import type { FastifyReply, FastifyRequest } from "fastify";

import { resolveEngineConfig } from "../config.js";
import { delay, headerText, isRecord, storeGet } from "../http.js";
import type { MockEngineOptions } from "../types.js";

interface ProtoFile {
  name: string;
  content: string;
}

interface LoadedMethod {
  serviceName: string;
  methodName: string;
  requestStream: boolean;
  responseStream: boolean;
  responseSerialize: (value: unknown) => Buffer;
}

interface SchemaCache {
  signature: string;
  methods: LoadedMethod[];
}

const PROTO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.proto$/;
const schemaCache = new Map<string, SchemaCache>();

function statusNumber(name: string): number | null {
  const table = grpc.status as unknown as Record<string, number>;
  const code = table[name];
  return typeof code === "number" ? code : null;
}

function parseGrpcSubpath(routePath: string): { service: string; method: string } | null {
  const trimmed = routePath.replace(/^\/+/, "").replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return null;
  }
  const service = trimmed.slice(0, slash);
  const method = trimmed.slice(slash + 1);
  if (service.length === 0 || method.length === 0 || method.includes("/")) {
    return null;
  }
  return { service, method };
}

function frameMessage(payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = 0;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function frameTrailers(status: number, message: string | null): Buffer {
  let trailers = `grpc-status:${String(status)}\r\n`;
  if (message !== null && message.length > 0) {
    trailers += `grpc-message:${encodeURIComponent(message)}\r\n`;
  }
  const body = Buffer.from(trailers);
  const header = Buffer.alloc(5);
  header[0] = 0x80;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function readHot(raw: string): {
  responsePayload: unknown;
  latencyMs: number;
  errorCode: string | null;
} | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }
    const latencyMs = parsed["latencyMs"];
    const errorCode = parsed["errorCode"];
    return {
      responsePayload: parsed["responsePayload"],
      latencyMs: typeof latencyMs === "number" && Number.isFinite(latencyMs) ? latencyMs : 0,
      errorCode: typeof errorCode === "string" && errorCode.length > 0 ? errorCode : null,
    };
  } catch {
    return null;
  }
}

function readSchemaFiles(raw: string | null): ProtoFile[] {
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

function isServiceConstructor(value: unknown): value is grpc.ServiceClientConstructor {
  return typeof value === "function" && "service" in value;
}

function isNamespace(value: unknown): value is grpc.GrpcObject {
  return typeof value === "object" && value !== null && !("format" in value);
}

function collectMethods(root: grpc.GrpcObject, into: LoadedMethod[]): void {
  for (const value of Object.values(root)) {
    if (isServiceConstructor(value)) {
      for (const method of Object.values(value.service)) {
        const parsed = /^\/([^/]+)\/([^/]+)$/.exec(method.path);
        const serviceName = parsed?.[1] ?? value.serviceName;
        const methodName = parsed?.[2] ?? method.originalName ?? "";
        if (serviceName.length === 0 || methodName.length === 0) {
          continue;
        }
        into.push({
          serviceName,
          methodName,
          requestStream: method.requestStream,
          responseStream: method.responseStream,
          responseSerialize: (input: unknown) => method.responseSerialize(input),
        });
      }
      continue;
    }
    if (isNamespace(value)) {
      collectMethods(value, into);
    }
  }
}

async function loadMethods(files: readonly ProtoFile[]): Promise<LoadedMethod[]> {
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
    const methods: LoadedMethod[] = [];
    collectMethods(loaded, methods);
    return methods;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export class GrpcHandler {
  private readonly options: MockEngineOptions;

  constructor(options: MockEngineOptions) {
    this.options = options;
  }

  async handle(request: FastifyRequest, reply: FastifyReply, workspaceId: string, routePath: string): Promise<void> {
    const parsed = parseGrpcSubpath(routePath);
    if (parsed === null) {
      this.writeGrpc(request, reply, grpc.status.UNIMPLEMENTED, "Unknown gRPC method", null);
      return;
    }

    const settings = resolveEngineConfig(this.options);
    const raw = await storeGet(
      this.options.store,
      settings.keys.grpc(workspaceId, parsed.service, parsed.method),
      reply,
      settings.ttl.grpc,
    );
    if (raw === "down") {
      return;
    }
    if (raw === null) {
      this.writeGrpc(request, reply, grpc.status.UNIMPLEMENTED, "No mock configured for this method", null);
      return;
    }
    const hot = readHot(raw);
    if (hot === null) {
      this.writeGrpc(request, reply, grpc.status.INTERNAL, "Mock response is invalid", null);
      return;
    }

    if (hot.latencyMs > 0) {
      await delay(hot.latencyMs);
    }
    if (request.raw.aborted) {
      return;
    }

    if (hot.errorCode !== null && hot.errorCode !== "OK") {
      const code = statusNumber(hot.errorCode);
      this.writeGrpc(request, reply, code ?? grpc.status.UNKNOWN, hot.errorCode, null);
      return;
    }

    if (!isRecord(hot.responsePayload)) {
      this.writeGrpc(request, reply, grpc.status.INTERNAL, "Mock response payload must be a JSON object", null);
      return;
    }

    const method = await this.findMethod(workspaceId, parsed.service, parsed.method, reply);
    if (method === "down") {
      return;
    }
    if (method === null) {
      this.writeGrpc(request, reply, grpc.status.UNIMPLEMENTED, "Proto schema is not cached for this method", null);
      return;
    }
    if (method.requestStream || method.responseStream) {
      this.writeGrpc(request, reply, grpc.status.UNIMPLEMENTED, "Streaming RPCs are not mocked", null);
      return;
    }

    let bytes: Buffer;
    try {
      bytes = method.responseSerialize(hot.responsePayload);
    } catch {
      this.writeGrpc(request, reply, grpc.status.INTERNAL, "Mock response could not be encoded", null);
      return;
    }
    this.writeGrpc(request, reply, grpc.status.OK, null, bytes);
  }

  private async findMethod(
    workspaceId: string,
    service: string,
    method: string,
    reply: FastifyReply,
  ): Promise<LoadedMethod | null | "down"> {
    const settings = resolveEngineConfig(this.options);
    const schemaKey = settings.keys.grpcSchema(workspaceId);
    const raw = await storeGet(this.options.store, schemaKey, reply, settings.ttl.grpcSchema);
    if (raw === "down") {
      return "down";
    }
    const signature = raw ?? "";
    const cached = schemaCache.get(schemaKey);
    let methods = cached !== undefined && cached.signature === signature ? cached.methods : null;
    if (methods === null) {
      const files = readSchemaFiles(raw);
      if (files.length === 0) {
        return null;
      }
      try {
        methods = await loadMethods(files);
      } catch {
        return null;
      }
      schemaCache.set(schemaKey, { signature, methods });
    }
    return methods.find((item) => item.serviceName === service && item.methodName === method) ?? null;
  }

  private writeGrpc(
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    message: string | null,
    payload: Buffer | null,
  ): void {
    const contentType = headerText(request.headers["content-type"]).toLowerCase();
    const web = contentType.includes("grpc-web");
    const text = contentType.includes("grpc-web-text");
    const chunks: Buffer[] = [];
    if (payload !== null && status === grpc.status.OK) {
      chunks.push(frameMessage(payload));
    }
    if (web) {
      chunks.push(frameTrailers(status, message));
    }
    const body = Buffer.concat(chunks);
    const encoded = text ? Buffer.from(body.toString("base64")) : body;
    const headers: Record<string, string> = {
      "content-type": text ? "application/grpc-web-text" : web ? "application/grpc-web+proto" : "application/grpc",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "grpc-status, grpc-message",
    };
    if (!web) {
      headers["grpc-status"] = String(status);
      if (message !== null && message.length > 0) {
        headers["grpc-message"] = encodeURIComponent(message);
      }
    }
    reply.hijack();
    reply.raw.writeHead(200, headers);
    reply.raw.end(encoded);
  }
}
