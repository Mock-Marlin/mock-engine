# Configuration

Every field on the object you pass to `mockEngine` and `mockEngineWebsocketOptions`. Pass the same mode, store, URL, key, TTL, and protocol fields to both.

## `mode`

Optional. `"redis"` or `"memory"`. Omitted means `"redis"`.

`"redis"` reads the `redis` client. `"memory"` reads `data` and does not open a connection. Pass one store, not both.

## `redis`

Required when `mode` is `"redis"` or omitted. An `ioredis` client you create. The plugin does not construct one and does not call `quit`. It calls `GET`, and `EXPIRE` only when a TTL is configured and the key exists.

## `data`

Required when `mode` is `"memory"`. A `Record<string, string>` whose keys and values are the same strings Redis would hold. See [redis.md](redis.md).

The plugin and the WebSocket handshake each copy the map when they open. Later edits to your object do not change a running server. A value that is not a string throws at startup. An empty map is valid, and every lookup is a miss. `ttl` is ignored.

## `resolveWorkspaceId`

Required `(workspaceKey: string) => Promise<string | null>`.

`workspaceKey` is the first path segment after `basePath`. It is whatever you put in the URL: a slug, a uuid, or any other single segment. Return the id that your document keys use. Return `null` when that workspace should not be served. The plugin then responds 404 and does not read the store.

The returned string is `RequestContext.workspaceId`. Handlers do not interpret it.

## `basePath`

Optional. Default `/s`.

The plugin mounts `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS` on `{basePath}/:workspaceId` and `{basePath}/:workspaceId/*`. `GET` also accepts WebSocket upgrades.

A value that is missing, blank, or does not start with `/` becomes `/s`. A trailing slash is removed, so `/mocks/` is `/mocks`.

A request is then:

```text
{basePath}/{workspaceKey}/{route}
```

`{route}` is the rest of the path. The workspace root (`{basePath}/{workspaceKey}`) uses route `/`.

Examples:

| `basePath` | Request | Workspace key | Route |
|---|---|---|---|
| `/s` | `/s/demo/hello` | `demo` | `/hello` |
| `/mocks` | `/mocks/demo` | `demo` | `/` |
| omitted | `/s/acme/mcp/sse` | `acme` | `/mcp/sse` |

## `keyPrefix`

Optional. Default `mockmarlin`.

Used only when `keys` is omitted. The prefix is trimmed, and a trailing colon is removed. A blank prefix falls back to `mockmarlin`.

`createKeyLayout("widgets")` produces:

| Kind | Key |
|---|---|
| REST route index | `widgets:route:{workspaceId}:{METHOD}:{path}` |
| REST document | `widgets:mock:{id}` |
| Stream | `widgets:stream:{workspaceId}:{path}` |
| GraphQL | `widgets:graphql:{workspaceId}:{path}` |
| MCP catalog | `widgets:mcp:{workspaceId}` |
| gRPC response | `widgets:grpc:{workspaceId}:{service}:{method}` |
| gRPC protos | `widgets:grpc-schema:{workspaceId}` |

`{METHOD}` is the Fastify method, such as `GET`. `{path}` includes the leading slash, such as `/hello`.

The same functions are exported one by one (`routeKey`, `mockKey`, `streamKey`, `graphqlKey`, `mcpKey`, `grpcHotKey`, `grpcSchemaKey`). Each takes an optional prefix as its last argument. Omit it and the prefix is `mockmarlin`.

## `keys`

Optional `KeyLayout`. When set, `keyPrefix` is ignored and these functions are called instead:

```ts
interface KeyLayout {
  route(workspaceId: string, method: string, path: string): string;
  mock(id: string): string;
  stream(workspaceId: string, path: string): string;
  graphql(workspaceId: string, path: string): string;
  mcp(workspaceId: string): string;
  grpc(workspaceId: string, service: string, method: string): string;
  grpcSchema(workspaceId: string): string;
}
```

Use this when the colon-separated prefix is not the shape you store. A spread of `createKeyLayout()` plus one override is enough when only some names differ.

