/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseArgv, runCheck, runInit } from "../src/cli.js";
import { SPEC_TEMPLATE } from "../src/spec.js";

const ENV_KEYS = ["PORT", "GRPC_PORT", "HOST", "WORKSPACE", "MOCK_IMPORT", "MOCK_CONFIG", "REDIS_URL"] as const;

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const directory = dirs.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

describe("parseArgv", () => {
  it("reads flags, env, and subcommands", () => {
    withEnv({}, () => {
      expect(parseArgv([])).toEqual({ action: "serve", options: {} });
      expect(parseArgv(["--port=4090", "--grpc-port", "1", "--host", "0.0.0.0", "--workspace", "shop"])).toEqual({
        action: "serve",
        options: { port: 4090, grpcPort: 1, host: "0.0.0.0", workspace: "shop" },
      });
      expect(parseArgv(["-c", "shop.yaml", "--examples"])).toEqual({
        action: "serve",
        options: { specPath: "shop.yaml", examples: true },
      });
      expect(parseArgv(["--import", "a.json", "--import=b.yaml"])).toEqual({
        action: "serve",
        options: { importPaths: ["a.json", "b.yaml"] },
      });
      expect(parseArgv(["--help"]).action).toBe("help");
      expect(parseArgv(["--port", "1", "-h"]).action).toBe("help");
      expect(parseArgv(["-V"])).toEqual({ action: "version", text: "0.1.0" });
      expect(parseArgv(["init", "--version"]).action).toBe("version");
      expect(parseArgv(["check", "--help"]).action).toBe("help");
      expect(parseArgv(["client", "--url", "http://127.0.0.1:1", "mocks"])).toEqual({
        action: "client",
        argv: ["--url", "http://127.0.0.1:1", "mocks"],
      });
      expect(parseArgv(["init", "-f", "-o", "out.yml"])).toEqual({ action: "init", output: "out.yml", force: true });
      expect(parseArgv(["init", "--output=out.yml"])).toEqual({ action: "init", output: "out.yml", force: false });
      expect(parseArgv(["check", "--config=shop.yaml"])).toEqual({ action: "check", specPath: "shop.yaml" });
      expect(parseArgv(["check"])).toEqual({ action: "check" });
      expect(() => parseArgv(["--config", "a.yaml", "--import", "b.json"])).toThrow(/not both/);
      expect(() => parseArgv(["--examples=1"])).toThrow(/does not take a value/);
      expect(() => parseArgv(["--port"])).toThrow(/Missing value/);
      expect(() => parseArgv(["--config="])).toThrow(/Missing value/);
      expect(() => parseArgv(["--nope"])).toThrow(/Unknown argument/);
      expect(() => parseArgv(["init", "--bogus"])).toThrow(/Unknown argument/);
      expect(() => parseArgv(["init", "-o"])).toThrow(/Missing value/);
      expect(() => parseArgv(["init", "--force=yes"])).toThrow(/does not take a value/);
      expect(() => parseArgv(["check", "--extra"])).toThrow(/Unknown argument/);
    });
  });

  it("lets flags replace env and reads MOCK_CONFIG", () => {
    withEnv(
      { PORT: "9", GRPC_PORT: "8", HOST: "10.0.0.1", WORKSPACE: "shop", REDIS_URL: "redis://127.0.0.1:6379", MOCK_CONFIG: "from-env.yaml" },
      () => {
        expect(parseArgv([])).toEqual({
          action: "serve",
          options: {
            port: 9,
            grpcPort: 8,
            host: "10.0.0.1",
            workspace: "shop",
            redisUrl: "redis://127.0.0.1:6379",
            specPath: "from-env.yaml",
          },
        });
        expect(parseArgv(["check"])).toEqual({ action: "check", specPath: "from-env.yaml" });
      },
    );
    withEnv({ PORT: "9", HOST: "10.0.0.1", MOCK_IMPORT: "from-env.json, other.yaml" }, () => {
      expect(parseArgv([])).toEqual({
        action: "serve",
        options: { port: 9, host: "10.0.0.1", importPaths: ["from-env.json", "other.yaml"] },
      });
      expect(parseArgv(["--import", "flag.json"])).toEqual({
        action: "serve",
        options: { port: 9, host: "10.0.0.1", importPaths: ["flag.json"] },
      });
    });
    withEnv({ MOCK_CONFIG: "a.yaml", MOCK_IMPORT: "b.json" }, () => {
      expect(() => parseArgv([])).toThrow(/not both/);
    });
    withEnv({ PORT: "nope" }, () => {
      expect(() => parseArgv([])).toThrow(/Invalid PORT/);
    });
  });
});

describe("init and check", () => {
  it("writes a starter and refuses to overwrite it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mock-engine-cli-"));
    dirs.push(directory);
    const previous = process.cwd();
    process.chdir(directory);
    try {
      const wrote = await captureStdout(() => runInit("mock-engine.yaml", false));
      expect(wrote).toContain("Wrote mock-engine.yaml");
      const nested = await captureStdout(() => runInit("nested/spec.yaml", false));
      expect(nested).toContain("nested/spec.yaml");
      await expect(runInit("mock-engine.yaml", false)).rejects.toThrow(/Pass --force/);
      const again = await captureStdout(() => runInit("mock-engine.yaml", true));
      expect(again).toContain("Wrote mock-engine.yaml");
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(path.join(directory, "mock-engine.yaml"), "utf8")).toBe(SPEC_TEMPLATE);
      const report = await captureStdout(() => runCheck(undefined));
      expect(report).toBe("workspace default\nGET /health\n");
      await writeFile(
        path.join(directory, "api.json"),
        JSON.stringify({
          item: [{ request: { method: "POST", url: "/widgets" }, response: [{ code: 201, body: {} }] }],
        }),
      );
      await writeFile(path.join(directory, "with-import.yaml"), "version: 1\nimports:\n  - ./api.json\n");
      const imported = await captureStdout(() => runCheck("with-import.yaml"));
      expect(imported).toContain("POST /widgets");
    } finally {
      process.chdir(previous);
    }
  });

  it("reports a missing spec", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mock-engine-cli-"));
    dirs.push(directory);
    const previous = process.cwd();
    process.chdir(directory);
    try {
      await expect(runCheck(undefined)).rejects.toThrow(/mock-engine init/);
      await expect(runCheck("missing.yaml")).rejects.toThrow(/file not found/);
      await writeFile(path.join(directory, "mock-engine.yaml"), "version: 1\n");
      await writeFile(path.join(directory, "mock-engine.yml"), "version: 1\n");
      await expect(runCheck(undefined)).rejects.toThrow(/found both/);
    } finally {
      process.chdir(previous);
    }
  });
});
