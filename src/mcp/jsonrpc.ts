/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpInvocation {
  tools: any[];
  resources: any[];
  prompts: any[];
  onToolCall: (name: string, args: Record<string, any>) => Promise<any>;
}

const JSON_RPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2024-11-05";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: { code, message },
  };
}

function successResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readId(value: unknown): JsonRpcId | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  return undefined;
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result === undefined) {
    return "";
  }
  try {
    const text = JSON.stringify(result);
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

function formatToolResult(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  if (isRecord(result) && Array.isArray(result["content"])) {
    return result as { content: Array<{ type: "text"; text: string }> };
  }
  return {
    content: [{ type: "text", text: toolResultText(result) }],
  };
}

async function callTool(id: JsonRpcId, params: unknown, options: McpInvocation): Promise<JsonRpcResponse> {
  if (!isRecord(params) || typeof params["name"] !== "string" || params["name"].length === 0) {
    return errorResponse(id, INVALID_PARAMS, "Invalid params");
  }
  const args = params["arguments"];
  if (args !== undefined && !isRecord(args)) {
    return errorResponse(id, INVALID_PARAMS, "Invalid params");
  }

  try {
    const result = await options.onToolCall(params["name"], args ?? {});
    return successResponse(id, formatToolResult(result));
  } catch (error: unknown) {
    const message = error instanceof Error && error.message.length > 0 ? error.message : "Tool call failed";
    return errorResponse(id, INTERNAL_ERROR, message);
  }
}

async function handleRequest(
  id: JsonRpcId,
  method: string,
  params: unknown,
  options: McpInvocation,
): Promise<JsonRpcResponse> {
  switch (method) {
    case "initialize":
      return successResponse(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: {
          name: "mock-engine",
          version: "0.1.0",
        },
      });
    case "ping":
      return successResponse(id, {});
    case "tools/list":
      return successResponse(id, { tools: options.tools });
    case "resources/list":
      return successResponse(id, { resources: options.resources });
    case "prompts/list":
      return successResponse(id, { prompts: options.prompts });
    case "tools/call":
      return callTool(id, params, options);
    default:
      return errorResponse(id, METHOD_NOT_FOUND, "Method not found");
  }
}

async function dispatchOne(body: unknown, options: McpInvocation): Promise<JsonRpcResponse | null> {
  if (!isRecord(body)) {
    return errorResponse(null, INVALID_REQUEST, "Invalid Request");
  }

  const version = body["jsonrpc"];
  const method = body["method"];
  if (version !== JSON_RPC_VERSION || typeof method !== "string" || method.length === 0) {
    const id = readId(body["id"]) ?? null;
    return errorResponse(id, INVALID_REQUEST, "Invalid Request");
  }

  if (!Object.hasOwn(body, "id")) {
    return null;
  }

  const id = readId(body["id"]);
  if (id === undefined) {
    return errorResponse(null, INVALID_REQUEST, "Invalid Request");
  }

  return handleRequest(id, method, body["params"], options);
}

/** Parse one JSON-RPC payload, or a batch. Notifications produce no response. */
export async function dispatchJsonRpc(
  body: unknown,
  options: McpInvocation,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (body === undefined || body === null) {
    return errorResponse(null, PARSE_ERROR, "Parse error");
  }

  if (Array.isArray(body)) {
    if (body.length === 0) {
      return errorResponse(null, INVALID_REQUEST, "Invalid Request");
    }
    const responses: JsonRpcResponse[] = [];
    for (const item of body) {
      const response = await dispatchOne(item, options);
      if (response !== null) {
        responses.push(response);
      }
    }
    return responses.length === 0 ? null : responses;
  }

  return dispatchOne(body, options);
}
