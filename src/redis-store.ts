/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { toStore, type MockStore } from "./store.js";

export interface RedisStore {
  store: MockStore;
  close(): Promise<void>;
}

/**
 * Open a Redis client. ioredis is an optional peer and is loaded only here.
 */
export async function openRedisStore(url: string): Promise<RedisStore> {
  let connect: new (url: string, options?: Record<string, unknown>) => RedisLike;
  try {
    const imported = (await import("ioredis")) as unknown as {
      default: new (url: string, options?: Record<string, unknown>) => RedisLike;
    };
    connect = imported.default;
  } catch {
    throw new Error(
      "REDIS_URL is set but ioredis is not installed. Install ioredis, or unset REDIS_URL to use the in-memory store.",
    );
  }
  const client = new connect(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    retryStrategy: () => null,
  });
  try {
    await client.ping();
  } catch (error: unknown) {
    await client.quit().catch(() => undefined);
    const message = error instanceof Error ? error.message : "connection failed";
    throw new Error(`Redis at ${url} is unreachable: ${message}`);
  }
  return {
    store: toStore(client),
    async close() {
      await client.quit();
    },
  };
}

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}
