#!/usr/bin/env node
/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runClient } from "./admin-cli.js";
import type { RunningServer, ServeOptions } from "./app/serve.js";
import { loadImports, serve } from "./app/serve.js";
import { formatTrafficLine, renderScreen, type TrafficEvent } from "./app/screen.js";
import { DEFAULT_GRPC_PORT, DEFAULT_HOST, DEFAULT_HTTP_PORT, SPEC_FILENAMES } from "./constants.js";
import { discoverSpecFile, formatSpecReport, loadSpecFile, SPEC_TEMPLATE } from "./spec.js";

/**
 * Load `.env` from the current directory.
 * Variables already set in the environment are left alone.
 */
export function loadEnvFile(directory: string = process.cwd()): void {
  const file = path.join(directory, ".env");
  if (!existsSync(file)) {
    return;
  }
  const text = readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) {
      continue;
    }
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parsePort(raw: string, name: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new TypeError(`Invalid ${name}: ${raw}`);
  }
  return parsed;
}

function envPort(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  return parsePort(raw, name);
}

function splitImports(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export type CliResult =
  | { action: "help"; text: string }
  | { action: "version"; text: string }
  | { action: "client"; argv: string[] }
  | { action: "init"; output: string; force: boolean }
  | { action: "check"; specPath?: string }
  | { action: "serve"; options: ServeOptions };

/** Parse argv after the program name. `--help` and `--version` print to stdout and do not start a server. */
export function parseArgv(argv: readonly string[]): CliResult {
  const head = argv[0];
  if (head === "client") {
    return { action: "client", argv: argv.slice(1) };
  }
  if (head === "init") {
    return parseInit(argv.slice(1));
  }
  if (head === "check") {
    return parseCheck(argv.slice(1));
  }
  if (argv.some((arg) => arg === "--help" || arg === "-h")) {
    return { action: "help", text: helpText() };
  }
  if (argv.some((arg) => arg === "--version" || arg === "-V")) {
    return { action: "version", text: packageVersion() };
  }
  return { action: "serve", options: parseServeArgs(argv) };
}

export async function runInit(output: string, force: boolean): Promise<void> {
  const dest = path.resolve(process.cwd(), output);
  if (existsSync(dest) && !force) {
    throw new Error(`${dest} already exists. Pass --force to overwrite it.`);
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, SPEC_TEMPLATE, "utf8");
  const shown = path.relative(process.cwd(), dest);
  process.stdout.write(`Wrote ${shown.length > 0 ? shown : dest}\n`);
}

export async function runCheck(specPath: string | undefined): Promise<void> {
  const file = specPath !== undefined && specPath.length > 0 ? path.resolve(process.cwd(), specPath) : await discoverSpecFile();
  if (file === null) {
    throw new Error(`No ${SPEC_FILENAMES[0]} in the current directory. Pass --config or run mock-engine init.`);
  }
  const spec = await loadSpecFile(file);
  const endpoints = spec.imports.length > 0 ? await loadImports(spec.imports) : [];
  process.stdout.write(`${formatSpecReport(spec, endpoints)}\n`);
}

function parseInit(argv: readonly string[]): CliResult {
  if (argv.some((arg) => arg === "--help" || arg === "-h")) {
    return { action: "help", text: helpText() };
  }
  if (argv.some((arg) => arg === "--version" || arg === "-V")) {
    return { action: "version", text: packageVersion() };
  }
  let output: string = SPEC_FILENAMES[0];
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const { name, inline } = splitFlag(argv[index] ?? "");
    if (name === "--force" || name === "-f") {
      if (inline !== undefined) {
        throw new TypeError(`${name} does not take a value`);
      }
      force = true;
      continue;
    }
    if (name === "--output" || name === "-o") {
      const taken = takeValue(argv, index, name, inline);
      output = taken.value;
      index = taken.index;
      continue;
    }
    throw new TypeError(`Unknown argument ${argv[index] ?? ""}`);
  }
  return { action: "init", output, force };
}

function parseCheck(argv: readonly string[]): CliResult {
  if (argv.some((arg) => arg === "--help" || arg === "-h")) {
    return { action: "help", text: helpText() };
  }
  if (argv.some((arg) => arg === "--version" || arg === "-V")) {
    return { action: "version", text: packageVersion() };
  }
  let specPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const { name, inline } = splitFlag(argv[index] ?? "");
    if (name === "--config" || name === "-c") {
      const taken = takeValue(argv, index, name, inline);
      specPath = taken.value;
      index = taken.index;
      continue;
    }
    throw new TypeError(`Unknown argument ${argv[index] ?? ""}`);
  }
  if (specPath === undefined) {
    const fromEnv = process.env["MOCK_CONFIG"];
    if (fromEnv !== undefined && fromEnv.length > 0) {
      specPath = fromEnv;
    }
  }
  return specPath === undefined ? { action: "check" } : { action: "check", specPath };
}

