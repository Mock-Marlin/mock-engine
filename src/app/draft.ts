/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { dump, load } from "js-yaml";

import { isHttpMethod } from "../import/types.js";
import type { McpToolDraft, MockDraft, MockRef, RestDraft } from "./draft-types.js";

export { BLANK_DRAFT } from "../constants.js";
export type {
  GraphqlDraft,
  GrpcDraft,
  McpDraft,
  McpToolDraft,
  MockDraft,
  MockKind,
  MockRef,
  RestDraft,
  StreamDraft,
} from "./draft-types.js";

/** Serialize a draft to the YAML buffer the client editor opens. */
export function draftToYaml(draft: MockDraft): string {
  const header = "# This buffer is deleted when the editor closes.\n# The mock is saved in the running engine, in memory or Redis.\n";
  return header + dump(draft, { lineWidth: 88, noRefs: true });
}

/** Parse the editor buffer into a draft. Throws when the YAML is not a mock. */
export function yamlToDraft(text: string): MockDraft {
  let parsed: unknown;
  try {
    parsed = load(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "invalid YAML";
    throw new Error(`Could not read the mock file: ${message}`);
  }
  return draftFromRecord(parsed);
}

/** Build a draft from a parsed YAML object. */
export function draftFromRecord(value: unknown): MockDraft {
  if (!isRecord(value)) {
    throw new Error("Mock file must be a YAML object");
  }
  const kind = value["kind"];
  if (kind === "rest") {
    return restDraft(value);
  }
  if (kind === "sse" || kind === "websocket" || kind === "chunked") {
    return { kind, path: routePath(value["path"]), body: stringField(value["body"], "body") };
  }
  if (kind === "graphql") {
    return { kind, path: routePath(value["path"]), sdl: stringField(value["sdl"], "sdl") };
  }
  if (kind === "mcp") {
    return {
      kind: "mcp",
      tools: mcpTools(value["tools"]),
      resources: arrayField(value["resources"]),
      prompts: arrayField(value["prompts"]),
    };
  }
  if (kind === "grpc") {
    const errorCode = value["errorCode"];
    return {
      kind: "grpc",
      service: stringField(value["service"], "service"),
      rpc: stringField(value["rpc"], "rpc"),
      latencyMs: numberField(value["latencyMs"], 0),
      errorCode: errorCode === undefined || errorCode === null ? null : stringField(errorCode, "errorCode"),
      body: value["body"] === undefined ? {} : value["body"],
    };
  }
  throw new Error("kind must be rest, sse, websocket, chunked, graphql, mcp, or grpc");
}

/** Identity used to match this draft against another mock. */
export function refOf(draft: MockDraft): MockRef {
  if (draft.kind === "rest") {
    return { kind: "rest", method: draft.method, path: draft.path, service: "", rpc: "" };
  }
  if (draft.kind === "grpc") {
    return { kind: "grpc", method: "RPC", path: `${draft.service}/${draft.rpc}`, service: draft.service, rpc: draft.rpc };
  }
  if (draft.kind === "mcp") {
    return { kind: "mcp", method: "POST", path: "/mcp", service: "", rpc: "" };
  }
  return { kind: draft.kind, method: draft.kind === "graphql" ? "POST" : "GET", path: draft.path, service: "", rpc: "" };
}

/** True when both refs name the same mock. */
export function sameRef(left: MockRef, right: MockRef): boolean {
  return left.kind === right.kind && left.method === right.method && left.path === right.path && left.service === right.service && left.rpc === right.rpc;
}

/** Short label for a mock, such as `GET /health` or `grpc demo.Greeter/SayHello`. */
export function describeRef(ref: MockRef): string {
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

function restDraft(value: Record<string, unknown>): RestDraft {
  const method = value["method"];
  if (typeof method !== "string" || !isHttpMethod(method)) {
    throw new Error("method must be GET, HEAD, POST, PUT, PATCH, DELETE, or OPTIONS");
  }
  const status = numberField(value["status"], 200);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error("status must be an HTTP status code");
  }
  return {
    kind: "rest",
    method,
    path: routePath(value["path"]),
    status,
    delayMs: numberField(value["delayMs"], 0),
    headers: headersField(value["headers"]),
    body: value["body"] === undefined ? {} : value["body"],
  };
}

function mcpTools(value: unknown): McpToolDraft[] {
  if (!Array.isArray(value)) {
    throw new Error("tools must be a list");
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error("each tool must be an object");
    }
    return {
      name: stringField(item["name"], "tool name"),
      description: typeof item["description"] === "string" ? item["description"] : "",
      body: item["body"] === undefined ? {} : item["body"],
    };
  });
}

function arrayField(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("expected a list");
  }
  return value;
}

function routePath(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("path must be a route such as /hello");
  }
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function numberField(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("expected a number");
  }
  return value;
}

function headersField(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("headers must be an object");
  }
  const headers: Record<string, string> = {};
  for (const [key, header] of Object.entries(value)) {
    if (typeof header === "string") {
      headers[key] = header;
    } else if (typeof header === "number" || typeof header === "boolean") {
      headers[key] = String(header);
    } else {
      throw new Error(`header ${key} must be a string`);
    }
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
