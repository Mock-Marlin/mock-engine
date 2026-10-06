/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";

import { createKeyLayout } from "../src/keys.js";
import { createApp, WORKSPACE_ID } from "./support.js";

const MOCK_ID = "hello-1";

function storedMock(): string {
  return JSON.stringify({
    statusCode: 200,
    payload: {
      type: "json",
      storage: "inline",
      body: JSON.stringify({ ok: true }),
    },
  });
}

describe("engine options", () => {
  it("reads REST documents under a custom key prefix", async () => {
    const { app, redis } = await createApp({ keyPrefix: "widgets" });
    const keys = createKeyLayout("widgets");
    await redis.set(keys.route(WORKSPACE_ID, "GET", "/hello"), MOCK_ID);
    await redis.set(keys.mock(MOCK_ID), storedMock());

    const response = await app.inject({ method: "GET", url: "/s/acme/hello" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });

  it("reads REST documents from a fully custom key layout", async () => {
    const keys = createKeyLayout("widgets");
    const custom = {
      ...keys,
      route: () => "custom:route",
      mock: () => "custom:mock",
    };
    const { app, redis } = await createApp({ keys: custom });
    await redis.set("custom:route", MOCK_ID);
    await redis.set("custom:mock", storedMock());

    const response = await app.inject({ method: "GET", url: "/s/acme/hello" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });

  it("leaves a key with no expiry untouched when ttl is omitted", async () => {
    const keys = createKeyLayout();
    const route = keys.route(WORKSPACE_ID, "GET", "/hello");
    const mock = keys.mock(MOCK_ID);
    const { app, redis } = await createApp();
    await redis.set(route, MOCK_ID);
    await redis.set(mock, storedMock());

    const response = await app.inject({ method: "GET", url: "/s/acme/hello" });

    expect(response.statusCode).toBe(200);
    expect(await redis.ttl(route)).toBe(-1);
    expect(await redis.ttl(mock)).toBe(-1);
    await app.close();
  });

  it("refreshes TTL only for the keys that configure it", async () => {
    const keys = createKeyLayout();
    const route = keys.route(WORKSPACE_ID, "GET", "/hello");
    const mock = keys.mock(MOCK_ID);
    const { app, redis } = await createApp({ ttl: { route: 90 } });
    await redis.set(route, MOCK_ID);
    await redis.set(mock, storedMock());

    const response = await app.inject({ method: "GET", url: "/s/acme/hello" });

    expect(response.statusCode).toBe(200);
    expect(await redis.ttl(route)).toBeGreaterThan(0);
    expect(await redis.ttl(mock)).toBeLessThan(0);
    await app.close();
  });

  it("returns 404 for a disabled protocol instead of serving another one", async () => {
    const keys = createKeyLayout();
    const { app, redis } = await createApp({ protocols: { rest: false, mcp: false } });
    await redis.set(keys.route(WORKSPACE_ID, "GET", "/hello"), MOCK_ID);
    await redis.set(keys.mock(MOCK_ID), storedMock());

    const rest = await app.inject({ method: "GET", url: "/s/acme/hello" });
    const mcp = await app.inject({ method: "GET", url: "/s/acme/mcp/sse" });

    expect(rest.statusCode).toBe(404);
    expect(mcp.statusCode).toBe(404);
    await app.close();
  });

  it("mounts workspaces under a custom base path", async () => {
    const keys = createKeyLayout();
    const { app, redis } = await createApp({ basePath: "/mocks" });
    await redis.set(keys.route(WORKSPACE_ID, "GET", "/hello"), MOCK_ID);
    await redis.set(keys.mock(MOCK_ID), storedMock());

    const response = await app.inject({ method: "GET", url: "/mocks/acme/hello" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });
});
