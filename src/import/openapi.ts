/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { JSON_SCHEMA, load } from "js-yaml";

import { INLINE_MAX_BYTES, payloadFromUtf8 } from "./payload.js";
import { isHttpMethod, type ImportedEndpoint, type ImportedPayload } from "./types.js";

const EMPTY_JSON = "{}";
const MAX_SCHEMA_DEPTH = 8;
const METHOD_ORDER = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const BRACE_PARAM = /^\{([A-Za-z_][A-Za-z0-9_-]*)\}$/;
const COLON_PARAM = /^:([A-Za-z_][A-Za-z0-9_-]*)$/;
const LITERAL_SEGMENT = /^[A-Za-z0-9._~-]+$/;

const DANGEROUS_KEY = new Set(["__proto__", "constructor", "prototype"]);

type FoundValue = { found: true; value: unknown } | { found: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDocument(fileString: string): Record<string, unknown> {
  const text = fileString.replace(/^\uFEFF/, "");
  let parsed: unknown;
  try {
    parsed = load(text, {
      schema: JSON_SCHEMA,
      json: true,
      maxAliases: 100,
      maxDepth: 100,
    });
  } catch (error: unknown) {
    throw new Error("OpenAPI document is not valid YAML or JSON", { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error("OpenAPI document is missing a paths object");
  }
  return parsed;
}

function assertOpenApi3(document: Record<string, unknown>): void {
  const swagger = document["swagger"];
  if (swagger !== undefined) {
    throw new Error("OpenAPI 3.x document required");
  }
  const version = document["openapi"];
  if (version !== undefined && (typeof version !== "string" || !version.startsWith("3."))) {
    throw new Error("OpenAPI 3.x document required");
  }
}

function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function pointer(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let current: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = unescapePointer(raw);
    if (DANGEROUS_KEY.has(key)) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function resolveLocal(
  value: unknown,
  root: Record<string, unknown>,
  stack: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const ref = value["$ref"];
  if (typeof ref !== "string") {
    return value;
  }
  if (!ref.startsWith("#/") || stack.includes(ref)) {
    return null;
  }
  const target = pointer(root, ref);
  if (!isRecord(target)) {
    return null;
  }
  return resolveLocal(target, root, [...stack, ref]);
}

function dereferenceSchema(
  schema: unknown,
  root: Record<string, unknown>,
  stack: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(schema)) {
    return null;
  }
  const ref = schema["$ref"];
  if (typeof ref !== "string") {
    return schema;
  }
  if (!ref.startsWith("#/") || stack.includes(ref)) {
    return null;
  }
  const target = pointer(root, ref);
  const resolved = dereferenceSchema(target, root, [...stack, ref]);
  if (resolved === null) {
    return null;
  }

  const overlay: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref" || DANGEROUS_KEY.has(key)) {
      continue;
    }
    overlay[key] = value;
  }
  if (Object.keys(overlay).length === 0) {
    return resolved;
  }
  return { ...resolved, ...overlay };
}

function schemaType(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const entry of value) {
    if (typeof entry === "string" && entry !== "null") {
      return entry;
    }
  }
  return value.includes("null") ? "null" : undefined;
}

function sampleObject(
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
  stack: readonly string[],
  depth: number,
): Record<string, unknown> {
  const properties = schema["properties"];
  const result: Record<string, unknown> = {};
  if (!isRecord(properties)) {
    return result;
  }
  for (const [key, property] of Object.entries(properties)) {
    if (DANGEROUS_KEY.has(key)) {
      continue;
    }
    const sample = sampleFromSchema(property, root, stack, depth + 1);
    if (sample !== undefined) {
      result[key] = sample;
    }
  }
  return result;
}

function sampleAllOf(
  parts: readonly unknown[],
  root: Record<string, unknown>,
  stack: readonly string[],
  depth: number,
): unknown {
  const merged: Record<string, unknown> = {};
  let sawObject = false;
  let primitive: unknown = undefined;
  for (const part of parts) {
    const sample = sampleFromSchema(part, root, stack, depth + 1);
    if (sample === undefined) {
      continue;
    }
    if (isRecord(sample)) {
      for (const [key, value] of Object.entries(sample)) {
        if (!DANGEROUS_KEY.has(key)) {
          merged[key] = value;
        }
      }
      sawObject = true;
    } else if (primitive === undefined) {
      primitive = sample;
    }
  }
  if (sawObject) {
    return merged;
  }
  return primitive;
}

/**
 * Build a JSON value from an OpenAPI schema when the response has no example.
 * Cycles and external `$ref`s become a missing sample (`undefined`).
 */
