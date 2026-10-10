/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  createWorkspace,
  deleteWorkspace,
  importCollected,
  listWorkspaceNames,
  loadDraft,
  saveDraft,
} from "../src/app/admin.js";
import { commandHelp, isMockKind, parseClientLine, refLabel } from "../src/app/client-command.js";
import { BLANK_DRAFT, draftToYaml, refOf, sameRef, yamlToDraft } from "../src/app/draft.js";
import { serve, type RunningServer } from "../src/app/serve.js";
import { createKeyLayout } from "../src/keys.js";
import { createMemoryStore } from "../src/store.js";

const running: RunningServer[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.close();
  }
});

describe("client commands", () => {
  it("parses the everyday commands", () => {
    expect(parseClientLine("mocks").type).toBe("mocks");
    expect(parseClientLine("ls").type).toBe("mocks");
    expect(parseClientLine("new billing")).toEqual({ type: "new", name: "billing" });
    expect(parseClientLine("use billing")).toEqual({ type: "use", name: "billing" });
    expect(parseClientLine("rm workspace billing")).toEqual({ type: "remove-workspace", name: "billing" });
    expect(parseClientLine("edit GET /hello")).toMatchObject({ type: "edit", ref: { kind: "rest", method: "GET", path: "/hello" } });
    expect(parseClientLine("edit sse /events")).toMatchObject({ type: "edit", ref: { kind: "sse", path: "/events" } });
    expect(parseClientLine("edit grpc demo.Greeter/SayHello")).toMatchObject({
      type: "edit",
      ref: { kind: "grpc", service: "demo.Greeter", rpc: "SayHello" },
    });
    expect(parseClientLine("rm mcp")).toMatchObject({ type: "remove", ref: { kind: "mcp" } });
    expect(parseClientLine("import ./specs --clash skip")).toEqual({ type: "import", file: "./specs", clash: "skip" });
    expect(parseClientLine("help").type).toBe("help");
    expect(parseClientLine("quit").type).toBe("quit");
    expect(() => parseClientLine("nope")).toThrow(/Unknown command/);
    expect(() => parseClientLine("import ./a.json --clash merge")).toThrow(/clash/);
    expect(() => parseClientLine("edit grpc greeter")).toThrow(/SayHello/);
    expect(() => parseClientLine("   ")).toThrow(/help/);
    expect(parseClientLine("?").type).toBe("help");
    expect(parseClientLine("exit").type).toBe("quit");
    expect(parseClientLine("ws").type).toBe("workspaces");
    expect(parseClientLine("list").type).toBe("mocks");
    expect(parseClientLine("new-mock").type).toBe("add");
    expect(parseClientLine("delete workspace beta")).toEqual({ type: "remove-workspace", name: "beta" });
    expect(parseClientLine("import ./a.json")).toEqual({ type: "import", file: "./a.json" });
    expect(parseClientLine("edit GET hello").type).toBe("edit");
    expect(parseClientLine("edit websocket /ws")).toMatchObject({ ref: { kind: "websocket" } });
    expect(parseClientLine("edit chunked /chunked")).toMatchObject({ ref: { kind: "chunked" } });
    expect(parseClientLine("edit graphql /graphql")).toMatchObject({ ref: { kind: "graphql", method: "POST" } });
    expect(() => parseClientLine("use")).toThrow(/workspace name/);
    expect(() => parseClientLine("edit")).toThrow(/GET \/hello/);
    expect(() => parseClientLine("import")).toThrow(/file/);
    expect(() => parseClientLine("edit FOO /x")).toThrow(/method/);
    expect(commandHelp()).toContain("import");
    expect(isMockKind("rest")).toBe(true);
    expect(isMockKind("nope")).toBe(false);
    expect(refLabel({ kind: "grpc", method: "RPC", path: "demo.Greeter/SayHello", service: "demo.Greeter", rpc: "SayHello" })).toBe("grpc demo.Greeter/SayHello");
    expect(refLabel({ kind: "mcp", method: "POST", path: "/mcp", service: "", rpc: "" })).toBe("mcp");
    expect(refLabel({ kind: "sse", method: "GET", path: "/events", service: "", rpc: "" })).toBe("sse /events");
    const rest = yamlToDraft(BLANK_DRAFT);
    expect(sameRef(refOf(rest), refOf(yamlToDraft(draftToYaml(rest))))).toBe(true);
    expect(() => yamlToDraft("[")).toThrow(/Could not read/);
    expect(() => yamlToDraft("[]")).toThrow(/YAML object/);
    expect(() => yamlToDraft("kind: rest\nmethod: NOPE\npath: /x")).toThrow(/method/);
    expect(() => yamlToDraft("kind: rest\nmethod: GET\npath: /x\nstatus: 99")).toThrow(/status/);
    expect(yamlToDraft("kind: rest\nmethod: GET\npath: hello\nheaders:\n  x: 1\nbody: hi")).toMatchObject({
      path: "/hello",
      headers: { x: "1" },
      body: "hi",
    });
    expect(() => yamlToDraft("kind: sse\npath: /e")).toThrow(/body/);
    expect(() => yamlToDraft("kind: graphql\npath: /g")).toThrow(/sdl/);
    expect(() => yamlToDraft("kind: mcp\ntools: nope")).toThrow(/tools/);
    expect(() => yamlToDraft("kind: grpc\nservice: demo.Greeter")).toThrow(/rpc/);
    expect(() => yamlToDraft("kind: rest\nmethod: GET\npath: /x\ndelayMs: nope")).toThrow(/number/);
    expect(() => yamlToDraft("kind: rest\nmethod: GET\npath: /x\nheaders: []")).toThrow(/headers/);
    expect(() => yamlToDraft("kind: rest\nmethod: GET\npath: /x\nheaders:\n  x:\n    y: 1")).toThrow(/header/);
    expect(yamlToDraft("kind: rest\nmethod: GET\npath: /x\nheaders:\n  x: true")).toMatchObject({ headers: { x: "true" } });
    expect(() => yamlToDraft("kind: mcp\ntools:\n  - nope")).toThrow(/tool/);
    expect(() => yamlToDraft("kind: sse\npath: /e\nbody: hi\nresources: nope")).not.toThrow();
    expect(() => yamlToDraft("kind: mcp\ntools: []\nresources: nope")).toThrow(/list/);
    expect(yamlToDraft(BLANK_DRAFT)).toMatchObject({ kind: "rest", method: "GET", path: "/example" });
    expect(() => yamlToDraft("kind: teapot")).toThrow(/kind/);
    expect(yamlToDraft("kind: mcp\ntools:\n  - name: echo\n    body:\n      ok: true")).toMatchObject({
      kind: "mcp",
      tools: [{ name: "echo" }],
    });
  });
});

