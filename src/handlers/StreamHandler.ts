/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import { acquireHeldSocket, releaseHeldSocket } from "../held-sockets.js";
import { headerText, stringHeaders } from "../http.js";
import {
  chunkedContentType,
  normalizeStreamDocument,
  planStream,
  type PlannedChunk,
  type StreamDocument,
  type StreamPlan,
} from "../stream/plan.js";
import type { EngineSocket, InspectorLog, MockEngineOptions, RequestContext, ResolvedMockResponse } from "../types.js";

const DEFAULT_MATCHED_RULE_NAME = "Default";
const WS_OPEN = 1;

interface StreamTransport {
  sendChunk(chunk: string, binary?: boolean): void;
  ping(): void;
  complete(): void;
  drop(): void;
  onDisconnect(handler: () => void): void;
}

function runChunkedStream(plan: StreamPlan, transport: StreamTransport): void {
  let chunkIndex = 0;
  let sentChunks = 0;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let heartbeatId: ReturnType<typeof setInterval> | undefined;
  let startId: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (intervalId !== undefined) {
      clearInterval(intervalId);
    }
    if (heartbeatId !== undefined) {
      clearInterval(heartbeatId);
    }
    if (startId !== undefined) {
      clearTimeout(startId);
    }
  };

  const looping = plan.repeat === "loop" && plan.dropAfterChunks === null && plan.chunks.length > 0;

  const finishComplete = (): void => {
    if (plan.trailer !== null) {
      try {
        transport.sendChunk(plan.trailer.wire, plan.trailer.binary);
      } catch {
        stop();
        return;
      }
    }
    stop();
    transport.complete();
  };

  const sendPlanned = (chunk: PlannedChunk): boolean => {
    if (chunk.wire.length === 0) {
      return true;
    }
    try {
      transport.sendChunk(chunk.wire, chunk.binary);
      return true;
    } catch {
      stop();
      return false;
    }
  };

  const tick = (): void => {
    if (stopped) {
      return;
    }
    if (plan.dropAfterChunks !== null && sentChunks >= plan.dropAfterChunks) {
      stop();
      setImmediate(() => {
        transport.drop();
      });
      return;
    }
    if (chunkIndex >= plan.chunks.length) {
      if (looping) {
        chunkIndex = 0;
      } else {
        finishComplete();
        return;
      }
    }
    const chunk = plan.chunks[chunkIndex];
    chunkIndex += 1;
    if (chunk === undefined) {
      finishComplete();
      return;
    }
    if (!sendPlanned(chunk)) {
      return;
    }
    sentChunks += 1;
    if (plan.dropAfterChunks !== null && sentChunks >= plan.dropAfterChunks) {
      stop();
      setImmediate(() => {
        transport.drop();
      });
      return;
    }
    if (chunkIndex >= plan.chunks.length) {
      if (looping) {
        chunkIndex = 0;
        return;
      }
      finishComplete();
    }
  };

  const start = (): void => {
    if (stopped) {
      return;
    }
    if (plan.heartbeatMs !== null && plan.heartbeatMs > 0 && (plan.heartbeatProtocol || plan.heartbeatChunk !== null)) {
      heartbeatId = setInterval(() => {
        if (stopped) {
          return;
        }
        try {
          if (plan.heartbeatProtocol) {
            transport.ping();
            return;
          }
          if (plan.heartbeatChunk !== null) {
            transport.sendChunk(plan.heartbeatChunk);
          }
        } catch {
          stop();
        }
      }, plan.heartbeatMs);
    }
    tick();
    if (!stopped) {
      intervalId = setInterval(tick, plan.intervalMs);
    }
  };

  transport.onDisconnect(stop);
  if (plan.initialDelayMs > 0) {
    startId = setTimeout(start, plan.initialDelayMs);
  } else {
    start();
  }
}

function httpStreamTransport(request: FastifyRequest, reply: FastifyReply, contentType: string): StreamTransport {
  const rawReq = request.raw;
  const rawRes = reply.raw;
  rawReq.setTimeout(0);
  rawRes.setTimeout(0);
  reply.hijack();
  rawRes.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "*",
  });

  return {
    sendChunk(chunk: string): void {
      if (rawRes.writableEnded || rawRes.destroyed) {
        throw new Error("Stream socket closed");
      }
      rawRes.write(chunk);
    },
    ping(): void {
      // SSE keepalives are comment frames, not protocol pings.
    },
    complete(): void {
      if (!rawRes.writableEnded && !rawRes.destroyed) {
        rawRes.end();
      }
    },
    drop(): void {
      if (!rawRes.destroyed) {
        rawRes.destroy();
      }
    },
    onDisconnect(handler: () => void): void {
      rawReq.on("close", handler);
      rawReq.on("aborted", handler);
      rawRes.on("close", handler);
      rawRes.on("error", handler);
    },
  };
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(data);
  }
  if (typeof data === "string") {
    return Buffer.from(data);
  }
  return Buffer.alloc(0);
}

function websocketTransport(socket: EngineSocket, plan: StreamPlan, echo: boolean): StreamTransport {
  if (echo) {
    socket.on("message", (data, isBinary) => {
      if (socket.readyState !== undefined && socket.readyState !== WS_OPEN) {
        return;
      }
      const buffer = toBuffer(data);
      if (isBinary) {
        socket.send(buffer);
        return;
      }
      socket.send(buffer.toString("utf8"));
    });
  }

  return {
    sendChunk(chunk: string, binary?: boolean): void {
      if (socket.readyState !== undefined && socket.readyState !== WS_OPEN) {
        throw new Error("WebSocket is not open");
      }
      if (binary === true) {
        socket.send(Buffer.from(chunk, "utf8"));
        return;
      }
      socket.send(chunk);
    },
    ping(): void {
      if (socket.readyState !== undefined && socket.readyState !== WS_OPEN) {
        throw new Error("WebSocket is not open");
      }
      socket.ping();
    },
    complete(): void {
      if (socket.readyState === undefined || socket.readyState === WS_OPEN) {
        socket.close(plan.closeCode, plan.closeReason);
      }
    },
    drop(): void {
      socket.terminate();
    },
    onDisconnect(handler: () => void): void {
      socket.on("close", handler);
      socket.on("error", handler);
    },
  };
}

