/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import type { MockStore } from "./store.js";

const ROUTE_PATH_PATTERN = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/;
const MAX_ROUTE_PATH_LENGTH = 256;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export function normalizeBasePath(basePath: string | undefined): string {
  const raw = basePath ?? "/s";
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0 || !trimmed.startsWith("/")) {
    return "/s";
  }
  return trimmed;
}

export function normalizeRoutePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "/";
  }
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailing = withLeading.replace(/\/+$/, "");
  return withoutTrailing.length === 0 ? "/" : withoutTrailing;
}

export function isValidRoutePath(path: string): boolean {
  return path.length > 0 && path.length <= MAX_ROUTE_PATH_LENGTH && ROUTE_PATH_PATTERN.test(path);
}

export function isHttpMethod(value: string): boolean {
  return HTTP_METHODS.has(value);
}

export function remainingPath(request: FastifyRequest, basePath: string, workspaceKey: string): string {
  const params: unknown = request.params;
  if (typeof params === "object" && params !== null) {
    const splat = (params as { "*"?: unknown })["*"];
    if (typeof splat === "string") {
      return normalizeRoutePath(splat);
    }
  }

  const pathOnly = (request.url.split("?")[0] ?? "").replace(/\/+$/, "");
  const prefix = `${basePath}/${workspaceKey}`;
  if (pathOnly === prefix) {
    return "/";
  }
  if (pathOnly.startsWith(`${prefix}/`)) {
    return normalizeRoutePath(pathOnly.slice(prefix.length));
  }
  return "/";
}

export function applyPermissiveCors(reply: FastifyReply): void {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
  reply.header("Access-Control-Allow-Headers", "*");
  reply.header("Access-Control-Expose-Headers", "grpc-status, grpc-message, grpc-status-details-bin");
  reply.header("Access-Control-Max-Age", "86400");
}

export function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function sendNotFound(reply: FastifyReply, message: string): Promise<void> {
  await reply.status(404).send({
    error: "Not Found",
    message,
  });
}

/** Positive finite seconds become an integer TTL. Anything else means "do not touch expiry". */
export function activeTtl(seconds: number | undefined): number | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return Math.floor(seconds);
}

/**
 * Read one key. When `ttlSeconds` is a positive number and the key exists,
 * set its expiry to that many seconds. A missing key is left alone.
 */
export async function readStoreValue(
  store: MockStore,
  key: string,
  ttlSeconds: number | undefined,
): Promise<string | null> {
  const value = await store.get(key);
  const ttl = activeTtl(ttlSeconds);
  if (value !== null && ttl !== undefined) {
    await store.expire(key, ttl);
  }
  return value;
}

export async function storeGet(
  store: MockStore,
  key: string,
  reply: FastifyReply,
  ttlSeconds?: number | undefined,
): Promise<string | null | "down"> {
  try {
    return await readStoreValue(store, key, ttlSeconds);
  } catch {
    await reply.status(503).send({
      error: "Service Unavailable",
      message: "Mock store is unreachable",
    });
    return "down";
  }
}

export function headerText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : "";
  }
  return "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringHeaders(headers: Record<string, unknown>): Record<string, string> {
  const flattened: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      flattened[name] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const parts = value.filter((item): item is string => typeof item === "string");
      if (parts.length > 0) {
        flattened[name] = parts.join(", ");
      }
    }
  }
  return flattened;
}

export function queryRecord(query: unknown): Record<string, any> {
  if (!isRecord(query)) {
    return {};
  }
  return query;
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_HEADER_NAME = 128;
const MAX_HEADER_VALUE = 4096;

/** Headers a public mock must not set. These would apply on the app host. */
const BLOCKED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "set-cookie2",
  "cookie",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-content-type-options",
  "referrer-policy",
  "strict-transport-security",
  "x-frame-options",
  "report-to",
  "nel",
  "public-key-pins",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "trailer",
  "te",
  "host",
  "access-control-allow-credentials",
  "x-mockmarlin-trusted-document",
]);

const SANDBOX_CSP =
  "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PLAYGROUND_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function escapeMarkup(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function filterPublicResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.length === 0 || name.length > MAX_HEADER_NAME || !HEADER_NAME.test(name)) {
      continue;
    }
    if (BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    if (value.length > MAX_HEADER_VALUE || /[\r\n\0]/.test(value)) {
      continue;
    }
    next[name] = value;
  }
  return next;
}

export function isDocumentContentType(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "text/html" || type === "image/svg+xml" || type === "application/xhtml+xml";
}

/** Headers for a hijacked raw response. Normal replies use {@link applyPublicGatewayGuard}. */
export function documentGuardHeaders(contentType: string): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (isDocumentContentType(contentType)) {
    headers["Content-Security-Policy"] = SANDBOX_CSP;
    headers["X-Frame-Options"] = "DENY";
  }
  return headers;
}

/**
 * Stop a public mock from acting as the logged-in app.
 * HTML and SVG run in a unique sandbox origin. The GraphQL playground is the
 * one trusted document, and it keeps a script policy without that sandbox.
 */
export function applyPublicGatewayGuard(reply: FastifyReply): void {
  const trusted = headerText(reply.getHeader("x-mockmarlin-trusted-document")) === "playground";
  reply.removeHeader("set-cookie");
  reply.removeHeader("x-mockmarlin-trusted-document");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  if (trusted) {
    reply.header("Content-Security-Policy", PLAYGROUND_CSP);
    reply.header("X-Frame-Options", "DENY");
    return;
  }
  if (isDocumentContentType(headerText(reply.getHeader("content-type")))) {
    reply.header("Content-Security-Policy", SANDBOX_CSP);
    reply.header("X-Frame-Options", "DENY");
  }
}
