/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";

import { resolveEngineConfig } from "../config.js";
import { isRecord, storeGet } from "../http.js";
import type { MockStore } from "../store.js";
import { dispatchJsonRpc, type McpInvocation } from "../mcp/jsonrpc.js";
import { SessionManager } from "../mcp/SessionManager.js";
import type { MockEngineOptions, RequestContext } from "../types.js";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

const CORS_HEADER_NAMES = [
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-max-age",
] as const;

interface McpCatalog {
  tools: any[];
  resources: any[];
  prompts: any[];
}

function emptyCatalog(): McpCatalog {
  return { tools: [], resources: [], prompts: [] };
}

function readCatalog(raw: string | null): McpCatalog {
  if (raw === null) {
    return emptyCatalog();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return emptyCatalog();
    }
    return {
      tools: Array.isArray(parsed["tools"]) ? parsed["tools"] : [],
      resources: Array.isArray(parsed["resources"]) ? parsed["resources"] : [],
      prompts: Array.isArray(parsed["prompts"]) ? parsed["prompts"] : [],
    };
  } catch {
    return emptyCatalog();
  }
}

function toolSchema(tool: unknown): Record<string, unknown> | null {
  if (!isRecord(tool) || typeof tool["name"] !== "string" || !isRecord(tool["inputSchema"])) {
    return null;
  }
  if (typeof tool["description"] === "string") {
    return {
      name: tool["name"],
      description: tool["description"],
      inputSchema: tool["inputSchema"],
    };
  }
  return { name: tool["name"], inputSchema: tool["inputSchema"] };
}

function messagesPath(request: FastifyRequest): string {
  const pathOnly = (request.url.split("?")[0] ?? "").replace(/\/+$/, "");
  if (pathOnly.endsWith("/sse")) {
    return `${pathOnly.slice(0, -"/sse".length)}/messages`;
  }
  return `${pathOnly}/messages`;
}

function readSessionId(query: unknown): string | null {
  if (!isRecord(query)) {
    return null;
  }
  const sessionId = query["sessionId"];
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return null;
  }
  return sessionId;
}

function sseWriteHead(reply: FastifyReply): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { ...SSE_HEADERS };
  for (const name of CORS_HEADER_NAMES) {
    const value = reply.getHeader(name);
    if (typeof value === "string") {
      headers[name] = value;
    }
  }
  return headers;
}

function holdStream(request: FastifyRequest, raw: FastifyReply["raw"]): void {
  const incoming: IncomingMessage = request.raw;
  incoming.setTimeout(0);
  raw.setTimeout(0);
}

export class McpHandler {
  private readonly options: MockEngineOptions;
  private readonly sessions = new SessionManager();

  constructor(options: MockEngineOptions) {
    this.options = options;
  }

  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
    workspaceId: string,
    subpath: string,
    context: RequestContext,
  ): Promise<void> {
    if (subpath === "mcp/sse") {
      if (request.method !== "GET") {
        await reply.status(405).send({
          error: "Method Not Allowed",
          message: "MCP SSE accepts GET",
        });
        return;
      }
      holdStream(request, reply.raw);
      reply.hijack();
      reply.raw.writeHead(200, sseWriteHead(reply));
      this.sessions.open(reply.raw, messagesPath(request));
      return;
    }

    if (request.method !== "POST") {
      await reply.status(405).send({
        error: "Method Not Allowed",
        message: "MCP messages accept POST",
      });
      return;
    }

    const sessionId = readSessionId(request.query);
    if (sessionId === null || !this.sessions.has(sessionId)) {
      await reply.status(404).send({
        error: "Not Found",
        message: "MCP session not found",
      });
      return;
    }

    const catalog = await this.catalog(workspaceId, reply);
    if (catalog === null) {
      return;
    }
    const invocation = this.invocation(catalog, context);
    const outcome = await dispatchJsonRpc(request.body, invocation);
    if (outcome !== null && !this.sessions.emit(sessionId, outcome)) {
      await reply.status(404).send({
        error: "Not Found",
        message: "MCP session not found",
      });
      return;
    }
    await reply.status(202).send();
  }

  private async catalog(workspaceId: string, reply: FastifyReply): Promise<McpCatalog | null> {
    const settings = resolveEngineConfig(this.options);
    const raw = await storeGet(this.store, settings.keys.mcp(workspaceId), reply, settings.ttl.mcp);
    if (raw === "down") {
      return null;
    }
    return readCatalog(raw);
  }

  private invocation(catalog: McpCatalog, context: RequestContext): McpInvocation {
    const tools = catalog.tools.map(toolSchema).filter((tool): tool is Record<string, unknown> => tool !== null);
    return {
      tools,
      resources: catalog.resources,
      prompts: catalog.prompts,
      onToolCall: async (name, args) => this.callTool(catalog, context, name, args),
    };
  }

  private async callTool(
    catalog: McpCatalog,
    context: RequestContext,
    name: string,
    args: Record<string, any>,
  ): Promise<unknown> {
    const tool = catalog.tools.find((item) => isRecord(item) && item["name"] === name);
    if (tool === undefined) {
      throw new Error("Unknown tool");
    }
    if (this.options.resolvePayloadOverride !== undefined) {
      const override = await this.options.resolvePayloadOverride({ ...context, body: args }, tool);
      if (override !== null) {
        return override.payload;
      }
    }
    if (isRecord(tool) && "payload" in tool) {
      return tool["payload"];
    }
    return null;
  }

  private get store(): MockStore {
    return this.options.store;
  }
}