function sampleFromSchema(
  schema: unknown,
  root: Record<string, unknown>,
  stack: readonly string[],
  depth: number,
): unknown {
  if (depth > MAX_SCHEMA_DEPTH) {
    return undefined;
  }
  const ref = isRecord(schema) && typeof schema["$ref"] === "string" ? schema["$ref"] : undefined;
  if (ref !== undefined && stack.includes(ref)) {
    return undefined;
  }
  const resolved = dereferenceSchema(schema, root, stack);
  if (resolved === null) {
    return undefined;
  }
  const nextStack = ref !== undefined ? [...stack, ref] : stack;
  if ("example" in resolved) {
    return resolved["example"];
  }
  if ("const" in resolved) {
    return resolved["const"];
  }
  if (Array.isArray(resolved["enum"]) && resolved["enum"].length > 0) {
    return resolved["enum"][0];
  }
  if ("default" in resolved) {
    return resolved["default"];
  }
  if (Array.isArray(resolved["allOf"])) {
    const combined = sampleAllOf(resolved["allOf"], root, nextStack, depth);
    if (!isRecord(resolved["properties"])) {
      return combined;
    }
    const own = sampleObject(resolved, root, nextStack, depth);
    if (!isRecord(combined)) {
      return own;
    }
    return { ...combined, ...own };
  }

  const union = Array.isArray(resolved["oneOf"])
    ? resolved["oneOf"]
    : Array.isArray(resolved["anyOf"])
      ? resolved["anyOf"]
      : null;
  if (union !== null && union.length > 0) {
    return sampleFromSchema(union[0], root, nextStack, depth + 1);
  }

  const typeName = schemaType(resolved["type"]);
  if (typeName === "object" || (typeName === undefined && isRecord(resolved["properties"]))) {
    return sampleObject(resolved, root, nextStack, depth);
  }
  if (typeName === "array") {
    if (resolved["items"] === undefined) {
      return [];
    }
    const item = sampleFromSchema(resolved["items"], root, nextStack, depth + 1);
    return item === undefined ? [] : [item];
  }
  if (typeName === "string") {
    return "";
  }
  if (typeName === "integer" || typeName === "number") {
    return 0;
  }
  if (typeName === "boolean") {
    return false;
  }
  if (typeName === "null") {
    return null;
  }
  if (isRecord(resolved["properties"])) {
    return sampleObject(resolved, root, nextStack, depth);
  }
  return undefined;
}

function firstExampleValue(examples: unknown, root: Record<string, unknown>): FoundValue {
  if (!isRecord(examples)) {
    return { found: false };
  }
  for (const entry of Object.values(examples)) {
    if (!isRecord(entry)) {
      continue;
    }
    const resolved = typeof entry["$ref"] === "string" ? resolveLocal(entry, root, []) : entry;
    if (resolved !== null && "value" in resolved) {
      return { found: true, value: resolved["value"] };
    }
  }
  return { found: false };
}

function readJsonExample(media: Record<string, unknown>, root: Record<string, unknown>): FoundValue {
  if ("example" in media) {
    return { found: true, value: media["example"] };
  }
  const fromExamples = firstExampleValue(media["examples"], root);
  if (fromExamples.found) {
    return fromExamples;
  }
  if (media["schema"] === undefined) {
    return { found: false };
  }
  const sample = sampleFromSchema(media["schema"], root, [], 0);
  if (sample === undefined) {
    return { found: false };
  }
  return { found: true, value: sample };
}

function jsonMedia(content: unknown): Record<string, unknown> | null {
  if (!isRecord(content)) {
    return null;
  }
  let vendor: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(content)) {
    if (!isRecord(value)) {
      continue;
    }
    const mime = key.split(";")[0]?.trim().toLowerCase();
    if (mime === "application/json") {
      return value;
    }
    if (vendor === null && mime?.endsWith("+json") === true) {
      vendor = value;
    }
  }
  return vendor;
}

function headerString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function addHeader(headers: Record<string, string>, name: string, value: string): void {
  const key = name.trim();
  if (
    key.length === 0 ||
    DANGEROUS_KEY.has(key) ||
    key.includes("\r") ||
    key.includes("\n") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    return;
  }
  const previous = Object.keys(headers).find((existing) => existing.toLowerCase() === key.toLowerCase());
  if (previous !== undefined) {
    delete headers[previous];
  }
  headers[key] = value;
}

