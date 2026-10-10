# @mockmarlin/mock-engine

Serves mock REST, SSE, chunked HTTP, WebSocket, GraphQL, MCP, and gRPC. Use it as a command locally, or as a Fastify plugin inside another app.

The plugin reads documents from a store. Your app writes them. It does not evaluate rules or open a database.

The store is in memory unless you pass one. Redis is optional.

Requires Node.js 24 or newer.

## Install

From this package, build it and put the `mock-engine` command on your `PATH`:

```bash
npm install
npm run build
npm install -g .
```

`npm run install-cli` runs those last two steps. After that, `mock-engine` works from any directory. Node.js 24 or newer is the only runtime requirement. Remove it with `npm uninstall -g @mockmarlin/mock-engine`.

## Declare the routes

![Writing a spec, checking it, and requesting the route](docs/usage.gif)

```bash
mock-engine init
mock-engine check
mock-engine
```

`init` writes `mock-engine.yaml` in the current directory. `check` prints the routes and exits. `mock-engine` serves that file instead of the built-in examples. The starter route is `GET http://127.0.0.1:4080/s/default/health`.

A spec in the current directory is picked up on its own. Point at another file with `--config`. Paths inside the file are relative to the file, so this works from any directory:

```bash
mock-engine --config ~/proj/mock-engine.yaml
```

The field guide is [docs/spec.md](docs/spec.md). A sample with every protocol is [examples/mock-engine.yaml](examples/mock-engine.yaml). `--examples` ignores a spec and serves one example of each protocol under `/s/default`. Nothing is written to disk. Memory goes away when the process exits.

A terminal shows the mocks and a live request log. `j` and `k` scroll the list. `q` quits.

## Change it from a second terminal

Leave the server running and open the client:

```bash
mock-engine client
```

Both are command-line programs. The client talks to the server you already started. `add` and `edit` open `EDITOR` (or nano) on a short YAML buffer. When you save and quit the editor, that file is deleted and the mock is stored in the server, in memory or Redis. `import ./collection.json` reads a Postman collection, OpenAPI spec, or HAR file.

```text
default> mocks
default> add
default> edit GET /health
default> import ./petstore.yaml
default> new billing
default> use billing
```

If a path is already served, the client asks you to replace it, skip it, or cancel. `rm workspace billing` deletes that workspace after you type its name. New workspaces are served immediately at `/s/<name>/...`. Native gRPC stays on the workspace the server was started with.

A `.env` file in the current directory is loaded first. Variables already set in the environment are left alone. Flags override both.

| Variable | Flag | Default |
|---|---|---|
| `PORT` | `--port` | `4080` |
| `GRPC_PORT` | `--grpc-port` | `50052` |
| `HOST` | `--host` | `127.0.0.1` |
| `WORKSPACE` | `--workspace` | spec workspace, then `default` |
| `MOCK_CONFIG` | `--config`, `-c` | `./mock-engine.yaml` when that file is present |
| `MOCK_IMPORT` | `--import` | none |
| `REDIS_URL` | `--redis-url` | memory |

`--help` and `--version` print to stdout and exit. `--config` and `--import` cannot be combined. Put Postman, OpenAPI, and HAR files in the spec's `imports` list. `MOCK_IMPORT` is one path or a comma-separated list, used when no spec is loaded. `--import` can be repeated and replaces that list.

```bash
mock-engine --config ./mock-engine.yaml --port 4080
```

Postman uses the first saved example on each request. OpenAPI 3 uses the first `2xx` or `default` response, preferring `example` / `examples` and otherwise a schema sample. HAR uses the recorded response. Parameterized paths such as `/users/:id` match `GET /s/default/users/123`.

Set `REDIS_URL` to store documents in Redis instead of memory. That needs the optional `ioredis` peer. If it is missing, startup says so and exits.

```env
PORT=4080
GRPC_PORT=50052
WORKSPACE=default
MOCK_CONFIG=./mock-engine.yaml
```

The same process is `serve()` for library callers. See [docs/setup.md](docs/setup.md).

## Use it as a plugin

```bash
npm install @mockmarlin/mock-engine fastify @fastify/websocket
```

`fastify` must be 5.x. Register `@fastify/websocket` before the plugin, and pass the same store and the same workspace resolver to both.

```ts
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { createKeyLayout, createMemoryStore, mockEngine, mockEngineWebsocketOptions } from "@mockmarlin/mock-engine";

const store = createMemoryStore();

async function resolveWorkspaceId(workspaceKey: string): Promise<string | null> {
  return workspaceKey === "demo" ? "demo" : null;
}

const engine = {
  store,
  resolveWorkspaceId,
  basePath: "/s",
};

const app = Fastify();
await app.register(websocket, { options: mockEngineWebsocketOptions(engine) });
await app.register(mockEngine, engine);

const keys = createKeyLayout();
await store.set(keys.route("demo", "GET", "/hello"), "hello-1");
await store.set(
  keys.mock("hello-1"),
  JSON.stringify({
    statusCode: 200,
    payload: {
      type: "json",
      storage: "inline",
      body: JSON.stringify({ ok: true }),
    },
  }),
);

await app.listen({ port: 3000 });
```

`GET http://127.0.0.1:3000/s/demo/hello` returns `{ "ok": true }`.

`resolveWorkspaceId` turns the first path segment (`demo`) into the id stored with the documents. Return `null` for an unknown workspace and the plugin responds with 404 without reading the store.

Change the public URL with `basePath`. Change key names with `keyPrefix` or `keys`. Refresh expiry on read with `ttl`. Turn protocols off with `protocols`. Set `matchParams` to match `/users/:id` after an exact miss. Omit any of them and the defaults stay: prefix `mockmarlin`, base path `/s`, no TTL refresh, every protocol on, exact paths only.

To keep documents in Redis, install `ioredis` and open a client:

```ts
import { openRedisStore } from "@mockmarlin/mock-engine/redis";

const redis = await openRedisStore("redis://127.0.0.1:6379");
const engine = { store: redis.store, resolveWorkspaceId };
```

`openRedisStore` is also exported from the main entry. An existing `ioredis` client can be passed as `store` when it has `get`, `set`, `expire`, and `del`.

## What to read next

| Guide | What it covers |
|---|---|
| [docs/spec.md](docs/spec.md) | The `mock-engine.yaml` file: every kind, protos, imports, and startup order |
| [docs/setup.md](docs/setup.md) | The local server, the plugin, and the options most apps set |
| [docs/configuration.md](docs/configuration.md) | Every option: store, URLs, keys, TTLs, protocols, callbacks |
| [docs/api.md](docs/api.md) | Each export, what the caller passes, and what it returns |
| [docs/redis.md](docs/redis.md) | Key names and the JSON each protocol expects |
| [docs/internals.md](docs/internals.md) | How a request is dispatched and what each handler does |

## Scripts

```bash
npm test
npm run lint
npm run build
```

`npm test` runs Vitest against a real Fastify app and `ioredis-mock`. `npm run lint` typechecks the source and the tests. `npm run build` emits `dist/` with declarations.

## Contributing

The layout, the test commands, and how a change should be structured are in [CONTRIBUTING.md](CONTRIBUTING.md). This package is MIT licensed. See [LICENSE](LICENSE).
