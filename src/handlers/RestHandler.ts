/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import { acquireHeldSocket, releaseHeldSocket } from "../held-sockets.js";
import { delay, documentGuardHeaders, escapeMarkup, filterPublicResponseHeaders, isRecord, stringHeaders } from "../http.js";
import { applyRestTemplate } from "../rest/template.js";
import type { InspectorLog, MockEngineOptions, RequestContext, ResolvedMockResponse } from "../types.js";

const DEFAULT_MATCHED_RULE_NAME = "Default";
const HANG_CAP_MS = 60_000;
const PARTIAL_FRACTION = 0.3;

const DEFAULT_CONTENT_TYPE: Record<string, string> = {
  json: "application/json; charset=utf-8",
  text: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  binary: "application/octet-stream",
};

interface StoredPayload {
  type: string;
  storage: "inline" | "object";
  mimeType?: string;
  sizeBytes: number;
  body: string;
}

export interface RestServeInput {
  path: string;
  mockId: string;
  config: Record<string, unknown>;
  context: RequestContext;
}

function isStoredPayload(value: unknown): value is StoredPayload {
  if (!isRecord(value) || typeof value["body"] !== "string" || typeof value["type"] !== "string") {
    return false;
  }
  return value["storage"] === "inline" || value["storage"] === "object";
}

function contentTypeFor(payload: StoredPayload): string {
  if (typeof payload.mimeType === "string" && payload.mimeType.length > 0) {
    return payload.mimeType;
  }
  return DEFAULT_CONTENT_TYPE[payload.type] ?? "application/octet-stream";
}

function applyResponseHeaders(reply: FastifyReply, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(filterPublicResponseHeaders(headers))) {
    reply.header(name, value);
  }
}

function stringHeaderMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value)) {
    if (typeof header === "string") {
      headers[name] = header;
    }
  }
  return headers;
}

function templatePayload(payload: StoredPayload, method: string, path: string, context: RequestContext): StoredPayload {
  if (payload.storage !== "inline" || payload.type === "binary") {
    return payload;
  }
  const markup = payload.type === "html" || payload.type === "xml";
  return {
    ...payload,
    body: applyRestTemplate(
      payload.body,
      method,
      path,
      {
        headers: stringHeaders(context.headers),
        query: context.query,
        body: context.body,
      },
      markup ? escapeMarkup : undefined,
    ),
  };
}

function templateHeaders(
  headers: Record<string, string>,
  method: string,
  path: string,
  context: RequestContext,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    next[name] = applyRestTemplate(value, method, path, {
      headers: stringHeaders(context.headers),
      query: context.query,
      body: context.body,
    });
  }
  return next;
}

function hangUntilAbort(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (!acquireHeldSocket()) {
    return Promise.resolve(false);
  }
  const rawReq = request.raw;
  const rawRes = reply.raw;
  rawReq.setTimeout(0);
  rawRes.setTimeout(0);
  reply.hijack();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rawReq.off("close", finish);
      rawReq.off("aborted", finish);
      if (!rawRes.writableEnded && !rawRes.destroyed) {
        rawRes.destroy();
      }
      releaseHeldSocket();
      resolve(true);
    };
    const timer = setTimeout(finish, HANG_CAP_MS);
    rawReq.on("close", finish);
    rawReq.on("aborted", finish);
  });
}

function resetSocket(reply: FastifyReply): void {
  reply.hijack();
  if (!reply.raw.destroyed) {
    reply.raw.destroy();
  }
}

function cutAfterFlush(raw: FastifyReply["raw"]): void {
  const socket = raw.socket;
  if (socket && !socket.destroyed) {
    socket.destroy();
    return;
  }
  if (!raw.destroyed) {
    raw.destroy();
  }
}

function writePartialBytes(
  raw: FastifyReply["raw"],
  statusCode: number,
  head: Record<string, string>,
  bytes: Buffer,
  fullLength: number,
  cut: number,
): void {
  raw.writeHead(statusCode, {
    ...head,
    "Content-Length": String(fullLength),
    Connection: "close",
  });
  raw.write(bytes.subarray(0, Math.min(cut, bytes.length)), () => {
    cutAfterFlush(raw);
  });
}

function writePartial(
  reply: FastifyReply,
  statusCode: number,
  headers: Record<string, string>,
  payload: StoredPayload,
): void {
  reply.hijack();
  const raw = reply.raw;
  if (raw.destroyed) {
    return;
  }

  const contentType = contentTypeFor(payload);
  const head: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Content-Type": contentType,
    ...filterPublicResponseHeaders(headers),
    ...documentGuardHeaders(contentType),
  };

  if (payload.storage !== "inline") {
    raw.writeHead(statusCode, head);
    cutAfterFlush(raw);
    return;
  }

  if (payload.type === "binary") {
    const bytes = Buffer.from(payload.body, "base64");
    const cut = Math.max(1, Math.floor(bytes.length * PARTIAL_FRACTION));
    writePartialBytes(raw, statusCode, head, bytes, bytes.length, cut);
    return;
  }

  const full = Buffer.from(payload.body);
  const cut = Math.max(1, Math.floor(full.length * PARTIAL_FRACTION));
  writePartialBytes(raw, statusCode, head, full, full.length, cut);
}

function missingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const named = error as { name?: unknown; code?: unknown };
  return named.name === "MissingStoredObjectError" || named.code === "STORED_OBJECT_MISSING";
}

export class RestHandler {
  private readonly options: MockEngineOptions;

  constructor(options: MockEngineOptions) {
    this.options = options;
  }

  async handle(request: FastifyRequest, reply: FastifyReply, input: RestServeInput): Promise<void> {
    const override = await this.override(input.context, input.config);
    const statusCode = override?.statusCode ?? readNumber(input.config["statusCode"], 200);
    const delayMs = override?.delayMs ?? readNumber(input.config["delayMs"], 0);
    const fault = override?.fault ?? readFault(input.config["fault"]);
    const payloadSource = override !== null && isStoredPayload(override.payload) ? override.payload : input.config["payload"];
    if (!isStoredPayload(payloadSource)) {
      await reply.status(500).send({
        error: "Internal Server Error",
        message: "Mock payload is invalid",
      });
      return;
    }

    let payload = payloadSource;
    let headers = override?.headers ?? stringHeaderMap(input.config["headers"]);
    const requestPath = (request.url.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
    if (input.config["template"] === true) {
      payload = templatePayload(payload, request.method, requestPath, input.context);
      headers = templateHeaders(headers, request.method, requestPath, input.context);
    }

    await this.log(input, override);

    if (delayMs > 0) {
      await delay(delayMs);
    }

    if (fault === "hang") {
      const held = await hangUntilAbort(request, reply);
      if (!held) {
        await reply.status(503).send({
          error: "Service Unavailable",
          message: "Too many open connections",
        });
      }
      return;
    }
    if (fault === "reset") {
      resetSocket(reply);
      return;
    }
    if (fault === "partial") {
      writePartial(reply, statusCode, headers, payload);
      return;
    }

    applyResponseHeaders(reply, headers);
    reply.header("Access-Control-Allow-Origin", "*");
    reply.status(statusCode);
    await this.sendPayload(reply, payload, input.context.workspaceId);
  }

  private async override(context: RequestContext, config: Record<string, unknown>): Promise<ResolvedMockResponse | null> {
    if (this.options.resolvePayloadOverride === undefined) {
      return null;
    }
    return this.options.resolvePayloadOverride(context, config);
  }

  private async log(input: RestServeInput, override: ResolvedMockResponse | null): Promise<void> {
    if (this.options.onInspectorLog === undefined) {
      return;
    }
    const entry: InspectorLog = {
      kind: "rest",
      id: input.mockId,
      method: input.context.method,
      headers: stringHeaders(input.context.headers),
      query: input.context.query,
      body: input.context.body,
      timestamp: new Date().toISOString(),
      matchedRuleId: override?.matchedRuleId ?? null,
      matchedRuleName: override?.matchedRuleName ?? DEFAULT_MATCHED_RULE_NAME,
    };
    try {
      await this.options.onInspectorLog(entry);
    } catch {
      // Inspector must never fail the mock response.
    }
  }

  private async sendPayload(reply: FastifyReply, payload: StoredPayload, workspaceId: string): Promise<void> {
    if (payload.storage === "object") {
      if (this.options.readStoredObject === undefined) {
        await reply.status(404).send({
          error: "Not Found",
          message: "Stored payload is missing",
        });
        return;
      }
      try {
        const stream = await this.options.readStoredObject(payload.body, workspaceId);
        reply.type(contentTypeFor(payload));
        reply.header("Content-Length", String(payload.sizeBytes));
        await reply.send(stream);
      } catch (error: unknown) {
        if (missingObject(error)) {
          await reply.status(404).send({
            error: "Not Found",
            message: "Stored payload is missing",
          });
          return;
        }
        throw error;
      }
      return;
    }

    reply.type(contentTypeFor(payload));
    if (payload.type === "binary") {
      const bytes = Buffer.from(payload.body, "base64");
      reply.header("Content-Length", String(bytes.length));
      await reply.send(bytes);
      return;
    }
    await reply.send(payload.body);
  }
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readFault(value: unknown): "none" | "hang" | "reset" | "partial" {
  if (value === "hang" || value === "reset" || value === "partial" || value === "none") {
    return value;
  }
  return "none";
}
