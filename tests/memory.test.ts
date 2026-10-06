/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { createKeyLayout, mockEngine, mockEngineWebsocketOptions } from "../src/index.js";
import { openDocumentStore } from "../src/store.js";
import { resolveWorkspaceId, WORKSPACE_ID } from "./support.js";

function storedMock(ok: boolean): string {
  return JSON.stringify({
    statusCode: 200,
    payload: {
      type: "json",
      storage: "inline",
      body: JSON.stringify({ ok }),
    },
  });
}

describe("memory mode", () => {
  it("serves a REST document from the static map and misses unknown keys", async () => {
    const keys = createKeyLayout();
    const data: Record<string, string> = {
      [keys.route(WORKSPACE_ID, "GET", "/hello")]: "hello-1",
      [keys.mock("hello-1")]: storedMock(true),
    };
    const engine = {
      mode: "memory" as const,
      data,
      resolveWorkspaceId,
      basePath: "/s",
    };
    const app = Fastify();
    await app.register(websocket, { options: mockEngineWebsocketOptions(engine) });
    await app.register(mockEngine, engine);
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/s/acme/hello" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const missing = await app.inject({ method: "GET", url: "/s/acme/missing" });
    expect(missing.statusCode).toBe(404);

    data[keys.mock("hello-1")] = storedMock(false);
    const again = await app.inject({ method: "GET", url: "/s/acme/hello" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true });

    await app.close();
  });

  it("rejects a memory store without string data and a redis store without a client", () => {
    expect(() => openDocumentStore({ mode: "memory" })).toThrow("mock-engine memory mode requires data");
    expect(() =>
      openDocumentStore({
        mode: "memory",
        data: { bad: 1 } as unknown as Record<string, string>,
      }),
    ).toThrow("mock-engine memory data values must be strings (bad)");
    expect(() => openDocumentStore({})).toThrow("mock-engine redis mode requires redis");
  });
});
