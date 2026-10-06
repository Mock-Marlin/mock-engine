/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";

import {
  delay,
  documentGuardHeaders,
  filterPublicResponseHeaders,
  headerText,
  isHttpMethod,
  isValidRoutePath,
  normalizeBasePath,
  normalizeRoutePath,
  queryRecord,
  remainingPath,
  stringHeaders,
} from "../src/http.js";
import type { FastifyRequest } from "fastify";

function request(parts: { url?: string; params?: unknown }): FastifyRequest {
  return parts as FastifyRequest;
}

describe("HTTP helpers", () => {
  it("normalizes base and route paths", () => {
    expect(normalizeBasePath(undefined)).toBe("/s");
    expect(normalizeBasePath("  ")).toBe("/s");
    expect(normalizeBasePath("s")).toBe("/s");
    expect(normalizeBasePath("/custom/")).toBe("/custom");
    expect(normalizeRoutePath("  ")).toBe("/");
    expect(normalizeRoutePath("users/")).toBe("/users");
    expect(normalizeRoutePath("/")).toBe("/");
    expect(isValidRoutePath("/users")).toBe(true);
    expect(isValidRoutePath("/bad path")).toBe(false);
    expect(isValidRoutePath(`/${"a".repeat(256)}`)).toBe(false);
    expect(isHttpMethod("GET")).toBe(true);
    expect(isHttpMethod("TRACE")).toBe(false);
  });

  it("reads the path that remains after the workspace key", () => {
    expect(remainingPath(request({ url: "/s/acme/users", params: { "*": "users/" } }), "/s", "acme")).toBe("/users");
    expect(remainingPath(request({ url: "/s/acme", params: {} }), "/s", "acme")).toBe("/");
    expect(remainingPath(request({ url: "/s/acme/users?x=1", params: { "*": 1 } }), "/s", "acme")).toBe("/users");
    expect(remainingPath(request({ url: "/other", params: null }), "/s", "acme")).toBe("/");
  });

  it("flattens headers and query values", () => {
    expect(headerText("application/json")).toBe("application/json");
    expect(headerText(["text/plain", "extra"])).toBe("text/plain");
    expect(headerText([1])).toBe("");
    expect(headerText(undefined)).toBe("");
    expect(stringHeaders({ a: "1", b: ["2", "3"], c: [1], d: 4 })).toEqual({ a: "1", b: "2, 3" });
    expect(queryRecord({ q: "1" })).toEqual({ q: "1" });
    expect(queryRecord("nope")).toEqual({});
  });

  it("drops cookie and policy headers a mock must not set", () => {
    expect(
      filterPublicResponseHeaders({
        "Set-Cookie": "mockmarlin_session=stolen",
        "X-Request-Id": "abc",
        "X-Bad": "line\r\nSet-Cookie: a=b",
        "Content-Security-Policy": "default-src *",
      }),
    ).toEqual({ "X-Request-Id": "abc" });
    expect(documentGuardHeaders("text/html; charset=utf-8")["Content-Security-Policy"]).toContain("sandbox");
    expect(documentGuardHeaders("application/json")["Content-Security-Policy"]).toBeUndefined();
  });

  it("resolves immediately when the delay is not positive", async () => {
    await expect(delay(0)).resolves.toBeUndefined();
    const started = Date.now();
    await delay(15);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });
});
