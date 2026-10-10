# Redis documents

The plugin reads strings from the store, in memory or in Redis. Your app writes them. Names below use the default prefix. Swap in `createKeyLayout(prefix)` or your own `KeyLayout` if you changed it.

A missing key is a miss. Invalid JSON for a protocol that requires a document is also a miss, except MCP: a missing or broken catalog is an empty catalog (`tools`, `resources`, and `prompts` are `[]`).

## REST

`route(workspaceId, METHOD, path)` stores the mock id as a plain string.

`routeIndex(workspaceId)` stores a JSON array of `{ "method", "path", "id" }`. `writeImportedRestMocks` writes it. The plugin reads it only when `matchParams` is on, and only after the exact route key misses. A path segment that starts with `:` matches one request segment.

`mock(id)` stores JSON:

```json
{
  "statusCode": 200,
  "delayMs": 0,
  "headers": { "x-mock": "1" },
  "fault": "none",
  "template": false,
  "payload": {
    "type": "json",
    "storage": "inline",
    "mimeType": "application/json",
    "sizeBytes": 11,
    "body": "{\"ok\":true}"
  }
}
```

`payload.storage` is `inline` or `object`.

- `inline` sends `body` as the response body. `type: "binary"` base64-decodes `body` first.
- `object` treats `body` as the key passed to `readStoredObject`. `sizeBytes` becomes `Content-Length`.

`type` chooses the content type when `mimeType` is absent: `json`, `text`, `html`, `xml`, or `binary`.

`fault`:

| Value | Behavior |
|---|---|
| `none` | Send the full body. This is the default. |
| `hang` | Hold the socket until the client disconnects, or 60 seconds. |
| `reset` | Destroy the socket. |
| `partial` | Write about 30 percent of the body, then close. |

`template: true` expands tokens in an inline text body and in header values. Unknown tokens stay as written.

| Token | Replaced with |
|---|---|
| `{{method}}` | Request method |
| `{{path}}` | Request path |
| `{{uuid}}` | A new UUID |
| `{{now}}` | Current time, ISO-8601 |
| `{{header.Name}}` | A request header |
| `{{query.name}}` | A query field |
| `{{body.name}}` | A JSON body field |

## Streams

`stream(workspaceId, path)` stores JSON. `protocol` is required and is `sse`, `websocket`, or `chunked`. Without it, the document is ignored.

The payload is split into chunks and written across `durationMs` (default 1000 when the field is missing). `payload.body` is the text that gets chunked. `payload.storage` is recorded and defaults to `inline`.

Delivery fields the planner understands:

| Field | Role |
|---|---|
| `chunkMode` | `characters`, `words`, `lines`, `json-array`, or `whole` |
| `chunkSize` | Size hint for character and word modes |
| `sseFormat` | `data`, `event`, `openai`, `anthropic`, or `gemini` |
| `wsFormat` | `text`, `json`, or `binary` |
| `chunkedFormat` | `text`, `ndjson`, or `ollama` |
| `dropConnectionAtPercent` | Close after this percent of the chunks |
| `heartbeatMs` | Comment heartbeat for SSE, or a WebSocket heartbeat |
| `wsHeartbeat` | `message` or `protocol` (a protocol ping) |
| `resume` | Honor `Last-Event-ID` when `eventIds` is set |
| `repeat` | `once` or `loop` |
| `subprotocols` | WebSocket subprotocols the client must offer one of |
| `echo` | WebSocket echo of client messages |
| `initialDelayMs`, `retryMs`, `closeCode`, `closeReason` | Start delay, SSE retry, and the closing WebSocket frame |

SSE responses use `text/event-stream`. Chunked responses use the content type for `chunkedFormat`.

## GraphQL

`graphql(workspaceId, path)` stores JSON with a non-empty `sdl` string. The schema is built from that SDL for the request. There is no separate resolver document. Fields resolve through the mock schema builder, or through `resolvePayloadOverride` when that callback returns a response.

A `GET` with `Accept: text/html` and no `query` returns the playground HTML. Other calls read the operation from a JSON body, an `application/graphql` body, or the `query` query parameter.

Subscriptions on the same URL use the `graphql-transport-ws` subprotocol.

## MCP

`mcp(workspaceId)` stores one catalog for the workspace:

```json
{
  "tools": [
    {
      "name": "echo",
      "description": "Echoes arguments",
      "inputSchema": { "type": "object" },
      "payload": { "ok": true }
    }
  ],
  "resources": [],
  "prompts": []
}
```

Tools listed to clients need `name` and `inputSchema`. `description` is included when it is a string. `payload` is returned from `tools/call` when `resolvePayloadOverride` is omitted or returns `null`.

The HTTP paths are fixed relative to the workspace:

- `GET {basePath}/{workspaceKey}/mcp/sse` opens the SSE session
- `POST {basePath}/{workspaceKey}/mcp/messages?sessionId=...` accepts JSON-RPC

Supported methods: `initialize`, `ping`, `tools/list`, `resources/list`, `prompts/list`, `tools/call`. Protocol version `2024-11-05`. The `initialize` result reports the server name `mock-engine`.

## gRPC-Web

Two keys:

- `grpc(workspaceId, service, method)` is the hot response
- `grpcSchema(workspaceId)` is the proto text used to encode it

The URL path after the workspace key is `{package.Service}/{Method}`. `service` in the Redis key is that package-qualified service name.

Hot document:

```json
{
  "responsePayload": { "message": "hello" },
  "latencyMs": 0,
  "errorCode": null
}
```

`responsePayload` must be a JSON object when `errorCode` is null or `OK`. `errorCode` is a gRPC status name such as `NOT_FOUND`. `latencyMs` waits before the response.

Schema document:

```json
{
  "files": [
    { "name": "demo.proto", "content": "syntax = \"proto3\"; ..." }
  ]
}
```

File names must match `[A-Za-z0-9][A-Za-z0-9._-]{0,120}.proto`. Streaming RPCs are rejected with `UNIMPLEMENTED`.

The response is a gRPC-Web frame plus trailers (`grpc-status`, `grpc-message`).

## TTL

Nothing in this file is given a TTL unless the writer sets one, or the plugin is configured with `ttl` and then refreshes it on read. See [configuration.md](configuration.md).
