/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

/** Key-value store the engine reads. `list` is optional and returns keys that start with a prefix. */
export interface MockStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  expire(key: string, seconds: number): Promise<void>;
  del(key: string): Promise<void>;
  list?(prefix: string): Promise<string[]>;
}

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

/** Process-local store. Keys disappear when the process exits. */
export function createMemoryStore(): MockStore {
  const records = new Map<string, MemoryEntry>();

  function live(key: string): MemoryEntry | undefined {
    const entry = records.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      records.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value) {
      records.set(key, { value, expiresAt: null });
    },
    async expire(key, seconds) {
      const entry = live(key);
      if (entry === undefined) {
        return;
      }
      entry.expiresAt = Date.now() + seconds * 1000;
    },
    async del(key) {
      records.delete(key);
    },
    async list(prefix) {
      const keys: string[] = [];
      for (const key of records.keys()) {
        if (live(key) !== undefined && key.startsWith(prefix)) {
          keys.push(key);
        }
      }
      return keys;
    },
  };
}

/**
 * Wrap a client that already speaks get/set/expire/del, including ioredis.
 * `list` is added when the client has `keys`.
 */
export function toStore(client: unknown): MockStore {
  if (!isClient(client)) {
    throw new TypeError("Store client must implement get");
  }
  const store: MockStore = {
    get: (key) => client.get(key),
    set: async (key, value) => {
      await client.set?.(key, value);
    },
    expire: async (key, seconds) => {
      await client.expire?.(key, seconds);
    },
    del: async (key) => {
      await client.del?.(key);
    },
  };
  if (client.keys !== undefined) {
    const keys = client.keys;
    store.list = (prefix) => keys(`${prefix}*`);
  }
  return store;
}

interface StoreClient {
  get(key: string): Promise<string | null>;
  set?(key: string, value: string): Promise<unknown>;
  expire?(key: string, seconds: number): Promise<unknown>;
  del?(key: string): Promise<unknown>;
  keys?(pattern: string): Promise<string[]>;
}

function isClient(value: unknown): value is StoreClient {
  return typeof value === "object" && value !== null && typeof (value as { get?: unknown }).get === "function";
}
