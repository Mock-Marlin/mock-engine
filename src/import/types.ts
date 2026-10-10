/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export type TextPayloadType = "json" | "text" | "html" | "xml";

export type PayloadType = TextPayloadType | "binary";

const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);

export function isHttpMethod(value: string): value is HttpMethod {
  return HTTP_METHOD_SET.has(value);
}

/** Inline body produced by an importer. Binary bodies are Base64. */
export interface ImportedPayload {
  type: PayloadType;
  storage: "inline";
  mimeType?: string;
  sizeBytes: number;
  fileName?: string;
  body: string;
}

/** One REST endpoint normalized from Postman, OpenAPI, or HAR. */
export interface ImportedEndpoint {
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  statusCode: number;
  payload: ImportedPayload;
}
