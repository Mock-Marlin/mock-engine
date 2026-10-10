/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import "@fastify/websocket";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

import { applyPermissiveCors, applyPublicGatewayGuard, normalizeBasePath } from "./http.js";
import { createDispatcher } from "./router.js";
import type { EngineSocket, MockEngineOptions } from "./types.js";

export { resolveEngineConfig } from "./config.js";
export type { MockEngineSharedOptions, ResolvedEngineConfig } from "./config.js";
export {
  DEFAULT_GRPC_PORT,
  DEFAULT_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_KEY_PREFIX,
  DEFAULT_WORKSPACE,
} from "./constants.js";
export {
  createKeyLayout,
  graphqlKey,
  grpcHotKey,
  grpcSchemaKey,
  mcpKey,
  mockKey,
  routeIndexKey,
  routeKey,
  streamKey,
} from "./keys.js";
export type { KeyLayout } from "./keys.js";
export { seedExamples } from "./examples.js";
export { parseHAR } from "./import/har.js";
export { parseOpenAPI } from "./import/openapi.js";
export { ImportParseError, parseImportFile } from "./import/parse-file.js";
export type { ImportFormat } from "./import/parse-file.js";
export { parsePostman } from "./import/postman.js";
export type { HttpMethod, ImportedEndpoint, ImportedPayload } from "./import/types.js";
export { clearWorkspace, prepareImportedEndpoints, writeImportedRestMocks } from "./import/write.js";
export { mockEngineWebsocketOptions } from "./router.js";
export { createMemoryStore, toStore } from "./store.js";
export type { MockStore } from "./store.js";
export { serve } from "./app/serve.js";
export type { RunningServer, ServeOptions, StartupSource } from "./app/serve.js";
export { SpecError } from "./spec.js";
export type { MockSpec } from "./spec.js";
export type { ServedMock } from "./app/catalog.js";
export type { TrafficEvent } from "./app/screen.js";
export { openRedisStore } from "./redis-store.js";
export type { RedisStore } from "./redis-store.js";
export type {
  EngineSocket,
  InspectorLog,
  KeyTtlSeconds,
  MockEngineOptions,
  ProtocolSwitches,
  RequestContext,
  ResolvedMockResponse,
  RuleDatasetResolver,
} from "./types.js";

const mockEnginePlugin: FastifyPluginAsync<MockEngineOptions> = async (app, options): Promise<void> => {
  const basePath = normalizeBasePath(options.basePath);
  const dispatch = createDispatcher(options);

  await app.register(
    async (scope) => {
      scope.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => {
        done(null, body);
      });
      scope.addContentTypeParser("application/graphql", { parseAs: "string" }, (_request, body, done) => {
        done(null, body);
      });
      scope.addContentTypeParser(/^application\/grpc/, { parseAs: "buffer" }, (_request, body, done) => {
        done(null, body);
      });

      scope.addHook("onRequest", async (_request, reply) => {
        applyPermissiveCors(reply);
      });
      scope.addHook("onSend", async (_request, reply, payload) => {
        applyPublicGatewayGuard(reply);
        return payload;
      });

      for (const url of ["/:workspaceId", "/:workspaceId/*"] as const) {
        scope.route({
          method: "GET",
          url,
          handler: (request, reply) => dispatch.http(request, reply),
          wsHandler: (socket, request) => {
            void dispatch.socket(socket as EngineSocket, request);
          },
        });
        scope.route({
          method: ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
          url,
          handler: (request, reply) => dispatch.http(request, reply),
        });
      }
    },
    { prefix: basePath },
  );
};

/** Fastify plugin that serves stored mocks under `basePath`. */
export const mockEngine = fp(mockEnginePlugin, {
  name: "mock-engine",
  fastify: "5.x",
});