function parseServeArgs(argv: readonly string[]): ServeOptions {
  const options: ServeOptions = {};
  const imports: string[] = [];
  let sawImport = false;
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] ?? "";
    const { name, inline } = splitFlag(raw);
    if (name === "--examples") {
      if (inline !== undefined) {
        throw new TypeError("--examples does not take a value");
      }
      options.examples = true;
      continue;
    }
    if (name === "--port" || name === "--grpc-port" || name === "--host" || name === "--workspace" || name === "--import" || name === "--redis-url" || name === "--config" || name === "-c") {
      const taken = takeValue(argv, index, name, inline);
      if (name === "--port") {
        options.port = parsePort(taken.value, "PORT");
      } else if (name === "--grpc-port") {
        options.grpcPort = parsePort(taken.value, "GRPC_PORT");
      } else if (name === "--host") {
        options.host = taken.value;
      } else if (name === "--workspace") {
        options.workspace = taken.value;
      } else if (name === "--redis-url") {
        options.redisUrl = taken.value;
      } else if (name === "--config" || name === "-c") {
        options.specPath = taken.value;
      } else {
        sawImport = true;
        imports.push(taken.value);
      }
      index = taken.index;
      continue;
    }
    throw new TypeError(`Unknown argument ${raw}`);
  }
  if (options.port === undefined) {
    const port = envPort("PORT");
    if (port !== undefined) {
      options.port = port;
    }
  }
  if (options.grpcPort === undefined) {
    const port = envPort("GRPC_PORT");
    if (port !== undefined) {
      options.grpcPort = port;
    }
  }
  if (options.host === undefined && process.env["HOST"] !== undefined && process.env["HOST"].length > 0) {
    options.host = process.env["HOST"];
  }
  if (options.workspace === undefined && process.env["WORKSPACE"] !== undefined && process.env["WORKSPACE"].length > 0) {
    options.workspace = process.env["WORKSPACE"];
  }
  if (options.redisUrl === undefined && process.env["REDIS_URL"] !== undefined && process.env["REDIS_URL"].length > 0) {
    options.redisUrl = process.env["REDIS_URL"];
  }
  if (options.specPath === undefined && process.env["MOCK_CONFIG"] !== undefined && process.env["MOCK_CONFIG"].length > 0) {
    options.specPath = process.env["MOCK_CONFIG"];
  }
  const fromEnv = splitImports(process.env["MOCK_IMPORT"]);
  const importPaths = sawImport ? imports : fromEnv;
  if (importPaths.length > 0) {
    options.importPaths = importPaths;
  }
  if (options.specPath !== undefined && (options.importPaths?.length ?? 0) > 0) {
    throw new TypeError("Pass either a config file or --import, not both");
  }
  return options;
}

function splitFlag(arg: string): { name: string; inline?: string } {
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      return { name: arg.slice(0, eq), inline: arg.slice(eq + 1) };
    }
  }
  return { name: arg };
}

function takeValue(
  argv: readonly string[],
  index: number,
  name: string,
  inline: string | undefined,
): { value: string; index: number } {
  if (inline !== undefined) {
    if (inline.length === 0) {
      throw new TypeError(`Missing value for ${name}`);
    }
    return { value: inline, index };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new TypeError(`Missing value for ${name}`);
  }
  return { value: next, index: index + 1 };
}

function packageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, "..", "package.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { version: string };
  return parsed.version;
}

function helpText(): string {
  return [
    "mock-engine",
    "",
    "Start a local mock server. Memory is the store unless REDIS_URL is set.",
    `A ${SPEC_FILENAMES[0]} in the current directory replaces the built-in examples.`,
    "With no spec and no import, one example of each protocol is served under /s/default.",
    "",
    "Usage:",
    "  mock-engine [options]",
    "  mock-engine init [options]",
    "  mock-engine check [options]",
    "  mock-engine client [options] [command]",
    "",
    "Options:",
    "  -c, --config <file>   Spec file (MOCK_CONFIG). Paths inside it are relative to the file",
    `  --port <n>            HTTP port (PORT, default ${String(DEFAULT_HTTP_PORT)})`,
    `  --grpc-port <n>       Native gRPC port (GRPC_PORT, default ${String(DEFAULT_GRPC_PORT)})`,
    `  --host <host>         Bind address (HOST, default ${DEFAULT_HOST})`,
    "  --workspace <key>     Workspace key (WORKSPACE). Overrides the spec",
    "  --import <path>       Postman, OpenAPI, or HAR file or directory (repeatable)",
    "  --redis-url <url>     Redis URL (REDIS_URL). Omit it to keep the process memory store",
    "  --examples            Serve the built-in examples and ignore a spec file",
    "  -h, --help            Show this help",
    "  -V, --version         Show the version",
    "",
    `init writes ${SPEC_FILENAMES[0]} in the current directory.`,
    `  -o, --output <file>   Destination (default ${SPEC_FILENAMES[0]})`,
    "  -f, --force           Overwrite an existing file",
    "",
    "check reads a spec and prints the routes it would serve.",
    "",
    "MOCK_IMPORT accepts a comma-separated list. A --import flag replaces that list.",
    "--config and --import cannot be combined. Put those files in the spec imports list.",
    `A ${SPEC_FILENAMES[0]} in the current directory is used when --config and MOCK_CONFIG are unset.`,
    `If both ${SPEC_FILENAMES[0]} and ${SPEC_FILENAMES[1]} exist, startup fails.`,
    "--examples ignores a spec file and serves the built-in examples.",
    "",
    "A terminal shows the mocks being served and a live request log.",
    "j and k scroll the mock list. q quits.",
    "",
    "In another terminal, mock-engine client edits this server.",
  ].join("\n");
}

