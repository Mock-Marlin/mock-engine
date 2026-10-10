/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { INLINE_MAX_BYTES, payloadFromUtf8 } from "./payload.js";
import { isHttpMethod, type ImportedEndpoint, type ImportedPayload } from "./types.js";

const MAX_FOLDER_DEPTH = 32;
const EMPTY_JSON = "{}";

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const WHOLE_PARAM = /^(?:\{\{([A-Za-z_][A-Za-z0-9_-]*)\}\}|\{([A-Za-z_][A-Za-z0-9_-]*)\}|:([A-Za-z_][A-Za-z0-9_-]*))$/;
const LITERAL_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const LEADING_BASE = /^\{\{[^{}]+\}\}/;

type TextPayloadType = "json" | "text" | "html" | "xml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(fileBuffer: Buffer): unknown {
  const text = fileBuffer.toString("utf8").replace(/^\uFEFF/, "");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Postman collection is not valid JSON");
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * One path segment becomes either a literal or a `:param`.
 * `{{id}}`, `{id}`, and `:id` are the same Fastify parameter.
 */
function fastifySegment(segment: string): string | null {
  const decoded = decodeSegment(segment.trim());
  if (decoded.length === 0 || decoded === "." || decoded === "..") {
    return null;
  }

  const param = WHOLE_PARAM.exec(decoded);
  const name = param?.[1] ?? param?.[2] ?? param?.[3];
  if (name !== undefined) {
    return PARAM_NAME.test(name) ? `:${name}` : null;
  }

  return LITERAL_SEGMENT.test(decoded) ? decoded : null;
}

