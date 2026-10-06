/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";

import { escapeMarkup } from "../src/http.js";
import { applyRestTemplate } from "../src/rest/template.js";

describe("REST templates", () => {
  it("fills request tokens and leaves unknown tokens in place", () => {
    const body = applyRestTemplate(
      "{{method}} {{path}} {{query.q}} {{header.X-Request}} {{body.name}} {{body.missing}} {{nope}} {{uuid}} {{now}}",
      "POST",
      "/s/acme/users",
      {
        headers: { "x-request": "abc" },
        query: { q: 2, extra: { n: 1 }, empty: null },
        body: { name: true },
      },
    );
    expect(body.startsWith("POST /s/acme/users 2 abc true {{body.missing}} {{nope}} ")).toBe(true);
    expect(body).toMatch(/[0-9a-f-]{36}/);
    expect(body).toMatch(/\d{4}-\d{2}-\d{2}T/);

    expect(
      applyRestTemplate("{{query.extra}} {{query.empty}} {{body.items}}", "GET", "/", {
        headers: {},
        query: { extra: { n: 1 }, empty: null },
        body: ["nope"],
      }),
    ).toBe('{"n":1} null {{body.items}}');

    expect(
      applyRestTemplate("{{header.X-Request}}", "GET", "/", { headers: { "X-Request": "direct" }, query: null, body: null }),
    ).toBe("direct");
    expect(applyRestTemplate("{{header.Missing}}", "GET", "/", { headers: { Other: "x" }, query: null, body: null })).toBe(
      "{{header.Missing}}",
    );
  });

  it("encodes substituted values and leaves the surrounding template text", () => {
    const body = applyRestTemplate("<p>{{query.q}}</p>", "GET", "/", {
      headers: {},
      query: { q: `<script>alert("x")</script>` },
      body: null,
    }, escapeMarkup);
    expect(body).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
  });
});
