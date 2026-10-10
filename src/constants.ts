/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

/** HTTP port used when `PORT` and `--port` are omitted. */
export const DEFAULT_HTTP_PORT = 4080;

/** Native gRPC port used when `GRPC_PORT` and `--grpc-port` are omitted. */
export const DEFAULT_GRPC_PORT = 50052;

/** Bind address used when `HOST` and `--host` are omitted. */
export const DEFAULT_HOST = "127.0.0.1";

/** Workspace key used when the spec and `--workspace` omit one. */
export const DEFAULT_WORKSPACE = "default";

/** Redis key namespace used when `keyPrefix` is omitted. */
export const DEFAULT_KEY_PREFIX = "mockmarlin";

/** Workspace keys accepted by the spec and the admin client. */
export const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Proto file names accepted in a spec `protos` entry. */
export const PROTO_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.proto$/;

/** Spec names discovered in the current directory. Both at once is an error. */
export const SPEC_FILENAMES = ["mock-engine.yaml", "mock-engine.yml"] as const;

/** Extensions collected from an import directory. */
export const IMPORT_FILE_PATTERN = /\.(json|ya?ml|har)$/i;

/** Starter written by `mock-engine init`. One health route, so a new file runs on its own. */
export const SPEC_TEMPLATE = `# This file replaces the built-in examples when you run mock-engine here.
# Routes are served at http://${DEFAULT_HOST}:${String(DEFAULT_HTTP_PORT)}/s/<workspace>/<path>
# kind can be rest, sse, websocket, chunked, graphql, mcp, or grpc.
version: 1
workspace: ${DEFAULT_WORKSPACE}

mocks:
  - kind: rest
    method: GET
    path: /health
    status: 200
    body:
      ok: true
`;

/** YAML buffer opened by `mock-engine client` when adding a mock. */
export const BLANK_DRAFT = `# This buffer is deleted when the editor closes.
# The mock is saved in the running engine, in memory or Redis.
kind: rest
method: GET
path: /example
status: 200
delayMs: 0
headers: {}
body:
  ok: true
`;
