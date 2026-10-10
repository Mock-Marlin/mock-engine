# Setup

The package is a Fastify plugin and a small local server. Documents live in memory unless you pass a store or set `REDIS_URL`.

## Requirements

- Node.js 24 or newer
- Fastify 5, when you embed the plugin
- `@fastify/websocket` registered on the same app, when you embed the plugin

Redis is optional. Install `ioredis` only when a store should be Redis.

```bash
npm install @mockmarlin/mock-engine fastify @fastify/websocket
```

## Run the local server

`mock-engine` loads `.env` from the current directory without overriding variables that are already set, then applies flags. The example file is [`.env.example`](../.env.example). Install the command with `npm install`, `npm run build`, and `npm install -g .` from this package, then run it from any directory.

```bash
mock-engine init
mock-engine
```

In a terminal the process draws the mocks it is serving and a request log. `j` and `k` scroll the mock list. `q` quits. Redirected output prints the same list once, then one line per request.

The client is a second command, run while that server is up:

```bash
mock-engine client
```

`add` and `edit` open `$EDITOR` on a YAML buffer. Quitting the editor writes the mock into the server's memory, or into Redis when `REDIS_URL` is set. The buffer file is deleted. `import` takes a Postman collection, an OpenAPI file, or a HAR file. Paths that already exist are shown so you can replace them, skip them, or cancel. `new` and `use` create and switch workspaces.

| Variable | Flag | Default |
|---|---|---|
| `PORT` | `--port` | `4080` |
| `GRPC_PORT` | `--grpc-port` | `50052` |
| `HOST` | `--host` | `127.0.0.1` |
| `WORKSPACE` | `--workspace` | spec workspace, then `default` |
| `MOCK_CONFIG` | `--config`, `-c` | `./mock-engine.yaml` when that file is present |
| `MOCK_IMPORT` | `--import` | none |
| `REDIS_URL` | `--redis-url` | in-memory store |

HTTP serves REST, SSE, chunked responses, WebSocket, GraphQL, MCP, and gRPC-Web. Native unary gRPC uses `GRPC_PORT`.

A spec file replaces the built-in examples. `--config` and `MOCK_CONFIG` name it. When neither is set, `./mock-engine.yaml` or `./mock-engine.yml` is used. Both names at once is an error. `mock-engine init` writes a starter. `mock-engine check` prints the routes and exits. The field guide is [spec.md](spec.md).

`--examples` ignores a spec file and seeds one example of each protocol. The REST example is `GET /s/default/hello`. The others are SSE `/events`, WebSocket `/ws`, chunked `/chunked`, GraphQL `/graphql`, MCP, and a unary `demo.Greeter/SayHello` on the gRPC port.

`--config` and `--import` cannot be combined. Postman, OpenAPI, and HAR paths go in the spec's `imports` list. A flag list of `--import` replaces `MOCK_IMPORT` when no spec is in use. Those files clear the workspace and write only the parsed REST mocks. The gRPC port still listens and logs that it has no services when no proto was stored.

Postman responses come from the first saved example on the request. OpenAPI 3 uses the first `2xx` or `default` response, preferring `example` / `examples`, then a schema sample. HAR uses the recorded status, headers, and body. Paths such as `/users/:id` match a concrete URL because the local server turns on `matchParams`.

Set `REDIS_URL` to use Redis. `ioredis` must be installed. A missing package or an unreachable server fails startup with a message that says which one.

`serve()` starts the same process from code:

```ts
import { serve } from "@mockmarlin/mock-engine";

const running = await serve({ specPath: "./mock-engine.yaml" });
console.log(running.source, running.port, running.imported);
await running.close();
```

`importPaths` still replaces the examples when you are not using a spec. Pass `examples: true` to seed the built-in set. Pass `store` to use a store you already opened. That wins over `redisUrl`.

## Register both pieces

WebSocket upgrades are decided before the route handler runs. `mockEngineWebsocketOptions` must see the same store, workspace resolver, base path, key names, TTLs, and protocol switches as `mockEngine`.

```ts
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { createMemoryStore, mockEngine, mockEngineWebsocketOptions } from "@mockmarlin/mock-engine";

const store = createMemoryStore();

const engine = {
  store,
  resolveWorkspaceId: async (workspaceKey: string) => {
    return workspaceKey === "demo" ? "workspace-demo" : null;
  },
};

const app = Fastify();
await app.register(websocket, { options: mockEngineWebsocketOptions(engine) });
await app.register(mockEngine, engine);
await app.listen({ port: 3000, host: "127.0.0.1" });
```

With no other options the public URL is `/s/{workspaceKey}/{route}` and keys start with `mockmarlin:`.

Redis, when you want it:

```ts
import { openRedisStore } from "@mockmarlin/mock-engine/redis";

const opened = await openRedisStore(process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379");
const store = opened.store;
```

## Write one REST mock

`createKeyLayout()` returns the same key functions the plugin uses, including your prefix when you pass one.

```ts
import { createKeyLayout } from "@mockmarlin/mock-engine";

const keys = createKeyLayout();
const workspaceId = "workspace-demo";

await store.set(keys.route(workspaceId, "GET", "/hello"), "hello-1");
await store.set(
  keys.mock("hello-1"),
  JSON.stringify({
    statusCode: 200,
    headers: { "x-mock": "1" },
    payload: {
      type: "json",
      storage: "inline",
      body: JSON.stringify({ ok: true }),
    },
  }),
);
```

`GET /s/demo/hello` resolves `demo` to `workspace-demo`, reads the route key, then reads the mock document, and sends the payload.

The route key stores an id. The mock key stores the response. See [redis.md](redis.md) for the other protocols. The same JSON is used in memory and in Redis.

## The options most apps change

```ts
const engine = {
  store,
  resolveWorkspaceId,
  basePath: "/mocks",
  keyPrefix: "widgets",
  ttl: { route: 60 * 60, mock: 60 * 60 },
  protocols: { grpc: false },
};
```

| Option | Default | Effect |
|---|---|---|
| `basePath` | `/s` | Public prefix. Workspaces live at `{basePath}/{workspaceKey}/...`. |
| `keyPrefix` | `mockmarlin` | First segment of every store key. |
| `keys` | layout from `keyPrefix` | Replaces key names completely. `keyPrefix` is then ignored. |
| `ttl` | none | After a successful read, `EXPIRE` that key. Omitted kinds are not touched. Leave `ttl` unset so a key written without an expiry stays until it is deleted. |
| `protocols` | all on | Set a protocol to `false` to skip it. |

Details, including the callbacks, are in [configuration.md](configuration.md).

## Check that it is wired

- Unknown workspace key: 404, and the store is not queried.
- Known workspace, missing route: 404 `{ error: "Not Found", message }`.
- The store throws: 503 `{ error: "Service Unavailable", message: "Mock store is unreachable" }`.
- `OPTIONS` any mounted URL: 204, before the workspace lookup.
- Responses include permissive CORS headers (`Access-Control-Allow-Origin: *`).
