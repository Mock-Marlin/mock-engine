/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { randomUUID } from "node:crypto";

const TOKEN = /\{\{\s*([a-zA-Z]+)(?:\.([A-Za-z0-9_-]+))?\s*\}\}/g;

export interface TemplateContext {
  headers: Record<string, string>;
  query: unknown;
  body: unknown;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldText(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function lookupField(value: unknown, name: string): string | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  return fieldText(value[name]);
}

function lookupHeader(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) {
    return direct;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

/** Fill known request tokens. Unknown tokens are left as written. `encode` runs on substituted values only. */
export function applyRestTemplate(
  input: string,
  method: string,
  path: string,
  context: TemplateContext,
  encode?: (value: string) => string,
): string {
  return input.replace(TOKEN, (full, kind: string, name: string | undefined) => {
    let filled: string | undefined;
    if (kind === "method") {
      filled = method;
    } else if (kind === "path") {
      filled = path;
    } else if (kind === "uuid") {
      filled = randomUUID();
    } else if (kind === "now") {
      filled = new Date().toISOString();
    } else if (kind === "query" && name !== undefined) {
      filled = lookupField(context.query, name);
    } else if (kind === "header" && name !== undefined) {
      filled = lookupHeader(context.headers, name);
    } else if (kind === "body" && name !== undefined) {
      filled = lookupField(context.body, name);
    }
    if (filled === undefined) {
      return full;
    }
    return encode !== undefined ? encode(filled) : filled;
  });
}