`resolveEngineConfig({ keyPrefix, keys })` returns the layout the plugin will actually call, so writers and the plugin share one implementation.

## `ttl`

Optional. Used only in Redis mode. Memory mode ignores it and never expires a document.

The plugin never writes documents. When a field is a positive finite number, a successful `GET` of that kind of key is followed by `EXPIRE key seconds`. The value is floored. `0`, negative numbers, and omitted fields do not call `EXPIRE`. A missing key is not given a TTL.

| Field | Key that is refreshed |
|---|---|
| `route` | REST route index |
| `mock` | REST document |
| `stream` | Stream document |
| `graphql` | GraphQL document |
| `mcp` | MCP catalog |
| `grpc` | gRPC hot response |
| `grpcSchema` | Cached proto files |

Set this when a read should keep a short-lived mock alive. Leave it unset for mocks stored without an expiry. Those keys stay until they are deleted.

If `EXPIRE` throws, the HTTP request becomes 503 and a WebSocket lookup closes with `1011`, the same as a failed `GET`.

## `protocols`

Optional. Every protocol defaults to on. Set a field to `false` to disable it.

| Field | What turns off |
|---|---|
| `rest` | Method and path lookup of `keys.route` / `keys.mock` |
| `stream` | SSE, chunked HTTP, and WebSocket stream documents |
| `graphql` | GraphQL HTTP, the HTML playground, and `graphql-transport-ws` |
| `mcp` | `mcp/sse` and `mcp/messages` |
| `grpc` | Requests whose `Content-Type` starts with `application/grpc` |

Disabled `mcp` and `grpc` requests are 404. They do not fall through to REST. Disabled `stream` and `graphql` requests skip that lookup and continue to the next protocol.

## `resolvePayloadOverride`

Optional `(context, rawMockConfig) => Promise<ResolvedMockResponse | null>`.

Called after a document is loaded, for REST, streams, GraphQL, and MCP tool calls. Return `null` to send the stored document. Return a response to replace it.

`rawMockConfig` is the stored JSON: a REST mock, a stream document, a GraphQL document, or one MCP tool. `context.body` is the HTTP body. For one GraphQL operation or one tool call it is that operation or the tool arguments.

`ResolvedMockResponse`:

| Field | Meaning |
|---|---|
| `statusCode` | HTTP status. REST uses it. GraphQL HTTP sends the payload with this status. |
| `headers` | Extra response headers for REST. |
| `payload` | Body, or the value an MCP tool returns. |
| `delayMs` | Wait before sending. |
| `fault` | REST only: `none`, `hang`, `reset`, or `partial`. |
| `config` | When set, replaces the stream or GraphQL document before execution. |
| `matchedRuleId` | Copied onto the inspector log. |
| `matchedRuleName` | Copied onto the inspector log. Defaults to `Default` when absent. |

The plugin does not know what a "rule" is. Those two fields exist so a host can record which override ran.

## `onInspectorLog`

Optional `(log: InspectorLog) => Promise<void>`.

Called for accepted REST responses and accepted stream connections. A rejection is ignored. The mock response is still sent.

`InspectorLog` carries `kind` (`rest` or `stream`), the mock or stream id, method, protocol, headers, query, body, an ISO timestamp, and the matched rule fields.

## `readStoredObject`

Optional `(objectKey: string) => Promise<Readable>`.

REST payloads with `storage: "object"` treat `payload.body` as an object key and stream the readable as the body. The package does not import an S3 client. If this callback is missing, that mock responds 404 `Stored payload is missing`.

If the readable cannot be opened and the error has `name: "MissingStoredObjectError"` or `code: "STORED_OBJECT_MISSING"`, the response is 404. Other errors propagate.

## Shared type: `RequestContext`

Built once the workspace id is known.

| Field | Meaning |
|---|---|
| `workspaceId` | Value returned by `resolveWorkspaceId`. |
| `method` | HTTP method. |
| `path` | Route under the workspace. `/` is the workspace root. |
| `headers` | Header names as Fastify provides them. Multi-value headers are joined with a comma. |
| `query` | Parsed query string, or `{}`. |
| `body` | Parsed body, or `undefined`. |
