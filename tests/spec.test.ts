/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { serve } from "../src/app/serve.js";
import {
  discoverSpecFile,
  formatSpecReport,
  loadSpecFile,
  parseSpec,
  SPEC_TEMPLATE,
  SpecError,
} from "../src/spec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const exampleSpec = path.join(here, "..", "examples", "mock-engine.yaml");

const PROTO = `syntax = "proto3";
package demo;
service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
}
message HelloRequest { string name = 1; }
message HelloReply { string message = 1; }
`;

const running: Array<{ close: () => Promise<void> }> = [];
const dirs: string[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.close();
  }
  while (dirs.length > 0) {
    const directory = dirs.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "mock-engine-spec-"));
  dirs.push(directory);
  return directory;
}

describe("spec parser", () => {
  it("reads the starter template", async () => {
    const spec = await parseSpec(SPEC_TEMPLATE, path.join(tmpdir(), "mock-engine.yaml"));
    expect(spec.version).toBe(1);
    expect(spec.workspace).toBe("default");
    expect(spec.mocks).toEqual([
      expect.objectContaining({ kind: "rest", method: "GET", path: "/health", status: 200 }),
    ]);
    expect(formatSpecReport(spec)).toBe("workspace default\nGET /health");
  });

  it("resolves import and proto paths from the spec directory", async () => {
    const directory = await tempDir();
    const nested = path.join(directory, "nested");
    await mkdir(nested);
    await writeFile(path.join(directory, "demo.proto"), PROTO);
    await writeFile(
      path.join(directory, "api.json"),
      JSON.stringify({
        item: [{ request: { method: "GET", url: "/widgets" }, response: [{ code: 200, body: { n: 1 } }] }],
      }),
    );
    await writeFile(
      path.join(nested, "mock-engine.yaml"),
      [
        "version: 1",
        "workspace: shop",
        "imports:",
        "  - ../api.json",
        "mocks:",
        "  - kind: grpc",
        "    service: Greeter",
        "    rpc: SayHello",
        "    body:",
        "      message: hi",
        "protos:",
        "  - name: demo.proto",
        "    file: ../demo.proto",
      ].join("\n"),
    );
    const spec = await loadSpecFile(path.join(nested, "mock-engine.yaml"));
    expect(spec.workspace).toBe("shop");
    expect(spec.imports).toEqual([path.join(directory, "api.json")]);
    expect(spec.protos[0]?.content).toContain("service Greeter");
    expect(formatSpecReport(spec, [{ method: "GET", path: "/widgets" }])).toBe(
      "workspace shop\ngrpc Greeter/SayHello\nGET /widgets",
    );
  });

  it("accepts inline proto source", async () => {
    const spec = await parseSpec(
      ["version: 1", "mocks: []", "protos:", "  - name: demo.proto", "    content: |", "      service Greeter {}", ""].join("\n"),
      "/tmp/mock-engine.yaml",
    );
    expect(spec.mocks).toEqual([]);
    expect(spec.protos[0]?.content).toContain("service Greeter");
    expect(formatSpecReport(spec)).toBe("workspace default\n(no routes)");
    const bare = await parseSpec("version: 1\n", "/tmp/mock-engine.yaml");
    expect(bare.imports).toEqual([]);
    expect(bare.mocks).toEqual([]);
    expect(bare.protos).toEqual([]);
    expect(bare.workspace).toBe("default");
  });

  it("rejects a document that is not a spec", async () => {
    const file = "/tmp/mock-engine.yaml";
    await expect(parseSpec("a: [", file)).rejects.toThrow(SpecError);
    await expect(parseSpec("[]", file)).rejects.toThrow(/must be a YAML object/);
    await expect(parseSpec("version: 2\n", file)).rejects.toThrow(/version: must be 1/);
    await expect(parseSpec('version: "1"\n', file)).rejects.toThrow(/version: must be 1/);
    await expect(parseSpec("version: 1\nextra: 1\n", file)).rejects.toThrow(/extra: unknown field/);
    await expect(parseSpec("version: 1\nworkspace: bad name\n", file)).rejects.toThrow(/workspace:/);
    await expect(parseSpec("version: 1\nimports: no\n", file)).rejects.toThrow(/imports: must be a list/);
    await expect(parseSpec("version: 1\nimports:\n  - 1\n", file)).rejects.toThrow(/imports\[0\]: must be a path/);
    await expect(parseSpec("version: 1\nimports:\n  - /no/such/import.json\n", file)).rejects.toThrow(/not found/);
    await expect(parseSpec("version: 1\nmocks: {}\n", file)).rejects.toThrow(/mocks: must be a list/);
    await expect(parseSpec("version: 1\nmocks:\n  - kind: rest\n    method: GET\n", file)).rejects.toThrow(/mocks\[0\]: path must be a route/);
    await expect(parseSpec("version: 1\nprotos: {}\n", file)).rejects.toThrow(/protos: must be a list/);
    await expect(parseSpec("version: 1\nprotos:\n  - nope\n", file)).rejects.toThrow(/protos\[0\]: must be an object/);
    await expect(parseSpec("version: 1\nprotos:\n  - { name: demo.proto, content: 1 }\n", file)).rejects.toThrow(/must be proto source/);
    await expect(parseSpec("version: 1\nprotos:\n  - name: nope.txt\n    content: service X {}\n", file)).rejects.toThrow(
      /must be a file name ending in .proto/,
    );
  });

  it("rejects duplicate routes, broken protos, and a gRPC mock with no service", async () => {
    const directory = await tempDir();
    const file = path.join(directory, "mock-engine.yaml");
    await expect(
      parseSpec(
        ["version: 1", "mocks:", "  - { kind: rest, method: GET, path: /health }", "  - { kind: rest, method: GET, path: /health }"].join(
          "\n",
        ),
        file,
      ),
    ).rejects.toThrow(/repeats GET \/health/);
    const bothFields = ["version: 1", "protos:", "  - name: demo.proto", "    file: ./demo.proto", "    content: service Greeter"].join("\n");
    await expect(parseSpec(bothFields, file)).rejects.toThrow("not both");
    await expect(parseSpec(["version: 1", "protos:", "  - { name: demo.proto }"].join("\n"), file)).rejects.toThrow(
      /file or content is required/,
    );
    await expect(parseSpec(["version: 1", "protos:", "  - { name: demo.proto, content: '   ' }"].join("\n"), file)).rejects.toThrow(
      /must be proto source/,
    );
    await expect(parseSpec(["version: 1", "protos:", "  - { name: demo.proto, file: 1 }"].join("\n"), file)).rejects.toThrow(
      /must be a path/,
    );
    await expect(parseSpec(["version: 1", "protos:", "  - { name: demo.proto, file: ./missing.proto }"].join("\n"), file)).rejects.toThrow(
      /not found/,
    );
    await expect(
      parseSpec(
        [
          "version: 1",
          "protos:",
          "  - { name: demo.proto, content: 'service Greeter {}' }",
          "  - { name: demo.proto, content: 'service Greeter {}' }",
        ].join("\n"),
        file,
      ),
    ).rejects.toThrow(/repeats demo.proto/);
    await expect(
      parseSpec(
        ["version: 1", "mocks:", "  - { kind: grpc, service: demo.Greeter, rpc: SayHello }"].join("\n"),
        file,
      ),
    ).rejects.toThrow(/protos do not declare demo.Greeter/);
    await expect(
      parseSpec(
        ["version: 1", "mocks:", "  - { kind: grpc, service: demo., rpc: SayHello }", "protos:", "  - { name: demo.proto, content: 'service Greeter {}' }"].join(
          "\n",
        ),
        file,
      ),
    ).rejects.toThrow(/protos do not declare demo\./);
  });

  it("finds one spec file and rejects both names", async () => {
    const directory = await tempDir();
    expect(await discoverSpecFile(directory)).toBeNull();
    await writeFile(path.join(directory, "mock-engine.yml"), "version: 1\n");
    expect(await discoverSpecFile(directory)).toBe(path.join(directory, "mock-engine.yml"));
    await writeFile(path.join(directory, "mock-engine.yaml"), "version: 1\n");
    await expect(discoverSpecFile(directory)).rejects.toThrow(/found both/);
    await rm(path.join(directory, "mock-engine.yml"));
    expect(await discoverSpecFile(directory)).toBe(path.join(directory, "mock-engine.yaml"));
    await expect(loadSpecFile(path.join(directory, "missing.yaml"))).rejects.toThrow(/file not found/);
  });
});

