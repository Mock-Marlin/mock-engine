/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { INLINE_MAX_BYTES, payloadFromUtf8 } from "./payload.js";
import { isHttpMethod, type ImportedEndpoint, type ImportedPayload } from "./types.js";

const EMPTY_JSON = "{}";
const LITERAL_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const MIME_TYPE = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/;

type TextPayloadType = "json" | "text" | "html" | "xml";

interface ParsedEntry {
  endpoint: ImportedEndpoint;
  dedupeKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(fileBuffer: Buffer): unknown {
  const text = fileBuffer.toString("utf8").replace(/^\uFEFF/, "");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("HAR file is not valid JSON");
  }
}

function base64DecodedLength(body: string): number | null {
  if (body.length === 0) {
    return 0;
  }
  if (body.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    return null;
  }
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return (body.length / 4) * 3 - padding;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Pathname only. Query is appended later and is not a route segment. */
function normalizePathname(pathname: string): string | null {
  const segments: string[] = [];
  for (const part of pathname.split("/")) {
    if (part.length === 0) {
      continue;
    }
    const decoded = decodeSegment(part);
    if (decoded === "." || decoded === ".." || !LITERAL_SEGMENT.test(decoded)) {
      return null;
    }
    segments.push(decoded);
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function pathFromRequestUrl(raw: string): { path: string; pathname: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  const pathname = normalizePathname(url.pathname);
  if (pathname === null) {
    return null;
  }
  return { path: `${pathname}${url.search}`, pathname };
}

function responseHeaders(header: unknown): Record<string, string> {
  if (!Array.isArray(header)) {
    return {};
  }
  const headers: Record<string, string> = {};
  for (const entry of header) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = entry["name"];
    const value = entry["value"];
    if (typeof name !== "string" || typeof value !== "string") {
      continue;
    }
    const key = name.trim();
    if (key.length === 0 || key.includes("\r") || key.includes("\n") || value.includes("\r") || value.includes("\n")) {
      continue;
    }
    const previous = Object.keys(headers).find((existing) => existing.toLowerCase() === key.toLowerCase());
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

function bareMime(value: string | undefined): string | undefined {
  const mime = value?.split(";")[0]?.trim().toLowerCase();
  if (mime === undefined || mime.length === 0 || !MIME_TYPE.test(mime)) {
    return undefined;
  }
  return mime;
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

function withMime(payload: ImportedPayload, mime: string | undefined): ImportedPayload {
  if (mime !== undefined) {
    payload.mimeType = mime;
  }
  return payload;
}

function textPayload(body: string, mime: string | undefined): ImportedPayload | null {
  if (Buffer.byteLength(body, "utf8") >= INLINE_MAX_BYTES) {
    return null;
  }
  const hinted = hintFromMediaType(mime);
  const type: TextPayloadType =
    hinted === "html" || hinted === "xml" || hinted === "text" ? hinted : isJsonText(body) ? "json" : "text";
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

function binaryPayload(text: string, mime: string | undefined): ImportedPayload | null {
  const body = text.replace(/\s/g, "");
  const sizeBytes = base64DecodedLength(body);
  if (sizeBytes === null || sizeBytes >= INLINE_MAX_BYTES) {
    return null;
  }
  const imported: ImportedPayload = {
    type: "binary",
    storage: "inline",
    sizeBytes,
    body,
  };
  return withMime(imported, mime ?? "application/octet-stream");
}

function emptyPayload(): ImportedPayload {
  const payload = payloadFromUtf8(EMPTY_JSON, "json");
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

function payloadFromContent(content: unknown, mimeHint: string | undefined): ImportedPayload | null {
  if (!isRecord(content)) {
    return emptyPayload();
  }
  const mime = bareMime(typeof content["mimeType"] === "string" ? content["mimeType"] : mimeHint);
  const text = content["text"];
  if (typeof text !== "string" || text.length === 0) {
    return emptyPayload();
  }
  const encoding = content["encoding"];
  if (typeof encoding === "string" && encoding.toLowerCase() === "base64") {
    return binaryPayload(text, mime);
  }
  return textPayload(text, mime);
}

function statusFrom(response: Record<string, unknown>): number | null {
  const status = response["status"];
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    return status;
  }
  return null;
}

function entryFrom(entry: Record<string, unknown>): ParsedEntry | null {
  const request = entry["request"];
  const response = entry["response"];
  if (!isRecord(request) || !isRecord(response)) {
    return null;
  }
  const methodSource = request["method"];
  if (typeof methodSource !== "string") {
    return null;
  }
  const method = methodSource.toUpperCase();
  if (!isHttpMethod(method)) {
    return null;
  }
  if (typeof request["url"] !== "string") {
    return null;
  }
  const routed = pathFromRequestUrl(request["url"]);
  if (routed === null) {
    return null;
  }
  const statusCode = statusFrom(response);
  if (statusCode === null) {
    return null;
  }

  const headers = responseHeaders(response["headers"]);
  const payload = payloadFromContent(response["content"], headerValue(headers, "content-type"));
  if (payload === null) {
    return null;
  }

  return {
    dedupeKey: `${method} ${routed.pathname}`,
    endpoint: {
      method,
      path: routed.path,
      headers,
      statusCode,
      payload,
    },
  };
}

/**
 * Normalize a Chrome HAR file into REST endpoints.
 * The host is dropped. The stored path keeps the query string.
 * The same method and pathname keep the first entry that can be stored.
 */
export function parseHAR(fileBuffer: Buffer): ImportedEndpoint[] {
  const document = parseJson(fileBuffer);
  if (!isRecord(document) || !isRecord(document["log"]) || !Array.isArray(document["log"]["entries"])) {
    throw new Error("HAR file is missing log.entries");
  }

  const endpoints: ImportedEndpoint[] = [];
  const seen = new Set<string>();
  for (const entry of document["log"]["entries"]) {
    if (!isRecord(entry)) {
      continue;
    }
    const parsed = entryFrom(entry);
    if (parsed === null || seen.has(parsed.dedupeKey)) {
      continue;
    }
    seen.add(parsed.dedupeKey);
    endpoints.push(parsed.endpoint);
  }
  return endpoints;
}
