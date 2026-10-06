/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";

import { dispatchJsonRpc, type McpInvocation } from "../src/mcp/jsonrpc.js";

function invocation(onToolCall: McpInvocation["onToolCall"] = async () => "ok"): McpInvocation {
  return {
    tools: [{ name: "echo" }],
    resources: [{ uri: "file://a" }],
    prompts: [{ name: "hi" }],
    onToolCall,
  };
}

describe("JSON-RPC", () => {
  it("answers the standard MCP methods", async () => {
    const options = invocation();
    const initialized = await dispatchJsonRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, options);
    expect(initialized).toMatchObject({ result: { serverInfo: { name: "mock-engine" } } });

    expect(await dispatchJsonRpc({ jsonrpc: "2.0", id: "p", method: "ping" }, options)).toMatchObject({ result: {} });
    expect(await dispatchJsonRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, options)).toMatchObject({
      result: { tools: options.tools },
    });
    expect(await dispatchJsonRpc({ jsonrpc: "2.0", id: 3, method: "resources/list" }, options)).toMatchObject({
      result: { resources: options.resources },
    });
    expect(await dispatchJsonRpc({ jsonrpc: "2.0", id: 4, method: "prompts/list" }, options)).toMatchObject({
      result: { prompts: options.prompts },
    });
    expect(await dispatchJsonRpc({ jsonrpc: "2.0", id: 5, method: "nope" }, options)).toMatchObject({
      error: { code: -32601 },
    });
  });

  it("calls tools and reports invalid params or failures", async () => {
    const ok = await dispatchJsonRpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { q: 1 } } },
      invocation(async () => "pong"),
    );
    expect(ok).toMatchObject({ result: { content: [{ type: "text", text: "pong" }] } });

    const structured = await dispatchJsonRpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } },
      invocation(async () => ({ content: [{ type: "text", text: "ready" }] })),
    );
    expect(structured).toMatchObject({ result: { content: [{ type: "text", text: "ready" }] } });

    const objectResult = await dispatchJsonRpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } },
      invocation(async () => ({ n: 1 })),
    );
    expect(objectResult).toMatchObject({ result: { content: [{ text: '{"n":1}' }] } });

    const empty = await dispatchJsonRpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } },
      invocation(async () => undefined),
    );
    expect(empty).toMatchObject({ result: { content: [{ text: "" }] } });

    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const unserializable = await dispatchJsonRpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } },
      invocation(async () => circular),
    );
    expect(unserializable).toMatchObject({ result: { content: [{ text: "" }] } });

    expect(
      await dispatchJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "" } }, invocation()),
    ).toMatchObject({ error: { code: -32602 } });
    expect(
      await dispatchJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: [] }, invocation()),
    ).toMatchObject({ error: { code: -32602 } });
    expect(
      await dispatchJsonRpc(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: [] } },
        invocation(),
      ),
    ).toMatchObject({ error: { code: -32602 } });

    const failed = await dispatchJsonRpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } },
      invocation(async () => {
        throw new Error("nope");
      }),
    );
    expect(failed).toMatchObject({ error: { code: -32603, message: "nope" } });

    const blank = await dispatchJsonRpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } },
      invocation(async () => {
        throw new Error("");
      }),
    );
    expect(blank).toMatchObject({ error: { message: "Tool call failed" } });

    const thrown = await dispatchJsonRpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } },
      invocation(async () => {
        throw "boom";
      }),
    );
    expect(thrown).toMatchObject({ error: { message: "Tool call failed" } });
  });

  it("rejects malformed payloads and skips notifications", async () => {
    expect(await dispatchJsonRpc(null, invocation())).toMatchObject({ error: { code: -32700 } });
    expect(await dispatchJsonRpc(undefined, invocation())).toMatchObject({ error: { code: -32700 } });
    expect(await dispatchJsonRpc("nope", invocation())).toMatchObject({ error: { code: -32600 } });
    expect(await dispatchJsonRpc({ jsonrpc: "1.0", method: "ping" }, invocation())).toMatchObject({
      error: { code: -32600 },
    });
    expect(await dispatchJsonRpc({ jsonrpc: "1.0", id: 1, method: "ping" }, invocation())).toMatchObject({
      error: { code: -32600 },
    });
    expect(await dispatchJsonRpc({ jsonrpc: "2.0", id: { bad: true }, method: "ping" }, invocation())).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
    expect(await dispatchJsonRpc({ jsonrpc: "2.0", method: "ping" }, invocation())).toBeNull();
    expect(await dispatchJsonRpc([], invocation())).toMatchObject({ error: { code: -32600 } });

    const batch = await dispatchJsonRpc(
      [
        { jsonrpc: "2.0", method: "ping" },
        { jsonrpc: "2.0", id: null, method: "ping" },
      ],
      invocation(),
    );
    expect(batch).toEqual([{ jsonrpc: "2.0", id: null, result: {} }]);
    expect(await dispatchJsonRpc([{ jsonrpc: "2.0", method: "ping" }], invocation())).toBeNull();
  });
});