function responseHeaders(response: Record<string, unknown>, root: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  const source = response["headers"];
  if (!isRecord(source)) {
    return headers;
  }
  for (const [name, raw] of Object.entries(source)) {
    if (!isRecord(raw)) {
      continue;
    }
    const header = typeof raw["$ref"] === "string" ? resolveLocal(raw, root, []) : raw;
    if (header === null) {
      continue;
    }
    const direct = "example" in header ? headerString(header["example"]) : null;
    if (direct !== null) {
      addHeader(headers, name, direct);
      continue;
    }
    const fromExamples = firstExampleValue(header["examples"], root);
    const fromExample = fromExamples.found ? headerString(fromExamples.value) : null;
    if (fromExample !== null) {
      addHeader(headers, name, fromExample);
    }
  }
  return headers;
}

function inlinePayload(body: string, where: string): ImportedPayload {
  if (Buffer.byteLength(body, "utf8") >= INLINE_MAX_BYTES) {
    throw new Error(`OpenAPI example body for ${where} exceeds the 1MB inline limit`);
  }
  const payload = payloadFromUtf8(body, "json");
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
  return inlinePayload(EMPTY_JSON, "empty payload");
}

function payloadFromValue(value: unknown, where: string): ImportedPayload {
  let body: string;
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") {
      return emptyPayload();
    }
    body = serialized;
  } catch (error: unknown) {
    throw new Error(`OpenAPI example for ${where} is not JSON`, { cause: error });
  }
  return inlinePayload(body, where);
}

function pickSuccess(
  responses: unknown,
  root: Record<string, unknown>,
): { status: number; response: Record<string, unknown> } | null {
  if (!isRecord(responses)) {
    return null;
  }
  const extra = Object.keys(responses)
    .filter((code) => /^2\d\d$/.test(code) && code !== "200" && code !== "201")
    .sort();
  const order = ["200", "201", ...extra, "default"];
  for (const code of order) {
    if (!Object.hasOwn(responses, code)) {
      continue;
    }
    const raw = responses[code];
    const response = isRecord(raw) ? resolveLocal(raw, root, []) : null;
    if (response === null) {
      continue;
    }
    const status = code === "default" ? 200 : Number(code);
    return { status, response };
  }
  return null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function fastifySegment(segment: string): string | null {
  const decoded = decodeSegment(segment.trim());
  if (decoded.length === 0 || decoded === "." || decoded === "..") {
    return null;
  }
  const brace = BRACE_PARAM.exec(decoded);
  const colon = COLON_PARAM.exec(decoded);
  const name = brace?.[1] ?? colon?.[1];
  if (name !== undefined) {
    return PARAM_NAME.test(name) ? `:${name}` : null;
  }
  return LITERAL_SEGMENT.test(decoded) ? decoded : null;
}

/** `/users/{id}` becomes `/users/:id`. A bad segment drops the whole path. */
function openApiPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const segments: string[] = [];
  for (const part of withSlash.split("/")) {
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

function endpointFromOperation(
  method: string,
  path: string,
  operation: Record<string, unknown>,
  root: Record<string, unknown>,
): ImportedEndpoint | null {
  if (!isHttpMethod(method)) {
    return null;
  }
  const success = pickSuccess(operation["responses"], root);
  if (success === null) {
    return null;
  }

  const where = `${method} ${path}`;
  const media = jsonMedia(success.response["content"]);
  const example = media === null ? { found: false as const } : readJsonExample(media, root);
  const headers = responseHeaders(success.response, root);
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    addHeader(headers, "Content-Type", "application/json");
  }

  return {
    method,
    path,
    headers,
    statusCode: success.status,
    payload: example.found ? payloadFromValue(example.value, where) : emptyPayload(),
  };
}

/**
 * Normalize an OpenAPI 3.x document (YAML or JSON) into REST endpoints.
 * Each path method with a 2xx or `default` response becomes one endpoint.
 * `{param}` segments become Fastify `:param` segments.
 */
export function parseOpenAPI(fileString: string): ImportedEndpoint[] {
  const document = parseDocument(fileString);
  assertOpenApi3(document);
  const paths = document["paths"];
  if (!isRecord(paths)) {
    throw new Error("OpenAPI document is missing a paths object");
  }

  const endpoints: ImportedEndpoint[] = [];
  for (const [rawPath, rawItem] of Object.entries(paths)) {
    if (!isRecord(rawItem)) {
      continue;
    }
    const pathItem = typeof rawItem["$ref"] === "string" ? resolveLocal(rawItem, document, []) : rawItem;
    if (pathItem === null) {
      continue;
    }
    const path = openApiPath(rawPath);
    if (path === null) {
      continue;
    }
    for (const methodName of METHOD_ORDER) {
      const operation = pathItem[methodName];
      if (!isRecord(operation)) {
        continue;
      }
      const endpoint = endpointFromOperation(methodName.toUpperCase(), path, operation, document);
      if (endpoint !== null) {
        endpoints.push(endpoint);
      }
    }
  }
  return endpoints;
}
