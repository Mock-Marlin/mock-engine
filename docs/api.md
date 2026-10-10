# Public API

Import these from `@mockmarlin/mock-engine`.

## `mockEngine`

Fastify plugin, wrapped with `fastify-plugin` under the name `mock-engine`. It declares `fastify: "5.x"`.

```ts
await app.register(mockEngine, options);
```

`options` is `MockEngineOptions`. `store` and `resolveWorkspaceId` are required. Everything else has a default described in [configuration.md](configuration.md).

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

`options` is `MockEngineSharedOptions`: `store`, `resolveWorkspaceId`, and the optional `basePath`, `keyPrefix`, `keys`, `ttl`, and `protocols`. Callbacks such as `resolvePayloadOverride` are not read here. `matchParams` is read by the HTTP router, not by this handshake.

`verifyClient` allows the upgrade unless a WebSocket stream document lists subprotocols and the client offered none of them. That rejection is HTTP 400 with `WebSocket subprotocol not accepted`. A store error during the handshake still allows the upgrade; the socket handler then closes it.

`handleProtocols` returns the subprotocol chosen during `verifyClient`, or `false` when the client did not offer it.

## `resolveEngineConfig(options)`

Pure function. Fills defaults and returns `ResolvedEngineConfig`:

| Field | Contents |
|---|---|
| `basePath` | Normalized prefix, always starting with `/`. |
| `keys` | The `KeyLayout` that will be called. Custom `keys` win over `keyPrefix`. |
| `protocols` | All five booleans, with omitted ones set to `true`. |
| `ttl` | The `ttl` object you passed, or `{}`. |
| `matchParams` | `true` only when you passed `matchParams: true`. |

Call this from the process that writes the store so it uses the same names as the plugin.

## `createKeyLayout(prefix?)`

Returns a `KeyLayout`. `prefix` defaults to `mockmarlin`. See [configuration.md](configuration.md) for the string shape.

## Key helpers

Each helper calls the default layout unless you pass a prefix as the last argument.

| Function | Arguments | Default key |
|---|---|---|
| `routeKey` | `workspaceId, method, path, prefix?` | `mockmarlin:route:{workspaceId}:{method}:{path}` |
| `routeIndexKey` | `workspaceId, prefix?` | `mockmarlin:route-index:{workspaceId}` |
| `mockKey` | `id, prefix?` | `mockmarlin:mock:{id}` |
| `streamKey` | `workspaceId, path, prefix?` | `mockmarlin:stream:{workspaceId}:{path}` |
| `graphqlKey` | `workspaceId, path, prefix?` | `mockmarlin:graphql:{workspaceId}:{path}` |
| `mcpKey` | `workspaceId, prefix?` | `mockmarlin:mcp:{workspaceId}` |
| `grpcHotKey` | `workspaceId, service, method, prefix?` | `mockmarlin:grpc:{workspaceId}:{service}:{method}` |
| `grpcSchemaKey` | `workspaceId, prefix?` | `mockmarlin:grpc-schema:{workspaceId}` |

`DEFAULT_KEY_PREFIX` is the string `"mockmarlin"`.

## Local server

`serve(options?)` starts Fastify and a native unary gRPC server. Memory is the store unless `store` is passed or `redisUrl` is set. Startup routes come from one source, in this order: `examples: true`, then `specPath`, then `mock-engine.yaml` in the current directory, then `importPaths`, then the built-in examples. It returns `RunningServer`: `host`, `port`, `grpcPort`, `workspace`, `basePath`, `storeKind` (`"memory"` or `"redis"`), `source` (`"examples"`, `"import"`, or `"spec"`), `imported` (`null` for examples, otherwise the number of routes written), `grpcServices`, `mocks` (the routes loaded at startup), and `close()`. Pass `onTraffic` to hear each HTTP response and native gRPC call. `reload()` reads the startup workspace again after edits. The local server also answers `/_admin` so `mock-engine client` can create workspaces, edit mocks, and import files.

`SpecError` is thrown when a spec file is missing or invalid. The message includes the file path and the field. The file format is [spec.md](spec.md).

`seedExamples(store, workspaceId, keys?)` writes that example set. `clearWorkspace(store, workspaceId, keys?)` deletes the workspace keys it can list. The store needs `list` for a clear.

Defaults: HTTP `4080`, gRPC `50052`, host `127.0.0.1`, workspace `default`. Those values are `DEFAULT_HTTP_PORT`, `DEFAULT_GRPC_PORT`, `DEFAULT_HOST`, and `DEFAULT_WORKSPACE`.

## Import

| Function | Role |
|---|---|
| `parseImportFile(name, bytes)` | Sniffs Postman, OpenAPI, or HAR and returns `ImportedEndpoint[]`. |
| `parsePostman` | Postman collection. The first saved example is the response. |
| `parseOpenAPI` | OpenAPI 3. The first `2xx` or `default` response. |
| `parseHAR` | Recorded status, headers, and body. |
| `writeImportedRestMocks(store, workspaceId, endpoints, keys?)` | Dedupes method plus path, strips query strings, replaces that workspace’s REST mocks, and writes the route index. |

`ImportParseError` is thrown when a file is not one of those formats. `ImportedEndpoint` is `{ method, path, statusCode, headers, payload }`.

## Store

| Function | Role |
|---|---|
| `createMemoryStore()` | In-process `Map`. No snapshot file. |
| `toStore(client)` | Adapts an object with `get`, `set`, `expire`, and `del`. |
| `openRedisStore(url)` | Dynamic `import("ioredis")`. Also exported from `@mockmarlin/mock-engine/redis`. Returns `{ store, close }`. |

`MockStore` is `get`, `set`, `expire`, `del`, and optional `list`.

## Types

| Export | Role |
|---|---|
| `MockEngineOptions` | Full plugin options. |
| `MockEngineSharedOptions` | The subset the WebSocket handshake reads. |
| `ResolvedEngineConfig` | Defaults filled in by `resolveEngineConfig`. |
| `KeyLayout` | The key functions, including `routeIndex`. |
| `ProtocolSwitches` | `rest`, `stream`, `graphql`, `mcp`, `grpc`. |
| `KeyTtlSeconds` | Optional seconds per key kind. |
| `RequestContext` | One resolved request. |
| `ResolvedMockResponse` | What `resolvePayloadOverride` may return. |
| `RuleDatasetResolver` | The `resolvePayloadOverride` function type. |
| `InspectorLog` | What `onInspectorLog` receives. |
| `EngineSocket` | The WebSocket surface the stream and GraphQL handlers call: `send`, `ping`, `close`, `terminate`, and `on` for `message`, `close`, and `error`. |