function holdTransport(transport: StreamTransport): { transport: StreamTransport; release: () => void } {
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    releaseHeldSocket();
  };
  return {
    release,
    transport: {
      sendChunk: transport.sendChunk.bind(transport),
      ping: transport.ping.bind(transport),
      complete(): void {
        transport.complete();
        release();
      },
      drop(): void {
        transport.drop();
        release();
      },
      onDisconnect(handler: () => void): void {
        transport.onDisconnect(() => {
          release();
          handler();
        });
      },
    },
  };
}

function lastEventId(request: FastifyRequest): string | null {
  const header = headerText(request.headers["last-event-id"]);
  return header.length > 0 ? header : null;
}

export class StreamHandler {
  private readonly options: MockEngineOptions;

  constructor(options: MockEngineOptions) {
    this.options = options;
  }

  async handleHttp(
    request: FastifyRequest,
    reply: FastifyReply,
    raw: unknown,
    context: RequestContext,
  ): Promise<void> {
    const ready = await this.prepare(raw, context);
    if (ready === null) {
      await reply.status(404).send({
        error: "Not Found",
        message: "Stream endpoint not found or expired",
      });
      return;
    }
    if (ready.override?.statusCode === 413) {
      await reply.status(413).type("application/json; charset=utf-8").send({
        error: "Payload Too Large",
        message: "This response is larger than the workspace plan allows",
      });
      return;
    }
    if (ready.config.protocol === "websocket") {
      await reply.status(400).send({
        error: "Bad Request",
        message: "This stream is WebSocket-only; connect with a WebSocket client",
      });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      await reply.status(405).send({
        error: "Method Not Allowed",
        message: "This stream accepts GET",
      });
      return;
    }

    if (!acquireHeldSocket()) {
      await reply.status(503).send({
        error: "Service Unavailable",
        message: "Too many open connections",
      });
      return;
    }
    const plan = planStream(ready.config, lastEventId(request));
    const contentType =
      ready.config.protocol === "chunked"
        ? chunkedContentType(ready.config.chunkedFormat)
        : "text/event-stream; charset=utf-8";
    let rawTransport: StreamTransport;
    try {
      rawTransport = httpStreamTransport(request, reply, contentType);
    } catch (error: unknown) {
      releaseHeldSocket();
      throw error;
    }
    const held = holdTransport(rawTransport);
    try {
      runChunkedStream(plan, held.transport);
    } catch (error: unknown) {
      held.release();
      throw error;
    }
  }

  async handleSocket(socket: EngineSocket, raw: unknown, context: RequestContext): Promise<void> {
    try {
      const ready = await this.prepare(raw, context);
      if (ready?.override?.statusCode === 413) {
        socket.close(1008, "Response exceeds the workspace plan");
        return;
      }
      if (ready === null || ready.config.protocol !== "websocket") {
        const reason =
          ready === null
            ? "Stream endpoint not found or expired"
            : ready.config.protocol === "chunked"
              ? "This stream is HTTP chunked; use fetch"
              : "This stream is SSE-only";
        socket.close(1008, reason);
        return;
      }
      if (!acquireHeldSocket()) {
        socket.close(1013, "Too many open connections");
        return;
      }
      const plan = planStream(ready.config, null);
      let rawTransport: StreamTransport;
      try {
        rawTransport = websocketTransport(socket, plan, ready.config.echo);
      } catch (error: unknown) {
        releaseHeldSocket();
        throw error;
      }
      const held = holdTransport(rawTransport);
      try {
        runChunkedStream(plan, held.transport);
      } catch (error: unknown) {
        held.release();
        throw error;
      }
    } catch {
      socket.terminate();
    }
  }

  private async prepare(
    raw: unknown,
    context: RequestContext,
  ): Promise<{ config: StreamDocument; override: ResolvedMockResponse | null } | null> {
    const parsed = normalizeStreamDocument(raw);
    if (parsed === null) {
      return null;
    }
    const override =
      this.options.resolvePayloadOverride === undefined
        ? null
        : await this.options.resolvePayloadOverride(context, raw);
    const rewritten = override?.config === undefined ? null : normalizeStreamDocument(override.config);
    const config = rewritten ?? parsed;
    await this.log(config, context, override);
    return { config, override };
  }

  private async log(
    config: StreamDocument,
    context: RequestContext,
    override: ResolvedMockResponse | null,
  ): Promise<void> {
    if (this.options.onInspectorLog === undefined || config.id.length === 0) {
      return;
    }
    const entry: InspectorLog = {
      kind: "stream",
      id: config.id,
      protocol: config.protocol,
      headers: stringHeaders(context.headers),
      query: context.query,
      timestamp: new Date().toISOString(),
      matchedRuleId: override?.matchedRuleId ?? null,
      matchedRuleName: override?.matchedRuleName ?? DEFAULT_MATCHED_RULE_NAME,
    };
    try {
      await this.options.onInspectorLog(entry);
    } catch {
      // Inspector must never fail the stream.
    }
  }
}
