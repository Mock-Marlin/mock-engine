/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import { executeSdl, operationFrom, subscribeSdl } from "../graphql/execute.js";
import { graphqlPlaygroundHtml } from "../graphql/playground.js";
import { handleGraphqlSocket } from "../graphql/ws.js";
import { delay, headerText, isRecord, stringHeaders } from "../http.js";
import type { EngineSocket, MockEngineOptions, RequestContext, ResolvedMockResponse } from "../types.js";

function readSdl(raw: unknown): { sdl: string } | null {
  if (!isRecord(raw) || typeof raw["sdl"] !== "string" || raw["sdl"].length === 0) {
    return null;
  }
  return { sdl: raw["sdl"] };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function envelopesFrom(payload: unknown): AsyncIterable<unknown> | readonly unknown[] {
  if (isRecord(payload) && Array.isArray(payload["envelopes"])) {
    return payload["envelopes"];
  }
  if (isRecord(payload) && isAsyncIterable(payload["envelopes"])) {
    return payload["envelopes"];
  }
  return [payload];
}

function wantsPlayground(request: FastifyRequest): boolean {
  if (request.method !== "GET") {
    return false;
  }
  const query = isRecord(request.query) ? request.query["query"] : undefined;
  if (typeof query === "string" && query.trim().length > 0) {
    return false;
  }
  return headerText(request.headers.accept).includes("text/html");
}

function operationSource(request: FastifyRequest): unknown {
  if (request.method === "GET") {
    return request.query;
  }
  const contentType = headerText(request.headers["content-type"]);
  if (contentType.startsWith("application/graphql") && typeof request.body === "string") {
    return request.body;
  }
  return request.body;
}

export class GraphqlHandler {
  private readonly options: MockEngineOptions;

  constructor(options: MockEngineOptions) {
    this.options = options;
  }

  async handleHttp(
    request: FastifyRequest,
    reply: FastifyReply,
    raw: unknown,
    context: RequestContext,
  ): Promise<void> {
    const config = readSdl(raw);
    if (config === null) {
      await reply.status(404).send({
        error: "Not Found",
        message: "GraphQL endpoint not found or expired",
      });
      return;
    }

    if (wantsPlayground(request)) {
      const endpointPath = (request.url.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
      reply.header("Cache-Control", "no-store");
      reply.header("x-mockmarlin-trusted-document", "playground");
      await reply.type("text/html; charset=utf-8").status(200).send(graphqlPlaygroundHtml(endpointPath));
      return;
    }

    const operation = operationFrom(operationSource(request));
    const override = await this.override(context, raw);
    if (override !== null) {
      if ((override.delayMs ?? 0) > 0) {
        await delay(override.delayMs ?? 0);
      }
      await reply.status(override.statusCode).type("application/json; charset=utf-8").send(override.payload);
      return;
    }

    if (operation.query.trim().length === 0) {
      await reply.status(400).type("application/json; charset=utf-8").send({
        data: null,
        errors: [{ message: "GraphQL query is required" }],
      });
      return;
    }

    const result = await executeSdl(config.sdl, operation);
    await reply.status(200).type("application/json; charset=utf-8").send(result);
  }

  async handleSocket(socket: EngineSocket, raw: unknown, context: RequestContext): Promise<void> {
    const config = readSdl(raw);
    if (config === null) {
      socket.close(4404, "GraphQL endpoint not found or expired");
      return;
    }

    handleGraphqlSocket(socket, async (payload) => {
      const socketContext: RequestContext = {
        ...context,
        headers: { ...stringHeaders(context.headers), upgrade: "websocket" },
        body: payload,
      };
      const override = await this.override(socketContext, raw);
      if (override !== null) {
        return {
          delayMs: override.delayMs ?? 0,
          envelopes: envelopesFrom(override.payload),
        };
      }
      const operation = operationFrom(payload);
      if (operation.query.includes("subscription")) {
        const envelopes = await subscribeSdl(config.sdl, operation);
        return { delayMs: 0, envelopes };
      }
      return { delayMs: 0, envelopes: [await executeSdl(config.sdl, operation)] };
    });
  }

  private async override(context: RequestContext, raw: unknown): Promise<ResolvedMockResponse | null> {
    if (this.options.resolvePayloadOverride === undefined) {
      return null;
    }
    return this.options.resolvePayloadOverride(context, raw);
  }
}