function joinSegments(parts: readonly string[]): string | null {
  const segments: string[] = [];
  for (const part of parts) {
    if (part.length === 0) {
      continue;
    }
    const segment = fastifySegment(part);
    if (segment === null) {
      return null;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * `{{baseUrl}}/users/{{id}}` keeps the path after the leading host variable.
 * Absolute URLs keep only the pathname. Query strings and hashes are dropped.
 */
function pathFromRaw(raw: string): string | null {
  let value = raw.trim();
  if (value.length === 0) {
    return null;
  }

  const hashAt = value.indexOf("#");
  if (hashAt >= 0) {
    value = value.slice(0, hashAt);
  }
  const queryAt = value.indexOf("?");
  if (queryAt >= 0) {
    value = value.slice(0, queryAt);
  }
  value = value.trim();
  if (value.length === 0) {
    return null;
  }

  if (ABSOLUTE_URL.test(value)) {
    try {
      return joinSegments(new URL(value).pathname.split("/"));
    } catch {
      return null;
    }
  }

  const leadingBase = LEADING_BASE.exec(value);
  if (leadingBase !== null && value.slice(leadingBase[0].length).startsWith("/")) {
    value = value.slice(leadingBase[0].length);
  }

  return joinSegments(value.split("/"));
}

function pathFromUrl(url: unknown): string | null {
  if (typeof url === "string") {
    return pathFromRaw(url);
  }
  if (!isRecord(url)) {
    return null;
  }

  const path = url["path"];
  if (Array.isArray(path) && path.length > 0) {
    const parts: string[] = [];
    for (const part of path) {
      if (typeof part !== "string") {
        return null;
      }
      parts.push(part);
    }
    return joinSegments(parts);
  }
  if (typeof path === "string" && path.length > 0) {
    return joinSegments(path.split("/"));
  }
  if (typeof url["raw"] === "string") {
    return pathFromRaw(url["raw"]);
  }
  return null;
}

function responseHeaders(header: unknown): Record<string, string> {
  if (!Array.isArray(header)) {
    return {};
  }

  const headers: Record<string, string> = {};
  for (const entry of header) {
    if (!isRecord(entry) || entry["disabled"] === true) {
      continue;
    }
    const keySource = entry["key"] ?? entry["name"];
    const value = entry["value"];
    if (typeof keySource !== "string" || typeof value !== "string") {
      continue;
    }
    const key = keySource.trim();
    if (key.length === 0 || key.includes("\r") || key.includes("\n") || value.includes("\r") || value.includes("\n")) {
      continue;
    }
    const previous = Object.keys(headers).find((name) => name.toLowerCase() === key.toLowerCase());
    if (previous !== undefined) {
      delete headers[previous];
    }
    headers[key] = value;
  }
  return headers;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function mediaType(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

function hintFromMediaType(mime: string | undefined): TextPayloadType | undefined {
  if (mime === "text/html") {
    return "html";
  }
  if (mime === "application/xml" || mime === "text/xml" || mime?.endsWith("+xml") === true) {
    return "xml";
  }
  if (mime === "text/plain") {
    return "text";
  }
  if (mime === "application/json" || mime?.endsWith("+json") === true) {
    return "json";
  }
  return undefined;
}

function isJsonText(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function inlinePayload(body: string, type: TextPayloadType, where: string): ImportedPayload {
  if (Buffer.byteLength(body, "utf8") >= INLINE_MAX_BYTES) {
    throw new Error(`Postman example body for ${where} exceeds the 1MB inline limit`);
  }
  const payload = payloadFromUtf8(body, type);
  const imported: ImportedPayload = {
    type: payload.type,
    storage: "inline",
    sizeBytes: payload.sizeBytes,
    body: payload.body,
  };
  if (payload.mimeType !== undefined) {
    imported.mimeType = payload.mimeType;
  }
  return imported;
}

function emptyPayload(): ImportedPayload {
  return inlinePayload(EMPTY_JSON, "json", "empty payload");
}

function exampleBody(example: Record<string, unknown>): string | null {
  const body = example["body"];
  if (typeof body === "string") {
    return body.length === 0 ? null : body;
  }
  if (body === null || body === undefined) {
    return null;
  }
  if (typeof body === "number" || typeof body === "boolean" || typeof body === "object") {
    const serialized = JSON.stringify(body);
    return serialized.length === 0 ? null : serialized;
  }
  return null;
}

function payloadFromExample(example: Record<string, unknown> | null, where: string): ImportedPayload {
  if (example === null) {
    return emptyPayload();
  }
  const body = exampleBody(example);
  if (body === null) {
    return emptyPayload();
  }

  const mime = mediaType(headerValue(responseHeaders(example["header"]), "content-type"));
  const hinted = hintFromMediaType(mime);
  if (hinted === "html" || hinted === "xml" || hinted === "text") {
    return inlinePayload(body, hinted, where);
  }
  if (isJsonText(body)) {
    return inlinePayload(body, "json", where);
  }
  return inlinePayload(body, "text", where);
}

function statusFrom(example: Record<string, unknown> | null): number {
  const code = example?.["code"];
  if (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) {
    return code;
  }
  return 200;
}

function firstExample(item: Record<string, unknown>): Record<string, unknown> | null {
  const response = item["response"];
  if (!Array.isArray(response)) {
    return null;
  }
  const example = response[0];
  return isRecord(example) ? example : null;
}

function endpointFromItem(item: Record<string, unknown>, request: Record<string, unknown>): ImportedEndpoint | null {
  const methodSource = request["method"];
  if (typeof methodSource !== "string") {
    return null;
  }
  const method = methodSource.toUpperCase();
  if (!isHttpMethod(method)) {
    return null;
  }

  const path = pathFromUrl(request["url"]);
  if (path === null) {
    return null;
  }

  const example = firstExample(item);
  const where = `${method} ${path}`;
  const endpoint: ImportedEndpoint = {
    method,
    path,
    headers: responseHeaders(example?.["header"]),
    statusCode: statusFrom(example),
    payload: payloadFromExample(example, where),
  };
  return endpoint;
}

function walkItems(items: unknown[], endpoints: ImportedEndpoint[], depth: number): void {
  if (depth > MAX_FOLDER_DEPTH) {
    throw new Error("Postman collection is nested too deeply");
  }

  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const children = item["item"];
    if (Array.isArray(children)) {
      walkItems(children, endpoints, depth + 1);
    }
    const request = item["request"];
    if (isRecord(request)) {
      const endpoint = endpointFromItem(item, request);
      if (endpoint !== null) {
        endpoints.push(endpoint);
      }
    }
  }
}

/**
 * Flatten a Postman v2.1 collection into REST endpoints.
 * Folders are walked depth-first. Requests without a supported method or
 * a usable path are skipped. The first saved example supplies status,
 * response headers, and body. A request with no example gets `{}`.
 */
export function parsePostman(fileBuffer: Buffer): ImportedEndpoint[] {
  const collection = parseJson(fileBuffer);
  if (!isRecord(collection) || !Array.isArray(collection["item"])) {
    throw new Error("Postman collection is missing an item array");
  }

  const endpoints: ImportedEndpoint[] = [];
  walkItems(collection["item"], endpoints, 0);
  return endpoints;
}
