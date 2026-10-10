/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

/** Protocol shown for one stored route. `stream` is a stream whose kind was not recorded. */
export type ServedKind = "rest" | "sse" | "websocket" | "chunked" | "stream" | "graphql" | "mcp" | "grpc";

/** One route currently stored for a workspace, as the server screen lists it. */
export interface ServedMock {
  kind: ServedKind;
  method: string;
  target: string;
}
