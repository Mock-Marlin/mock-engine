/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { ImportedPayload, TextPayloadType } from "./types.ts";

/** Inline storage is strictly under this size. */
export const INLINE_MAX_BYTES = 1_048_576;

const MIME_BY_TYPE: Record<TextPayloadType, string> = {
  json: "application/json",
  text: "text/plain",
  html: "text/html",
  xml: "application/xml",
};

export function payloadFromUtf8(body: string, type: TextPayloadType): ImportedPayload {
  return {
    type,
    storage: "inline",
    mimeType: MIME_BY_TYPE[type],
    sizeBytes: Buffer.byteLength(body, "utf8"),
    body,
  };
}
