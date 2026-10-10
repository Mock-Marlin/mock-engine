/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { MockStore } from "../store.js";
import type { ServedMock } from "./catalog-types.js";
import type { TrafficEvent } from "./screen-types.js";

/** Where the routes loaded at startup came from. */
export type StartupSource = "examples" | "import" | "spec";

/** Options for the standalone server. The CLI applies flags and environment variables first. */
export interface ServeOptions {
  host?: string;
  port?: number;
  grpcPort?: number;
  workspace?: string;
  basePath?: string;
  keyPrefix?: string;
  specPath?: string;
  examples?: boolean;
  importPaths?: readonly string[];
  redisUrl?: string;
  store?: MockStore;
  onTraffic?: (event: TrafficEvent) => void;
}

/** A local server and the routes it loaded for the startup workspace. */
export interface RunningServer {
  host: string;
  port: number;
  grpcPort: number;
  workspace: string;
  basePath: string;
  storeKind: "memory" | "redis";
  source: StartupSource;
  imported: number | null;
  grpcServices: number;
  mocks: ServedMock[];
  reload(): Promise<void>;
  close(): Promise<void>;
}
