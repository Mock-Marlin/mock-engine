/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { Socket } from "node:net";

import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import RedisMock from "ioredis-mock";

import { mockEngine, mockEngineWebsocketOptions, toStore, type MockEngineOptions, type MockStore } from "../src/index.js";

export const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

export const wsUpgrade = {
  socket: { authorized: false, encrypted: false } as unknown as Socket,
};

export function createRedis(): Redis {
  return new RedisMock() as unknown as Redis;
}

export function resolveWorkspaceId(slugOrId: string): Promise<string | null> {
  return Promise.resolve(slugOrId === "acme" ? WORKSPACE_ID : null);
}

export async function createApp(
  extra: Partial<Omit<MockEngineOptions, "store">> & { store?: MockStore; redis?: Redis } = {},
): Promise<{ app: FastifyInstance; redis: Redis }> {
  const { redis: redisOverride, store: explicitStore, ...rest } = extra;
  const redis = redisOverride ?? createRedis();
  const store = explicitStore ?? toStore(redis);
  const workspaceLookup = rest.resolveWorkspaceId ?? resolveWorkspaceId;
  const shared = {
    store,
    resolveWorkspaceId: workspaceLookup,
    ...(rest.basePath !== undefined ? { basePath: rest.basePath } : {}),
    ...(rest.keyPrefix !== undefined ? { keyPrefix: rest.keyPrefix } : {}),
    ...(rest.keys !== undefined ? { keys: rest.keys } : {}),
    ...(rest.ttl !== undefined ? { ttl: rest.ttl } : {}),
    ...(rest.protocols !== undefined ? { protocols: rest.protocols } : {}),
    ...(rest.matchParams === true ? { matchParams: true } : {}),
  };
  const app = Fastify();
  await app.register(websocket, {
    options: mockEngineWebsocketOptions(shared),
  });
  await app.register(mockEngine, {
    ...shared,
    basePath: rest.basePath ?? "/s",
    ...(rest.resolvePayloadOverride !== undefined ? { resolvePayloadOverride: rest.resolvePayloadOverride } : {}),
    ...(rest.onInspectorLog !== undefined ? { onInspectorLog: rest.onInspectorLog } : {}),
    ...(rest.readStoredObject !== undefined ? { readStoredObject: rest.readStoredObject } : {}),
  });
  await app.ready();
  return { app, redis };
}

export async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port");
  }
  return address.port;
}
