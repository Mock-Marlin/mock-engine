/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { parseHAR } from "./har.js";
import { parseOpenAPI } from "./openapi.js";
import { parsePostman } from "./postman.js";
import type { ImportedEndpoint } from "./types.js";

export class ImportParseError extends Error {
  readonly code = "IMPORT_PARSE" as const;

  constructor(message: string) {
    super(message);
    this.name = "ImportParseError";
  }
}

export type ImportFormat = "postman" | "openapi" | "har";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extensionOf(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return base.slice(dot).toLowerCase();
}

function sniffJson(value: unknown): ImportFormat | null {
  if (!isRecord(value)) {
    return null;
  }
  const log = value["log"];
  if (isRecord(log) && Array.isArray(log["entries"])) {
    return "har";
  }
  if (typeof value["openapi"] === "string" || value["swagger"] !== undefined) {
    return "openapi";
  }
  if (isRecord(value["paths"]) && !Array.isArray(value["item"])) {
    return "openapi";
  }
  if (Array.isArray(value["item"])) {
    return "postman";
  }
  return null;
}

function formatFor(filename: string, buffer: Buffer): ImportFormat | null {
  const extension = extensionOf(filename);
  if (extension === ".har") {
    return "har";
  }
  if (extension === ".yaml" || extension === ".yml") {
    return "openapi";
  }

  const text = buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
  if (text.length === 0) {
    return null;
  }
  if (extension !== "" && extension !== ".json") {
    return null;
  }

  try {
    return sniffJson(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function parseFormat(format: ImportFormat, buffer: Buffer): ImportedEndpoint[] {
  try {
    if (format === "har") {
      return parseHAR(buffer);
    }
    if (format === "postman") {
      return parsePostman(buffer);
    }
    return parseOpenAPI(buffer.toString("utf8"));
  } catch (error: unknown) {
    if (error instanceof Error) {
      const known =
        error.message.startsWith("Postman ") ||
        error.message.startsWith("OpenAPI ") ||
        error.message.startsWith("HAR ");
      if (known) {
        throw new ImportParseError(error.message);
      }
    }
    throw error;
  }
}

/**
 * Parse a Postman, OpenAPI, or HAR file.
 * `format` forces the parser. When it is omitted, the file name and JSON shape decide.
 */
export function parseImportFile(
  filename: string,
  buffer: Buffer,
  format?: ImportFormat,
): ImportedEndpoint[] {
  if (buffer.length === 0) {
    throw new ImportParseError("Import file is empty");
  }
  const resolved = format ?? formatFor(filename, buffer);
  if (resolved === null) {
    throw new ImportParseError("Unrecognized import file");
  }
  return parseFormat(resolved, buffer);
}
