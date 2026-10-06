# Internals

This is what the plugin does after `register`. It does not describe how to call it. For that, start at [setup.md](setup.md).

## Startup

`mockEngine` normalizes `basePath` and builds one dispatcher from the options. The dispatcher opens a document store: Redis mode wraps the caller's client, and memory mode copies `data` into a map. `mockEngineWebsocketOptions` opens its own store from the same options, so the handshake and the route handler each keep the snapshot taken when they started. The dispatcher constructs five handlers (REST, stream, GraphQL, MCP, gRPC). MCP and gRPC share the dispatcher's store. Key names, protocol switches, and TTLs are resolved on each request through `resolveEngineConfig`, so the handlers see the same layout as the dispatcher.

The scoped router parses bodies as described in [api.md](api.md), then adds CORS headers on the way in:

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS`
- `Access-Control-Allow-Headers: *`
- `Access-Control-Expose-Headers: grpc-status, grpc-message, grpc-status-details-bin`
- `Access-Control-Max-Age: 86400`

`OPTIONS` returns 204 before the workspace is resolved.

## Dispatch

For every other method:

1. Read `params.workspaceId`. An empty segment is 404.
2. `resolveWorkspaceId`. `null` is 404, and the document store is not read.
3. Take the path after `{basePath}/{workspaceKey}`. A path that is not a slash-separated token of letters, digits, and `._~-`, or longer than 256 characters, is 404.
4. Build `RequestContext`.
5. Walk the protocols that are still enabled, and stop at the first match.

| Order | Condition | Action |
|---|---|---|
| 1 | Path is `mcp/sse` or `mcp/messages` | MCP handler, or 404 when MCP is off |
| 2 | `Content-Type` starts with `application/grpc` | gRPC handler, or 404 when gRPC is off |
| 3 | Streams are on, and `Accept` contains `text/event-stream` or a stream document exists | Stream handler |
| 4 | GraphQL is on, and the body or query has an operation or a GraphQL document exists | GraphQL handler |
| 5 | REST is on, and the method is `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, or `OPTIONS` | Route key, then mock document |
| 6 | Anything else | 404 |

A store read that throws sends 503 and stops. The error body is `{ error: "Service Unavailable", message: "Mock store is unreachable" }`. A memory read does not throw. A missing key is a miss.

In Redis mode, `EXPIRE` runs only after a `GET` that returned a string, and only when that key kind has a positive TTL in the options. Memory mode ignores `ttl`.

## WebSocket

`mockEngineWebsocketOptions` runs during the upgrade, before `socket()`.

It parses the URL the same way, resolves the workspace, then:

- If GraphQL is on, the GraphQL key exists, and the client offered `graphql-transport-ws`, that subprotocol is selected.
- If streams are on, the stream document is `protocol: "websocket"` and lists `subprotocols`, the first offered name that is in the list is selected. If the client offered none of them, the handshake is rejected with 400.
- Otherwise the upgrade proceeds with no selected subprotocol.

`socket()` runs the same workspace resolution. MCP paths close with `1008` and `MCP uses SSE, not WebSocket` when MCP is on. It then prefers a GraphQL socket when the selected offer was `graphql-transport-ws`, then a WebSocket stream document, then any other GraphQL document. A miss closes with `1008`. A store failure closes with `1011`.

## REST handler

Loads nothing itself. The dispatcher passes the parsed mock document.

Order: optional override, then status, delay, and fault from the override or the document. When `template` is true, inline text and headers are rewritten from the request. The inspector log is recorded before the delay. Faults `hang`, `reset`, and `partial` skip the normal body. Object storage goes through `readStoredObject`.

## Stream handler

`normalizeStreamDocument` fills delivery defaults and returns null when `protocol` is not `sse`, `websocket`, or `chunked`. The planner turns `payload.body` into timed chunks. HTTP responses are SSE or chunked. WebSocket responses send text, JSON, or binary frames, optional protocol pings, and a close code.

`resolvePayloadOverride` may return `config` to replace the document before planning. The inspector log records the connection. A thrown inspector callback does not stop the stream.

## GraphQL handler

Requires `sdl`. The playground is a static HTML page whose query box posts back to the same path. Execution uses the SDL for that request and responds 200 with a GraphQL envelope. An empty operation is 400 `{ data: null, errors: [...] }`. A missing document is 404.

The socket speaks `graphql-transport-ws`: `connection_init` must arrive within 10 seconds, then `subscribe` runs the operation. Subscriptions are detected by the word `subscription` in the query string and are turned into a series of `next` frames. An override's `payload.envelopes` replaces that series. It can be an array or an async iterable.

## MCP handler

`GET mcp/sse` hijacks the response, writes SSE headers, and records the session. The endpoint event points at `mcp/messages` on the same URL prefix.

`POST mcp/messages` requires `sessionId` for a live session. The catalog is loaded from the document store. JSON-RPC is answered on the SSE stream, and the POST returns 202. A missing session is 404. `GET` on the messages path and `POST` on the SSE path are 405.

Tool calls look up the tool by name, invoke `resolvePayloadOverride` with the arguments as `context.body`, and otherwise return the tool's `payload`.

Sessions live in process memory. They do not survive a restart and they are not shared across processes.

## gRPC handler

The path is split on the last `/` into service and method. The hot key is read first. `latencyMs` is awaited. An `errorCode` other than null or `OK` becomes that gRPC status and an empty body.

Otherwise the schema key is loaded, parsed, and cached in memory keyed by the full schema key. The cache entry is reused while the raw schema string is unchanged. Proto files are written to a temporary directory, loaded with `@grpc/proto-loader`, and the directory is removed. Unary methods encode `responsePayload` with the generated serializer. Streaming methods return `UNIMPLEMENTED`.

The bytes are one data frame (flag `0`) plus a trailer frame (flag `0x80`) carrying `grpc-status` and `grpc-message`.

## What the plugin never does

- It does not write mock documents. In Redis mode, `EXPIRE` is the only mutation, and only when `ttl` says so. Memory mode does not mutate the snapshot.
- It does not open a database.
- It does not decide that a workspace exists. `resolveWorkspaceId` does.
- It does not authenticate the caller.
