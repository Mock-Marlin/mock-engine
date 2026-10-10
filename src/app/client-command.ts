/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { ClashPolicy } from "./admin.js";
import { describeRef, type MockKind, type MockRef } from "./draft.js";

export type ClientCommand =
  | { type: "help" }
  | { type: "quit" }
  | { type: "workspaces" }
  | { type: "mocks" }
  | { type: "use"; name: string }
  | { type: "new"; name: string }
  | { type: "remove-workspace"; name: string }
  | { type: "add" }
  | { type: "edit"; ref: MockRef }
  | { type: "remove"; ref: MockRef }
  | { type: "import"; file: string; clash?: ClashPolicy };

const POLICIES = new Set<ClashPolicy>(["reject", "replace", "skip"]);

export function parseClientLine(line: string): ClientCommand {
  const tokens = tokenize(line);
  const head = tokens[0]?.toLowerCase() ?? "";
  if (head.length === 0) {
    throw new Error("Type help to see commands");
  }
  if (head === "help" || head === "?") {
    return { type: "help" };
  }
  if (head === "quit" || head === "exit") {
    return { type: "quit" };
  }
  if (head === "workspaces" || head === "ws") {
    return { type: "workspaces" };
  }
  if (head === "mocks" || head === "ls" || head === "list") {
    return { type: "mocks" };
  }
  if (head === "use") {
    return { type: "use", name: required(tokens[1], "workspace name") };
  }
  if (head === "new") {
    return { type: "new", name: required(tokens[1], "workspace name") };
  }
  if ((head === "rm" || head === "remove" || head === "delete") && tokens[1]?.toLowerCase() === "workspace") {
    return { type: "remove-workspace", name: required(tokens[2], "workspace name") };
  }
  if (head === "add" || head === "new-mock") {
    return { type: "add" };
  }
  if (head === "edit") {
    return { type: "edit", ref: parseMockSpec(tokens.slice(1).join(" ")) };
  }
  if (head === "rm" || head === "remove" || head === "delete") {
    return { type: "remove", ref: parseMockSpec(tokens.slice(1).join(" ")) };
  }
  if (head === "import") {
    const file = required(tokens[1], "a file or directory");
    const clash = flag(tokens, "--clash");
    if (clash !== undefined && !isPolicy(clash)) {
      throw new Error("--clash must be replace, skip, or reject");
    }
    if (clash === undefined) {
      return { type: "import", file };
    }
    return { type: "import", file, clash };
  }
  throw new Error(`Unknown command ${head}. Type help.`);
}

export function parseMockSpec(input: string): MockRef {
  const tokens = tokenize(input);
  const first = tokens[0];
  if (first === undefined) {
    throw new Error("Say which mock, for example: GET /hello");
  }
  const kind = first.toLowerCase();
  if (kind === "mcp") {
    return { kind: "mcp", method: "POST", path: "/mcp", service: "", rpc: "" };
  }
  if (kind === "grpc") {
    const name = required(tokens[1], "service/rpc, for example demo.Greeter/SayHello");
    const slash = name.lastIndexOf("/");
    if (slash <= 0 || slash === name.length - 1) {
      throw new Error("gRPC mocks look like demo.Greeter/SayHello");
    }
    return {
      kind: "grpc",
      method: "RPC",
      path: name,
      service: name.slice(0, slash),
      rpc: name.slice(slash + 1),
    };
  }
  if (kind === "sse" || kind === "websocket" || kind === "chunked" || kind === "graphql") {
    return {
      kind,
      method: kind === "graphql" ? "POST" : "GET",
      path: route(required(tokens[1], "a path")),
      service: "",
      rpc: "",
    };
  }
  const method = first.toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) {
    throw new Error("Use a method and path, such as GET /hello");
  }
  return { kind: "rest", method, path: route(required(tokens[1], "a path")), service: "", rpc: "" };
}

export function commandHelp(): string {
  return [
    "workspaces              list workspaces",
    "use <name>              switch workspace",
    "new <name>              create an empty workspace",
    "rm workspace <name>     delete a workspace and its mocks",
    "mocks                   list mocks in this workspace",
    "add                     create a mock in your editor",
    "edit GET /hello         change a mock in your editor",
    "rm GET /hello           delete one mock",
    "import <file>           Postman, OpenAPI, or HAR",
    "help                    show this list",
    "quit                    leave the client",
    "",
    "edit also accepts sse, websocket, chunked, graphql, mcp, and grpc.",
    "Example: edit grpc demo.Greeter/SayHello",
    "When a path already exists you can replace it, skip it, or cancel.",
  ].join("\n");
}

export function refLabel(ref: MockRef): string {
  return describeRef(ref);
}

function route(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function flag(tokens: readonly string[], name: string): string | undefined {
  const index = tokens.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  return tokens[index + 1];
}

function isPolicy(value: string): value is ClashPolicy {
  return POLICIES.has(value as ClashPolicy);
}

function tokenize(line: string): string[] {
  return line.trim().split(/\s+/).filter((part) => part.length > 0);
}

export function isMockKind(value: string): value is MockKind {
  return value === "rest" || value === "sse" || value === "websocket" || value === "chunked" || value === "graphql" || value === "mcp" || value === "grpc";
}
