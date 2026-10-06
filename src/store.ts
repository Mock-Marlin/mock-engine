/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { Redis } from "ioredis";

import { readRedisValue } from "./http.js";

/**
 * Read-only mock documents. Redis refreshes expiry when a TTL is set.
 * The memory store ignores TTL and returns the snapshot copied at startup.
 */
export interface MockDocumentStore {
  get(key: string, ttlSeconds: number | undefined): Promise<string | null>;
}

/** The store fields on the plugin options. Other fields are ignored. */
export interface DocumentStoreOptions {
  mode?: "redis" | "memory" | undefined;
  redis?: Redis | undefined;
  data?: Readonly<Record<string, string>> | undefined;
}

/**
 * Open the store selected by `mode`. Memory copies `data` immediately.
 * Redis keeps the caller's client and does not connect on its own.
 */
export function openDocumentStore(options: DocumentStoreOptions): MockDocumentStore {
  if (options.mode === "memory") {
    return memoryStore(options.data);
  }
  if (options.mode !== undefined && options.mode !== "redis") {
    throw new Error('mock-engine mode must be "redis" or "memory"');
  }
  if (options.redis === undefined) {
    throw new Error("mock-engine redis mode requires redis");
  }
  return redisStore(options.redis);
}

function redisStore(redis: Redis): MockDocumentStore {
  return {
    get(key, ttlSeconds) {
      return readRedisValue(redis, key, ttlSeconds);
    },
  };
}

function memoryStore(data: Readonly<Record<string, string>> | undefined): MockDocumentStore {
  const record = plainRecord(data);
  if (record === null) {
    throw new Error("mock-engine memory mode requires data");
  }
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") {
      throw new Error(`mock-engine memory data values must be strings (${key})`);
    }
    entries.set(key, value);
  }
  return {
    async get(key) {
      return entries.get(key) ?? null;
    },
  };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  return value as Record<string, unknown>;
}
