# Public API

Import these from `@mockmarlin/mock-engine`.

## `mockEngine`

Fastify plugin, wrapped with `fastify-plugin` under the name `mock-engine`. It declares `fastify: "5.x"`.

```ts
await app.register(mockEngine, options);
```

`options` is `MockEngineOptions`. `resolveWorkspaceId` is always required. Redis mode also requires `redis`. Memory mode (`mode: "memory"`) requires `data` instead, and does not take a Redis client. Omit `mode` and the plugin uses Redis. Every other field has a default described in [configuration.md](configuration.md).

On register, the plugin opens a scoped router at `basePath` and installs three content-type parsers on that scope:

- `*` parsed as a string, so unknown bodies stay text
- `application/graphql` parsed as a string
- `application/grpc` and `application/grpc+...` parsed as a buffer

An `onRequest` hook sets permissive CORS on every response in the scope. Routes are registered for `/:workspaceId` and `/:workspaceId/*`.

## `mockEngineWebsocketOptions(options)`

Returns the `verifyClient` and `handleProtocols` object that `@fastify/websocket` expects.

```ts
await app.register(websocket, {
  options: mockEngineWebsocketOptions(options),
});
```

`options` is `MockEngineSharedOptions`: `mode`, `redis` or `data`, `resolveWorkspaceId`, and the optional `basePath`, `keyPrefix`, `keys`, `ttl`, and `protocols`. Pass the same store the plugin uses. Callbacks such as `resolvePayloadOverride` are not read here.

`verifyClient` allows the upgrade unless a WebSocket stream document lists subprotocols and the client offered none of them. That rejection is HTTP 400 with `WebSocket subprotocol not accepted`. A store error during the handshake still allows the upgrade; the socket handler then closes it. Memory mode does not throw on a missing key.

`handleProtocols` returns the subprotocol chosen during `verifyClient`, or `false` when the client did not offer it.

## `resolveEngineConfig(options)`

Pure function. Fills defaults and returns `ResolvedEngineConfig`:

| Field | Contents |
|---|---|
| `basePath` | Normalized prefix, always starting with `/`. |
| `keys` | The `KeyLayout` that will be called. Custom `keys` win over `keyPrefix`. |
| `protocols` | All five booleans, with omitted ones set to `true`. |
| `ttl` | The `ttl` object you passed, or `{}`. |

Call this from the process that writes documents so it uses the same names as the plugin.

## `createKeyLayout(prefix?)`

Returns a `KeyLayout`. `prefix` defaults to `mockmarlin`. See [configuration.md](configuration.md) for the string shape.

## Key helpers

Each helper calls the default layout unless you pass a prefix as the last argument.

| Function | Arguments | Default key |
|---|---|---|
| `routeKey` | `workspaceId, method, path, prefix?` | `mockmarlin:route:{workspaceId}:{method}:{path}` |
| `mockKey` | `id, prefix?` | `mockmarlin:mock:{id}` |
| `streamKey` | `workspaceId, path, prefix?` | `mockmarlin:stream:{workspaceId}:{path}` |
| `graphqlKey` | `workspaceId, path, prefix?` | `mockmarlin:graphql:{workspaceId}:{path}` |
| `mcpKey` | `workspaceId, prefix?` | `mockmarlin:mcp:{workspaceId}` |
| `grpcHotKey` | `workspaceId, service, method, prefix?` | `mockmarlin:grpc:{workspaceId}:{service}:{method}` |
| `grpcSchemaKey` | `workspaceId, prefix?` | `mockmarlin:grpc-schema:{workspaceId}` |

`DEFAULT_KEY_PREFIX` is the string `"mockmarlin"`.

## Types

| Export | Role |
|---|---|
| `MockEngineOptions` | Full plugin options. |
| `MockEngineSharedOptions` | The subset the WebSocket handshake reads. |
| `ResolvedEngineConfig` | Defaults filled in by `resolveEngineConfig`. |
| `KeyLayout` | The seven key functions. |
| `ProtocolSwitches` | `rest`, `stream`, `graphql`, `mcp`, `grpc`. |
| `KeyTtlSeconds` | Optional seconds per key kind. |
| `RequestContext` | One resolved request. |
| `ResolvedMockResponse` | What `resolvePayloadOverride` may return. |
| `RuleDatasetResolver` | The `resolvePayloadOverride` function type. |
| `InspectorLog` | What `onInspectorLog` receives. |
| `EngineSocket` | The WebSocket surface the stream and GraphQL handlers call: `send`, `ping`, `close`, `terminate`, and `on` for `message`, `close`, and `error`. |