async function main(): Promise<void> {
  loadEnvFile();
  const result = parseArgv(process.argv.slice(2));
  if (result.action === "help" || result.action === "version") {
    process.stdout.write(`${result.text}\n`);
    return;
  }
  if (result.action === "client") {
    await runClient(result.argv);
    return;
  }
  if (result.action === "init") {
    await runInit(result.output, result.force);
    return;
  }
  if (result.action === "check") {
    await runCheck(result.specPath);
    return;
  }
  const options = result.options;
  const interactive = process.stdout.isTTY === true && process.env["MOCK_PLAIN"] !== "1";
  const events: TrafficEvent[] = [];
  let totalRequests = 0;
  let draw = (): void => undefined;
  const running = await serve({
    ...options,
    onTraffic(event) {
      totalRequests += 1;
      if (!interactive) {
        process.stdout.write(`${formatTrafficLine(event)}\n`);
        return;
      }
      events.push(event);
      if (events.length > 400) {
        events.shift();
      }
      draw();
    },
  });
  const startedAt = Date.now();
  let restore = (): void => undefined;
  if (interactive) {
    restore = startScreen(running, events, () => totalRequests, startedAt, (next) => {
      draw = next;
    });
    draw();
  } else {
    process.stdout.write(`${plainFrame(running, startedAt)}\n`);
  }
  let closed = false;
  const shutdown = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    restore();
    void running.close().then(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function plainFrame(running: RunningServer, startedAt: number): string {
  return renderScreen(screenModel(running, [], 0, 0, startedAt), 100, 12 + running.mocks.length, false);
}

function startScreen(
  running: RunningServer,
  events: TrafficEvent[],
  totalRequests: () => number,
  startedAt: number,
  bind: (draw: () => void) => void,
): () => void {
  let offset = 0;
  let restored = false;
  const color = process.env["NO_COLOR"] === undefined;
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const draw = (): void => {
    const columns = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const frame = renderScreen(screenModel(running, events, offset, totalRequests(), startedAt), columns, rows, color);
    process.stdout.write(`\x1b[H\x1b[J${frame}`);
  };
  bind(draw);
  const timer = setInterval(() => {
    void running.reload().finally(draw);
  }, 1000);
  const onResize = (): void => {
    draw();
  };
  process.stdout.on("resize", onResize);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk: Buffer) => {
      const key = chunk.toString("utf8");
      if (key === "q" || key === "\u0003") {
        process.emit("SIGINT");
        return;
      }
      if (key === "j" || key === "\u001b[B") {
        offset += 1;
      } else if (key === "k" || key === "\u001b[A") {
        offset = Math.max(0, offset - 1);
      } else {
        return;
      }
      draw();
    });
  }
  return () => {
    if (restored) {
      return;
    }
    restored = true;
    clearInterval(timer);
    process.stdout.off("resize", onResize);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  };
}

function screenModel(
  running: RunningServer,
  events: readonly TrafficEvent[],
  mockOffset: number,
  totalRequests: number,
  startedAt: number,
): Parameters<typeof renderScreen>[0] {
  return {
    storeKind: running.storeKind,
    httpUrl: `http://${running.host}:${String(running.port)}${running.basePath}/${running.workspace}`,
    grpcUrl: `${running.host}:${String(running.grpcPort)}`,
    grpcServices: running.grpcServices,
    startedAt,
    now: Date.now(),
    mocks: running.mocks,
    mockOffset,
    events,
    totalRequests,
    hint: "client: mock-engine client",
  };
}

const entry = process.argv[1];
if (entry !== undefined && sameFile(entry, fileURLToPath(import.meta.url))) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Mock engine failed to start";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}