describe("admin api", () => {
  it("creates workspaces, edits mocks, and asks before replacing a path", async () => {
    const seen: string[] = [];
    const server = await serve({
      port: 0,
      grpcPort: 0,
      onTraffic(event) {
        seen.push(event.target);
      },
    });
    running.push(server);
    const base = `http://127.0.0.1:${String(server.port)}`;

    const listed = await json(base, "/_admin/workspaces");
    expect(listed.workspaces).toContain("default");
    const again = await fetch(`${base}/_admin/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "default" }),
    });
    expect(again.status).toBe(409);

    const created = await fetch(`${base}/_admin/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "billing" }),
    });
    expect(created.status).toBe(201);
    expect((await fetch(`${base}/_admin/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bad name" }),
    })).status).toBe(400);

    const saved = await putDraft(base, "billing", {
      kind: "rest",
      method: "GET",
      path: "/invoices",
      status: 200,
      delayMs: 0,
      headers: {},
      body: { ok: true },
    });
    expect(saved.status).toBe(200);
    expect(await (await fetch(`${base}/s/billing/invoices`)).json()).toEqual({ ok: true });

    const rejected = await putDraft(base, "billing", {
      kind: "rest",
      method: "GET",
      path: "/invoices",
      status: 200,
      delayMs: 0,
      headers: {},
      body: { ok: false },
    });
    expect(rejected.status).toBe(409);
    expect(await (await fetch(`${base}/s/billing/invoices`)).json()).toEqual({ ok: true });

    const replaced = await putDraft(base, "billing", {
      kind: "rest",
      method: "GET",
      path: "/invoices",
      status: 201,
      delayMs: 0,
      headers: { "x-from": "edit" },
      body: { ok: false },
    }, "replace");
    expect(replaced.status).toBe(200);
    const invoice = await fetch(`${base}/s/billing/invoices`);
    expect(invoice.status).toBe(201);
    expect(await invoice.json()).toEqual({ ok: false });
    expect(invoice.headers.get("x-from")).toBe("edit");

    const skipped = await putDraft(base, "billing", {
      kind: "rest",
      method: "GET",
      path: "/invoices",
      status: 200,
      delayMs: 0,
      headers: {},
      body: { ok: true },
    }, "skip");
    expect(skipped.status).toBe(200);
    expect(((await skipped.json()) as { action: string }).action).toBe("skipped");
    expect(await (await fetch(`${base}/s/billing/invoices`)).json()).toEqual({ ok: false });

    const edited = await putDraft(base, "billing", {
      kind: "rest",
      method: "GET",
      path: "/invoices",
      status: 200,
      delayMs: 0,
      headers: {},
      body: { edited: true },
    }, "reject", { kind: "rest", method: "GET", path: "/invoices", service: "", rpc: "" });
    expect(edited.status).toBe(200);
    expect(await (await fetch(`${base}/s/billing/invoices`)).json()).toEqual({ edited: true });

    const moved = await putDraft(base, "billing", {
      kind: "rest",
      method: "GET",
      path: "/bills",
      status: 200,
      delayMs: 0,
      headers: {},
      body: { moved: true },
    }, "reject", { kind: "rest", method: "GET", path: "/invoices", service: "", rpc: "" });
    expect(moved.status).toBe(200);
    expect((await fetch(`${base}/s/billing/invoices`)).status).toBe(404);
    expect(await (await fetch(`${base}/s/billing/bills`)).json()).toEqual({ moved: true });

    const clashImport = await postImport(base, "billing", "reject");
    expect(clashImport.status).toBe(409);
    expect((await fetch(`${base}/s/billing/other`)).status).toBe(404);

    const skippedImport = await postImport(base, "billing", "skip");
    expect(skippedImport.status).toBe(200);
    expect(await (await fetch(`${base}/s/billing/other`)).json()).toEqual({ items: [1] });
    expect(await (await fetch(`${base}/s/billing/bills`)).json()).toEqual({ moved: true });

    const replacedImport = await postImport(base, "billing", "replace");
    expect(replacedImport.status).toBe(200);
    expect(await (await fetch(`${base}/s/billing/bills`)).json()).toEqual({ items: [1] });

    await server.reload();
    expect(server.mocks.some((mock) => mock.target === "/s/default/hello")).toBe(true);

    const removed = await fetch(`${base}/_admin/workspaces/billing/draft?kind=rest&method=GET&path=${encodeURIComponent("/other")}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect((await fetch(`${base}/s/billing/other`)).status).toBe(404);

    const draft = await json(base, `/_admin/workspaces/default/draft?kind=rest&method=GET&path=${encodeURIComponent("/hello")}`);
    expect(draft.draft).toMatchObject({ kind: "rest", path: "/hello", body: { ok: true, kind: "rest" } });

    const grpcDraft = await json(base, "/_admin/workspaces/default/draft?kind=grpc&service=demo.Greeter&rpc=SayHello");
    expect(grpcDraft.draft).toMatchObject({ kind: "grpc", body: { message: "hello" } });
    const grpcPut = await fetch(`${base}/_admin/workspaces/default/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clash: "replace",
        draft: { kind: "grpc", service: "demo.Greeter", rpc: "SayHello", latencyMs: 0, errorCode: null, body: { message: "edited" } },
      }),
    });
    expect(grpcPut.status).toBe(200);

    const sse = await fetch(`${base}/_admin/workspaces/default/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clash: "replace",
        previous: { kind: "sse", method: "GET", path: "/events", service: "", rpc: "" },
        draft: { kind: "sse", path: "/events", body: "edited stream" },
      }),
    });
    expect(sse.status).toBe(200);
    const events = await fetch(`${base}/s/default/events`);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    await events.body?.cancel();

    expect((await fetch(`${base}/_admin/workspaces/missing/mocks`)).status).toBe(404);
    expect((await fetch(`${base}/_admin/workspaces/billing`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}/s/billing/bills`)).status).toBe(404);
    expect(seen.some((target) => target.startsWith("/_admin"))).toBe(false);
    expect(seen.some((target) => target.includes("/invoices"))).toBe(true);

    expect((await json(base, "/_admin/workspaces/default/draft?kind=graphql&path=/graphql")).draft).toMatchObject({ kind: "graphql" });
    expect((await json(base, "/_admin/workspaces/default/draft?kind=mcp")).draft).toMatchObject({ kind: "mcp" });
    const chunked = await fetch(`${base}/_admin/workspaces/default/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: { kind: "chunked", path: "/chunked", body: "more" }, clash: "replace" }),
    });
    expect(chunked.status).toBe(200);
    const socket = await fetch(`${base}/_admin/workspaces/default/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: { kind: "websocket", path: "/ws", body: "again" },
        clash: "replace",
        previous: { kind: "websocket", method: "GET", path: "/ws", service: "", rpc: "" },
      }),
    });
    expect(socket.status).toBe(200);
    expect((await fetch(`${base}/_admin/workspaces/default/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([]),
    })).status).toBe(400);
    expect((await fetch(`${base}/_admin/workspaces/default/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: { kind: "rest", method: "GET", path: "/hello" }, clash: "merge" }),
    })).status).toBe(400);
    expect((await fetch(`${base}/_admin/workspaces/default/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [] }),
    })).status).toBe(400);
    expect((await fetch(`${base}/_admin/workspaces/default/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ filename: "notes.txt", text: "hello" }] }),
    })).status).toBe(400);
    expect((await fetch(`${base}/_admin/workspaces/default/draft?kind=rest&method=GET&path=/missing`)).status).toBe(404);
    expect((await fetch(`${base}/_admin/workspaces/default/draft?kind=rest&method=GET&path=/missing`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${base}/_admin/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })).status).toBe(400);

    const root = await fetch(`${base}/_admin/workspaces/default/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: { kind: "rest", method: "GET", path: "/", status: 200, body: { root: true } } }),
    });
    expect(root.status).toBe(200);
    const mocks = await json(base, "/_admin/workspaces/default/mocks");
    expect(JSON.stringify(mocks)).toContain("\"path\":\"/\"");
    for (const path of [
      "/_admin/workspaces/default/draft?kind=sse&path=/events",
      "/_admin/workspaces/default/draft?kind=graphql&path=/graphql",
      "/_admin/workspaces/default/draft?kind=mcp",
      "/_admin/workspaces/default/draft?kind=grpc&service=demo.Greeter&rpc=SayHello",
    ]) {
      expect((await fetch(`${base}${path}`, { method: "DELETE" })).status).toBe(200);
    }
    expect((await fetch(`${base}/_admin/workspaces/default/draft?kind=nope`)).status).toBe(400);
    expect((await fetch(`${base}/_admin/workspaces/default/draft?kind=sse`)).status).toBe(400);
    expect((await fetch(`${base}/_admin/workspaces/default/draft?kind=grpc`)).status).toBe(400);
    expect((await fetch(`${base}/_admin/workspaces/default/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: { kind: "rest", method: "GET", path: "/fresh", status: 200, body: {} }, previous: 1 }),
    })).status).toBe(400);
    expect((await fetch(`${base}/_admin/workspaces/default/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [1] }),
    })).status).toBe(400);
    expect((await fetch(`${base}/_admin/workspaces/default/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ text: "{}" }] }),
    })).status).toBe(400);
    expect((await fetch(`${base}/_admin/workspaces/default/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ filename: "api.json", text: 1 }] }),
    })).status).toBe(400);
  });

  it("repairs a broken workspace list and stores every protocol", async () => {
    const store = createMemoryStore();
    const keys = createKeyLayout();
    await store.set("mockmarlin:workspaces", "not-json");
    expect(await listWorkspaceNames(store, keys)).toEqual([]);
    await store.set("mockmarlin:workspaces", JSON.stringify({ nope: true }));
    expect(await listWorkspaceNames(store, keys)).toEqual([]);
    await store.set("mockmarlin:workspaces", JSON.stringify([1, "beta"]));
    expect(await listWorkspaceNames(store, keys)).toEqual(["beta"]);
    await expect(deleteWorkspace(store, keys, "missing")).rejects.toThrow(/No workspace/);
    await expect(createWorkspace(store, keys, "beta")).rejects.toThrow(/already exists/);
    const unlistable = {
      get: async (key: string) => key.endsWith(":workspaces") ? JSON.stringify(["plain"]) : null,
      set: async () => undefined,
      expire: async () => undefined,
      del: async () => undefined,
    };
    await expect(deleteWorkspace(unlistable, keys, "plain")).rejects.toThrow(/list keys/);
    await expect(importCollected(store, keys, "beta", [], "reject")).rejects.toThrow(/No Postman/);
    await expect(importCollected(store, keys, "beta", [{ filename: "x.txt", text: "nope" }], "reject")).rejects.toThrow(/Postman|OpenAPI|HAR|recognize|format/i);
    await saveDraft(store, keys, "beta", { kind: "graphql", path: "/graphql", sdl: "type Query { hi: String }" }, "reject");
    expect(await loadDraft(store, keys, "beta", { kind: "graphql", method: "POST", path: "/graphql", service: "", rpc: "" })).toMatchObject({ sdl: "type Query { hi: String }" });
    await saveDraft(store, keys, "beta", { kind: "mcp", tools: [{ name: "echo", description: "", body: { ok: true } }], resources: [], prompts: [] }, "replace");
    expect(await loadDraft(store, keys, "beta", { kind: "mcp", method: "POST", path: "/mcp", service: "", rpc: "" })).toMatchObject({ kind: "mcp" });
    await saveDraft(store, keys, "beta", { kind: "websocket", path: "/ws", body: "hi" }, "reject");
    await saveDraft(store, keys, "beta", { kind: "chunked", path: "/down", body: "hi" }, "reject");
    expect(await loadDraft(store, keys, "beta", { kind: "chunked", method: "GET", path: "/down", service: "", rpc: "" })).toMatchObject({ body: "hi" });
    await saveDraft(store, keys, "beta", { kind: "grpc", service: "demo.Greeter", rpc: "SayHello", latencyMs: 0, errorCode: null, body: "text" }, "reject");
    expect(await loadDraft(store, keys, "beta", { kind: "grpc", method: "RPC", path: "demo.Greeter/SayHello", service: "demo.Greeter", rpc: "SayHello" })).toMatchObject({
      body: { value: "text" },
    });
    await store.set(keys.route("beta", "GET", "/bad"), "bad-id");
    await store.set(keys.mock("bad-id"), "not-json");
    await expect(loadDraft(store, keys, "beta", { kind: "rest", method: "GET", path: "/bad", service: "", rpc: "" })).rejects.toThrow(/invalid/);
    await store.set(keys.mock("bad-id"), JSON.stringify({ payload: { type: "json", body: "{" } }));
    expect(await loadDraft(store, keys, "beta", { kind: "rest", method: "GET", path: "/bad", service: "", rpc: "" })).toMatchObject({ body: "{" });
    await store.set(keys.stream("beta", "/odd"), "not-json");
    await expect(loadDraft(store, keys, "beta", { kind: "sse", method: "GET", path: "/odd", service: "", rpc: "" })).rejects.toThrow(/invalid/);
    await expect(loadDraft(store, keys, "beta", { kind: "sse", method: "GET", path: "/missing", service: "", rpc: "" })).rejects.toThrow(/No stream/);
    await store.set(keys.graphql("beta", "/g"), "not-json");
    await expect(loadDraft(store, keys, "beta", { kind: "graphql", method: "POST", path: "/g", service: "", rpc: "" })).rejects.toThrow(/invalid/);
    await store.set(keys.mcp("beta"), JSON.stringify({ tools: [{ name: 1 }] }));
    await expect(loadDraft(store, keys, "beta", { kind: "mcp", method: "POST", path: "/mcp", service: "", rpc: "" })).rejects.toThrow(/tool/);
    await store.set(keys.grpc("beta", "demo.Greeter", "Nope"), "not-json");
    await expect(loadDraft(store, keys, "beta", { kind: "grpc", method: "RPC", path: "demo.Greeter/Nope", service: "demo.Greeter", rpc: "Nope" })).rejects.toThrow(/invalid/);
    const exploding = {
      get: async (key: string) => key.endsWith(":workspaces") ? JSON.stringify(["plain"]) : null,
      set: async () => undefined,
      expire: async () => undefined,
      del: async () => undefined,
      list: async () => {
        throw new Error("boom");
      },
    };
    await expect(deleteWorkspace(exploding, keys, "plain")).rejects.toThrow(/boom/);
    await expect(saveDraft(store, keys, "beta", {
      kind: "rest",
      method: "GET",
      path: "bad path",
      status: 200,
      delayMs: 0,
      headers: {},
      body: {},
    }, "reject")).rejects.toThrow(/cannot be stored|Path/);
  });
});

function putDraft(
  base: string,
  workspace: string,
  draft: unknown,
  clash = "reject",
  previous?: unknown,
): Promise<Response> {
  const body: Record<string, unknown> = { clash, draft };
  if (previous !== undefined) {
    body["previous"] = previous;
  }
  return fetch(`${base}/_admin/workspaces/${workspace}/draft`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postImport(base: string, workspace: string, clash: string): Promise<Response> {
  return fetch(`${base}/_admin/workspaces/${workspace}/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clash,
      files: [
        {
          filename: "api.json",
          text: JSON.stringify({
            item: [
              { request: { method: "GET", url: "/bills" }, response: [{ code: 200, body: { items: [1] } }] },
              { request: { method: "GET", url: "/bills" }, response: [{ code: 200, body: { items: [2] } }] },
              { request: { method: "GET", url: "/other" }, response: [{ code: 200, body: { items: [1] } }] },
            ],
          }),
        },
      ],
    }),
  });
}

async function json(base: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`);
  return await response.json() as Record<string, unknown>;
}
