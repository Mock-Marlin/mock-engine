# Setup

The plugin is a Fastify route scope. You tell it which URL segment is which workspace, and you give it the mock documents either as a static map or in Redis.

## Requirements

- Node.js 24 or newer
- Fastify 5
- `@fastify/websocket` registered on the same app
- Redis mode: a Redis server, and an `ioredis` client you create yourself
- Memory mode: no Redis client

## Memory mode

```bash
npm install @mockmarlin/mock-engine fastify @fastify/websocket
```

`data` uses the same key strings as Redis. The map is copied when the plugin and the WebSocket handshake open.

```ts
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { createKeyLayout, mockEngine, mockEngineWebsocketOptions } from "@mockmarlin/mock-engine";

const keys = createKeyLayout();
const workspaceId = "workspace-demo";

const engine = {
  mode: "memory" as const,
  data: {
    [keys.route(workspaceId, "GET", "/hello")]: "hello-1",
    [keys.mock("hello-1")]: JSON.stringify({
      statusCode: 200,
      delayMs: 40,
      fault: "none",
      payload: {
        type: "json",
        storage: "inline",
        body: JSON.stringify({ ok: true }),
      },
    }),
  },
  resolveWorkspaceId: async (workspaceKey: string) => {
    return workspaceKey === "demo" ? workspaceId : null;
  },
};

const app = Fastify();
await app.register(websocket, { options: mockEngineWebsocketOptions(engine) });
await app.register(mockEngine, engine);
await app.listen({ port: 3000, host: "127.0.0.1" });
```

`GET /s/demo/hello` waits 40ms and returns `{ "ok": true }`.

## Redis mode

```bash
npm install @mockmarlin/mock-engine fastify @fastify/websocket ioredis
```

WebSocket upgrades are decided before the route handler runs. `mockEngineWebsocketOptions` must see the same Redis client, workspace resolver, base path, key names, TTLs, and protocol switches as `mockEngine`.

```ts
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import Redis from "ioredis";
import { mockEngine, mockEngineWebsocketOptions } from "@mockmarlin/mock-engine";

const redis = new Redis(process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379");

const engine = {
  redis,
  resolveWorkspaceId: async (workspaceKey: string) => {
    return workspaceKey === "demo" ? "workspace-demo" : null;
  },
};

const app = Fastify();
await app.register(websocket, { options: mockEngineWebsocketOptions(engine) });
await app.register(mockEngine, engine);
await app.listen({ port: 3000, host: "127.0.0.1" });
```

With no other options the public URL is `/s/{workspaceKey}/{route}` and Redis keys start with `mockmarlin:`.

## Write one REST mock

`createKeyLayout()` returns the same key functions the plugin uses, including your prefix when you pass one.

```ts
import { createKeyLayout } from "@mockmarlin/mock-engine";

const keys = createKeyLayout();
const workspaceId = "workspace-demo";

await redis.set(keys.route(workspaceId, "GET", "/hello"), "hello-1");
await redis.set(
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

The route key stores an id. The mock key stores the response. See [redis.md](redis.md) for the other protocols.

## The options most apps change

```ts
const engine = {
  redis,
  resolveWorkspaceId,
  basePath: "/mocks",
  keyPrefix: "widgets",
  ttl: { route: 60 * 60, mock: 60 * 60 },
  protocols: { grpc: false },
};
```

| Option | Default | Effect |
|---|---|---|
| `mode` | `redis` | `memory` serves `data` and does not use Redis. |
| `data` | none | Required string map in memory mode. Copied at startup. |
| `basePath` | `/s` | Public prefix. Workspaces live at `{basePath}/{workspaceKey}/...`. |
| `keyPrefix` | `mockmarlin` | First segment of every document key. |
| `keys` | layout from `keyPrefix` | Replaces key names completely. `keyPrefix` is then ignored. |
| `ttl` | none | Redis only. After a successful read, `EXPIRE` that key. Omitted kinds are not touched. Memory mode ignores `ttl`. |
| `protocols` | all on | Set a protocol to `false` to skip it. |

Details, including the callbacks, are in [configuration.md](configuration.md).

## Check that it is wired

- Unknown workspace key: 404, and the document store is not queried.
- Known workspace, missing route: 404 `{ error: "Not Found", message }`.
- The store throws: 503 `{ error: "Service Unavailable", message: "Mock store is unreachable" }`. Memory reads do not throw.
- `OPTIONS` any mounted URL: 204, before the workspace lookup.
- Responses include permissive CORS headers (`Access-Control-Allow-Origin: *`).
