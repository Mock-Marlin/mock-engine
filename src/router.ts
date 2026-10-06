/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { IncomingMessage } from "node:http";

import type { FastifyReply, FastifyRequest } from "fastify";

import { GraphqlHandler } from "./handlers/GraphqlHandler.js";
import { GrpcHandler } from "./handlers/GrpcHandler.js";
import { McpHandler } from "./handlers/McpHandler.js";
import { RestHandler } from "./handlers/RestHandler.js";
import { StreamHandler } from "./handlers/StreamHandler.js";
import { resolveEngineConfig, type MockEngineSharedOptions } from "./config.js";
import {
  headerText,
  isHttpMethod,
  isRecord,
  isValidRoutePath,
  queryRecord,
  redisGet,
  remainingPath,
  sendNotFound,
  stringHeaders,
} from "./http.js";
import { openDocumentStore } from "./store.js";
import { normalizeStreamDocument } from "./stream/plan.js";
import { GRAPHQL_TRANSPORT_WS_PROTOCOL } from "./graphql/ws.js";
import type { EngineSocket, MockEngineOptions, RequestContext } from "./types.js";

interface WebsocketHandshake {
  verifyClient: (
    info: { req: IncomingMessage },
    callback: (result: boolean, code?: number, message?: string) => void,
  ) => void;
  handleProtocols: (protocols: Set<string>, request: IncomingMessage) => string | false;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function requestContext(
  request: FastifyRequest,
  workspaceId: string,
  path: string,
): RequestContext {
  return {
    workspaceId,
    method: request.method,
    path,
    headers: stringHeaders(request.headers as Record<string, unknown>),
    query: queryRecord(request.query),
    body: request.body,
  };
}

function hasGraphqlOperation(request: FastifyRequest): boolean {
  const contentType = headerText(request.headers["content-type"]);
  if (contentType.startsWith("application/graphql") && typeof request.body === "string" && request.body.trim().length > 0) {
    return true;
  }
  if (isRecord(request.body) && typeof request.body["query"] === "string" && request.body["query"].trim().length > 0) {
    return true;
  }
  if (isRecord(request.query) && typeof request.query["query"] === "string" && request.query["query"].trim().length > 0) {
    return true;
  }
  return false;
}

function offeredProtocols(header: IncomingMessage["headers"]["sec-websocket-protocol"]): string[] {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function targetFromUrl(
  url: string | undefined,
  basePath: string,
): { workspaceKey: string; path: string } | null {
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }
  const pathOnly = (url.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
  const escaped = basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}/([^/]+)(/.*)?$`).exec(pathOnly);
  if (match === null) {
    return null;
  }
  const workspaceKey = match[1];
  if (workspaceKey === undefined || workspaceKey.length === 0) {
    return null;
  }
  const rest = match[2];
  const path = rest === undefined || rest.length === 0 ? "/" : rest.replace(/\/+$/, "") || "/";
  if (!isValidRoutePath(path.startsWith("/") ? path : `/${path}`)) {
    return null;
  }
  return { workspaceKey, path: path.startsWith("/") ? path : `/${path}` };
}

export function mockEngineWebsocketOptions(options: MockEngineSharedOptions): WebsocketHandshake {
  const settings = resolveEngineConfig(options);
  const store = openDocumentStore(options);
  const selectedSubprotocol = new WeakMap<IncomingMessage, string | false>();

  async function decide(req: IncomingMessage): Promise<string | false | "reject"> {
    const target = targetFromUrl(req.url, settings.basePath);
    if (target === null) {
      return false;
    }
    const workspaceId = await options.resolveWorkspaceId(target.workspaceKey);
    if (workspaceId === null) {
      return false;
    }
    const offered = offeredProtocols(req.headers["sec-websocket-protocol"]);
    if (settings.protocols.graphql) {
      const graphqlRaw = await store.get(
        settings.keys.graphql(workspaceId, target.path),
        settings.ttl.graphql,
      );
      if (graphqlRaw !== null && offered.includes(GRAPHQL_TRANSPORT_WS_PROTOCOL)) {
        return GRAPHQL_TRANSPORT_WS_PROTOCOL;
      }
    }
    if (!settings.protocols.stream) {
      return false;
    }
    const streamRaw = await store.get(
      settings.keys.stream(workspaceId, target.path),
      settings.ttl.stream,
    );
    if (streamRaw === null) {
      return false;
    }
    const document = normalizeStreamDocument(parseJson(streamRaw));
    if (document === null || document.protocol !== "websocket" || document.subprotocols.length === 0) {
      return false;
    }
    for (const name of offered) {
      if (document.subprotocols.includes(name)) {
        return name;
      }
    }
    return "reject";
  }

  return {
    verifyClient(info, callback) {
      void decide(info.req)
        .then((selected) => {
          if (selected === "reject") {
            callback(false, 400, "WebSocket subprotocol not accepted");
            return;
          }
          selectedSubprotocol.set(info.req, selected);
          callback(true);
        })
        .catch(() => {
          selectedSubprotocol.set(info.req, false);
          callback(true);
        });
    },
    handleProtocols(protocols, request) {
      const selected = selectedSubprotocol.get(request) ?? false;
      if (typeof selected === "string" && !protocols.has(selected)) {
        return false;
      }
      return selected;
    },
  };
}

export function createDispatcher(options: MockEngineOptions): {
  http: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  socket: (socket: EngineSocket, request: FastifyRequest) => Promise<void>;
} {
  const settings = resolveEngineConfig(options);
  const store = openDocumentStore(options);
  const rest = new RestHandler(options);
  const streams = new StreamHandler(options);
  const graphql = new GraphqlHandler(options);
  const mcp = new McpHandler(options, store);
  const grpc = new GrpcHandler(options, store);

  async function http(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (request.method === "OPTIONS") {
      await reply.status(204).send();
      return;
    }

    const params: unknown = request.params;
    const workspaceKey =
      typeof params === "object" && params !== null && typeof (params as { workspaceId?: unknown }).workspaceId === "string"
        ? (params as { workspaceId: string }).workspaceId
        : "";
    if (workspaceKey.length === 0) {
      await sendNotFound(reply, "Mock endpoint not found or expired");
      return;
    }

    const workspaceId = await options.resolveWorkspaceId(workspaceKey);
    if (workspaceId === null) {
      await sendNotFound(reply, "Mock endpoint not found or expired");
      return;
    }

    const path = remainingPath(request, settings.basePath, workspaceKey);
    if (!isValidRoutePath(path)) {
      await sendNotFound(reply, "Mock endpoint not found or expired");
      return;
    }

    const context = requestContext(request, workspaceId, path);
    const subpath = path === "/" ? "" : path.slice(1);
    if (subpath === "mcp/sse" || subpath === "mcp/messages") {
      if (!settings.protocols.mcp) {
        await sendNotFound(reply, "Mock endpoint not found or expired");
        return;
      }
      await mcp.handle(request, reply, workspaceId, subpath, context);
      return;
    }

    const contentType = headerText(request.headers["content-type"]);
    if (contentType.startsWith("application/grpc")) {
      if (!settings.protocols.grpc) {
        await sendNotFound(reply, "Mock endpoint not found or expired");
        return;
      }
      await grpc.handle(request, reply, workspaceId, path);
      return;
    }

    const accept = headerText(request.headers.accept);
    if (settings.protocols.stream) {
      const streamRaw = await redisGet(
        store,
        settings.keys.stream(workspaceId, path),
        reply,
        settings.ttl.stream,
      );
      if (streamRaw === "down") {
        return;
      }
      if (accept.includes("text/event-stream") || streamRaw !== null) {
        await streams.handleHttp(request, reply, streamRaw === null ? null : parseJson(streamRaw), context);
        return;
      }
    }

    if (settings.protocols.graphql) {
      const graphqlRaw = await redisGet(
        store,
        settings.keys.graphql(workspaceId, path),
        reply,
        settings.ttl.graphql,
      );
      if (graphqlRaw === "down") {
        return;
      }
      if (hasGraphqlOperation(request) || graphqlRaw !== null) {
        await graphql.handleHttp(request, reply, graphqlRaw === null ? null : parseJson(graphqlRaw), context);
        return;
      }
    }

    if (!settings.protocols.rest || !isHttpMethod(request.method)) {
      await sendNotFound(reply, "Mock endpoint not found or expired");
      return;
    }

    const mockId = await redisGet(
      store,
      settings.keys.route(workspaceId, request.method, path),
      reply,
      settings.ttl.route,
    );
    if (mockId === "down") {
      return;
    }
    if (mockId === null || mockId.length === 0) {
      await sendNotFound(reply, "Mock endpoint not found or expired");
      return;
    }
    const mockRaw = await redisGet(store, settings.keys.mock(mockId), reply, settings.ttl.mock);
    if (mockRaw === "down") {
      return;
    }
    const config = mockRaw === null ? null : parseJson(mockRaw);
    if (!isRecord(config)) {
      await sendNotFound(reply, "Mock endpoint not found or expired");
      return;
    }
    await rest.handle(request, reply, { path, mockId, config, context });
  }

  async function socket(socket: EngineSocket, request: FastifyRequest): Promise<void> {
    try {
      const params: unknown = request.params;
      const workspaceKey =
        typeof params === "object" && params !== null && typeof (params as { workspaceId?: unknown }).workspaceId === "string"
          ? (params as { workspaceId: string }).workspaceId
          : "";
      const workspaceId = workspaceKey.length === 0 ? null : await options.resolveWorkspaceId(workspaceKey);
      if (workspaceId === null) {
        socket.close(1008, "Mock endpoint not found or expired");
        return;
      }
      const path = remainingPath(request, settings.basePath, workspaceKey);
      const context = requestContext(request, workspaceId, path);
      const subpath = path === "/" ? "" : path.slice(1);
      if (settings.protocols.mcp && (subpath === "mcp/sse" || subpath === "mcp/messages")) {
        socket.close(1008, "MCP uses SSE, not WebSocket");
        return;
      }

      const offered = headerText(request.headers["sec-websocket-protocol"]);
      let graphqlRaw: string | null = null;
      if (settings.protocols.graphql) {
        try {
          graphqlRaw = await store.get(
            settings.keys.graphql(workspaceId, path),
            settings.ttl.graphql,
          );
        } catch {
          socket.close(1011, "Mock store is unreachable");
          return;
        }
        if (graphqlRaw !== null && offered.includes(GRAPHQL_TRANSPORT_WS_PROTOCOL)) {
          await graphql.handleSocket(socket, parseJson(graphqlRaw), context);
          return;
        }
      }

      if (settings.protocols.stream) {
        let streamRaw: string | null = null;
        try {
          streamRaw = await store.get(
            settings.keys.stream(workspaceId, path),
            settings.ttl.stream,
          );
        } catch {
          socket.close(1011, "Mock store is unreachable");
          return;
        }
        if (streamRaw !== null) {
          const document = normalizeStreamDocument(parseJson(streamRaw));
          if (document?.protocol === "websocket") {
            await streams.handleSocket(socket, parseJson(streamRaw), context);
            return;
          }
        }
      }
      if (graphqlRaw !== null) {
        await graphql.handleSocket(socket, parseJson(graphqlRaw), context);
        return;
      }
      socket.close(1008, "WebSocket endpoint not found or expired");
    } catch {
      try {
        socket.close(1011, "Socket failed");
      } catch {
        socket.terminate();
      }
    }
  }

  return { http, socket };
}