describe("serve from a spec", () => {
  it("serves the sample spec instead of the built-in examples", async () => {
    const server = await serve({ port: 0, grpcPort: 0, specPath: exampleSpec });
    running.push(server);
    expect(server.source).toBe("spec");
    expect(server.workspace).toBe("shop");
    expect(server.imported).toBe(7);
    expect(server.grpcServices).toBe(1);
    expect(server.mocks.some((mock) => mock.target.endsWith("/hello"))).toBe(false);
    const health = await fetch(`http://127.0.0.1:${String(server.port)}/s/shop/health`);
    expect(await health.json()).toEqual({ ok: true });
    const hello = await fetch(`http://127.0.0.1:${String(server.port)}/s/shop/hello`);
    expect(hello.status).toBe(404);
  });

  it("lets --workspace override the file and keeps an empty spec empty", async () => {
    const directory = await tempDir();
    const empty = path.join(directory, "empty.yaml");
    await writeFile(empty, "version: 1\nmocks: []\n");
    const server = await serve({ port: 0, grpcPort: 0, specPath: empty, workspace: "other" });
    running.push(server);
    expect(server.workspace).toBe("other");
    expect(server.source).toBe("spec");
    expect(server.imported).toBe(0);
    expect(server.mocks).toEqual([]);
    const hello = await fetch(`http://127.0.0.1:${String(server.port)}/s/other/hello`);
    expect(hello.status).toBe(404);
  });

  it("loads a spec from the current directory and applies imported routes", async () => {
    const directory = await tempDir();
    await writeFile(
      path.join(directory, "api.json"),
      JSON.stringify({
        item: [
          { request: { method: "GET", url: "/widgets" }, response: [{ code: 200, body: { from: "import" } }] },
          { request: { method: "GET", url: "/health" }, response: [{ code: 200, body: { from: "import" } }] },
        ],
      }),
    );
    await writeFile(
      path.join(directory, "mock-engine.yaml"),
      ["version: 1", "imports:", "  - ./api.json", "mocks:", "  - kind: rest", "    method: GET", "    path: /health", "    body:", "      ok: true"].join(
        "\n",
      ),
    );
    const previous = process.cwd();
    process.chdir(directory);
    try {
      const server = await serve({ port: 0, grpcPort: 0 });
      running.push(server);
      expect(server.source).toBe("spec");
      const health = await fetch(`http://127.0.0.1:${String(server.port)}/s/default/health`);
      expect(await health.json()).toEqual({ ok: true });
      const widgets = await fetch(`http://127.0.0.1:${String(server.port)}/s/default/widgets`);
      expect(await widgets.json()).toEqual({ from: "import" });
      const hello = await fetch(`http://127.0.0.1:${String(server.port)}/s/default/hello`);
      expect(hello.status).toBe(404);
    } finally {
      process.chdir(previous);
    }
  });

  it("forces the examples and rejects a config combined with an import", async () => {
    const directory = await tempDir();
    await writeFile(path.join(directory, "mock-engine.yaml"), "version: 1\nmocks:\n  - kind: rest\n    method: GET\n    path: /health\n");
    const previous = process.cwd();
    process.chdir(directory);
    try {
      const server = await serve({ port: 0, grpcPort: 0, examples: true, specPath: "/no/such.yaml", importPaths: ["/no/such.json"] });
      running.push(server);
      expect(server.source).toBe("examples");
      const hello = await fetch(`http://127.0.0.1:${String(server.port)}/s/default/hello`);
      expect(hello.status).toBe(200);
    } finally {
      process.chdir(previous);
    }
    await expect(serve({ port: 0, grpcPort: 0, specPath: "/no/such.yaml" })).rejects.toThrow(/file not found/);
    await expect(serve({ port: 0, grpcPort: 0, specPath: exampleSpec, importPaths: ["/no/such.json"] })).rejects.toThrow(/not both/);
  });
});
