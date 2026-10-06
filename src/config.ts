/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { normalizeBasePath } from "./http.js";
import { createKeyLayout, type KeyLayout } from "./keys.js";
import type { KeyTtlSeconds, MockEngineOptions, ProtocolSwitches } from "./types.js";

/** Options that both the HTTP plugin and the WebSocket handshake read. */
export type MockEngineSharedOptions = Pick<
  MockEngineOptions,
  "mode" | "redis" | "data" | "resolveWorkspaceId" | "basePath" | "keyPrefix" | "keys" | "ttl" | "protocols"
>;

/** Settings after defaults are filled in. Handlers read this, not the raw options. */
export interface ResolvedEngineConfig {
  basePath: string;
  keys: KeyLayout;
  protocols: ProtocolSwitches;
  ttl: KeyTtlSeconds;
}

/**
 * Fill defaults. A custom {@link MockEngineOptions.keys} layout wins over `keyPrefix`.
 * Omitted protocol switches stay enabled. Omitted TTLs stay unset.
 */
export function resolveEngineConfig(
  options: Pick<MockEngineOptions, "basePath" | "keyPrefix" | "keys" | "ttl" | "protocols">,
): ResolvedEngineConfig {
  const protocols = options.protocols;
  return {
    basePath: normalizeBasePath(options.basePath),
    keys: options.keys ?? createKeyLayout(options.keyPrefix),
    protocols: {
      rest: protocols?.rest ?? true,
      stream: protocols?.stream ?? true,
      graphql: protocols?.graphql ?? true,
      mcp: protocols?.mcp ?? true,
      grpc: protocols?.grpc ?? true,
    },
    ttl: options.ttl ?? {},
  };
}
