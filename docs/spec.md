# Spec file

`mock-engine.yaml` declares the routes a local server serves at startup. It replaces the built-in examples. The same file is what `mock-engine init` starts, and what `mock-engine check` prints.

Paths inside the file are relative to the file, not the shell's current directory. `mock-engine --config ~/proj/mock-engine.yaml` works from anywhere.

## Precedence

1. `--examples` serves the built-in examples and ignores a spec file.
2. `--config` / `MOCK_CONFIG` loads that file. A missing file is an error.
3. Otherwise `./mock-engine.yaml` or `./mock-engine.yml` in the current directory is loaded. Both names at once is an error.
4. Otherwise `--import` / `MOCK_IMPORT` replaces the examples with REST mocks from Postman, OpenAPI, or HAR.
5. Otherwise one example of each protocol is seeded.

`--config` and `--import` together is an error. Put Postman, OpenAPI, and HAR paths in `imports`. `--workspace` overrides `workspace` in the file.

An empty `mocks` list stands up an empty server. It does not fall back to the examples. A bad document fails before the port opens. The message includes the file path and the field.

A route listed under `mocks` replaces an imported route with the same method and path.

## Document

```yaml
version: 1
workspace: shop

imports:
  - ./petstore.yaml

mocks:
  - kind: rest
    method: GET
    path: /health
    status: 200
    delayMs: 0
    headers: {}
    body:
      ok: true

  - kind: sse
    path: /events
    body: hello

  - kind: websocket
    path: /ws
    body: hello

  - kind: chunked
    path: /chunked
    body: hello

  - kind: graphql
    path: /graphql
    sdl: |
      type Query { hello: String }

  - kind: mcp
    tools:
      - name: echo
        description: Echoes arguments
        body:
          ok: true
    resources: []
    prompts: []

  - kind: grpc
    service: demo.Greeter
    rpc: SayHello
    latencyMs: 0
    body:
      message: hello

protos:
  - name: demo.proto
    file: ./demo.proto
```

`version` is required and must be the number `1`. Unknown fields are an error.

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | `1` |
| `workspace` | no | URL segment under `/s`. Default `default`. Letters, numbers, dots, underscores, and dashes |
| `imports` | no | Postman, OpenAPI, or HAR files or directories |
| `mocks` | no | Routes to serve. Default is an empty list |
| `protos` | no | `.proto` files for native gRPC |

A runnable sample is [examples/mock-engine.yaml](../examples/mock-engine.yaml). `mock-engine init` writes a shorter file with one `GET /health` route.

## `kind: rest`

| Field | Default | Meaning |
|---|---|---|
| `method` | required | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, or `OPTIONS` |
| `path` | required | Route such as `/health` or `/users/:id` |
| `status` | `200` | HTTP status |
| `delayMs` | `0` | Wait before the response |
| `headers` | `{}` | Response headers |
| `body` | `{}` | A string is sent as text. Anything else is JSON |

`GET /s/shop/health` is the public URL when `workspace` is `shop` and the server is on port 4080.

## Streams

`kind` is `sse`, `websocket`, or `chunked`. `path` and `body` are required. `body` is text.

| Kind | Public URL |
|---|---|
| `sse` | `GET /s/<workspace>/<path>` as `text/event-stream` |
| `websocket` | WebSocket on that path |
| `chunked` | Chunked HTTP response |

## `kind: graphql`

`path` and `sdl` are required. `sdl` is the schema. Queries use `POST` on that path.

## `kind: mcp`

One MCP catalog per workspace. A second `mcp` entry is an error.

| Field | Default |
|---|---|
| `tools` | required list. Each tool has `name`, optional `description`, and `body` |
| `resources` | `[]` |
| `prompts` | `[]` |

The catalog is served at `/s/<workspace>/mcp/messages` and `/s/<workspace>/mcp/sse`.

## `kind: grpc`

| Field | Default | Meaning |
|---|---|---|
| `service` | required | Full name, such as `demo.Greeter` |
| `rpc` | required | Method, such as `SayHello` |
| `latencyMs` | `0` | Wait before the response |
| `errorCode` | none | gRPC status name, or omit it for success |
| `body` | `{}` | Response message |

Every gRPC mock needs a proto that contains `service <Name>`, where `<Name>` is the last segment of `service`. `demo.Greeter` needs `service Greeter`. The server names the service in the error when no proto declares it.

## `protos`

Each entry has a `name` ending in `.proto`, and either `file` or `content`.

```yaml
protos:
  - name: demo.proto
    file: ./demo.proto
  - name: extra.proto
    content: |
      syntax = "proto3";
      package demo;
      service Greeter {
        rpc SayHello (HelloRequest) returns (HelloReply);
      }
      message HelloRequest { string name = 1; }
      message HelloReply { string message = 1; }
```

`file` is read from disk. `content` is the source inline. Names must be unique. Native gRPC listens even when `protos` is omitted, and then reports that it has no services.

## `imports`

Each entry is a Postman collection, an OpenAPI 3 file, or a HAR file, or a directory of those. The same rules as `--import` apply: Postman uses the first saved example, OpenAPI 3 uses the first `2xx` or `default` response, and HAR uses the recorded response.

```yaml
imports:
  - ./petstore.yaml
  - ./collections
```

## Commands

```bash
mock-engine init
mock-engine check
mock-engine --config ./mock-engine.yaml
```

`init` writes `mock-engine.yaml`. `-o` chooses another path. `-f` overwrites. `check` prints the workspace and each route, then exits. It does not open a port.

From code, pass `specPath`:

```ts
import { serve } from "@mockmarlin/mock-engine";

const running = await serve({ specPath: "./mock-engine.yaml" });
console.log(running.source, running.imported);
await running.close();
```

`source` is `"spec"`, `"import"`, or `"examples"`. `imported` is `null` for the built-in examples. For a spec it is the number of mock entries plus the REST rows loaded from `imports`.
