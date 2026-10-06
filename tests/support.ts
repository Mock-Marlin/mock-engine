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

import { mockEngine, mockEngineWebsocketOptions, type MockEngineOptions } from "../src/index.js";

type RedisEngineOptions = Extract<MockEngineOptions, { mode?: "redis" }>;

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
  extra: Partial<RedisEngineOptions> & { redis?: Redis } = {},
): Promise<{ app: FastifyInstance; redis: Redis }> {
  const redis = extra.redis ?? createRedis();
  const workspaceLookup = extra.resolveWorkspaceId ?? resolveWorkspaceId;
  const app = Fastify();
  await app.register(websocket, {
    options: mockEngineWebsocketOptions({
      redis,
      resolveWorkspaceId: workspaceLookup,
      ...(extra.basePath !== undefined ? { basePath: extra.basePath } : {}),
      ...(extra.keyPrefix !== undefined ? { keyPrefix: extra.keyPrefix } : {}),
      ...(extra.keys !== undefined ? { keys: extra.keys } : {}),
      ...(extra.ttl !== undefined ? { ttl: extra.ttl } : {}),
      ...(extra.protocols !== undefined ? { protocols: extra.protocols } : {}),
    }),
  });
  const pluginOptions: RedisEngineOptions = {
    redis,
    basePath: "/s",
    resolveWorkspaceId: workspaceLookup,
    ...extra,
  };
  await app.register(mockEngine, pluginOptions);
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
