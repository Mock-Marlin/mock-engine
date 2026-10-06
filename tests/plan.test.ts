/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";

import {
  chunkedContentType,
  defaultStreamDelivery,
  formatSseData,
  isStreamChunkMode,
  isStreamChunkedFormat,
  isStreamCloseCode,
  isStreamRepeat,
  isStreamSseFormat,
  isStreamWsFormat,
  isStreamWsHeartbeat,
  normalizeStreamDocument,
  planStream,
  type StreamDocument,
} from "../src/stream/plan.js";

function document(overrides: Record<string, unknown>): StreamDocument {
  const parsed = normalizeStreamDocument({
    protocol: "sse",
    payload: { storage: "inline", body: "hello world" },
    durationMs: 100,
    ...overrides,
  });
  if (parsed === null) {
    throw new Error("expected a stream document");
  }
  return parsed;
}

describe("stream plan", () => {
  it("rejects documents that are not stream configs", () => {
    expect(normalizeStreamDocument(null)).toBeNull();
    expect(normalizeStreamDocument([])).toBeNull();
    expect(normalizeStreamDocument({ protocol: "tcp" })).toBeNull();
  });

  it("fills defaults and keeps a dataset source", () => {
    const parsed = normalizeStreamDocument({
      protocol: "websocket",
      sourceType: "dataset",
      datasetId: "set-1",
      id: "stream-1",
      workspaceId: "workspace",
      path: "/events",
      chunkMode: "nope",
      sseFormat: "nope",
      wsFormat: "nope",
      chunkedFormat: "nope",
      repeat: "nope",
      wsHeartbeat: "nope",
      subprotocols: ["chat", 1],
      payload: { storage: "object" },
    });
    expect(parsed?.sourceType).toBe("dataset");
    expect(parsed?.datasetId).toBe("set-1");
    expect(parsed?.workspaceId).toBe("workspace");
    expect(parsed?.chunkMode).toBe(defaultStreamDelivery().chunkMode);
    expect(parsed?.subprotocols).toEqual(["chat"]);
    expect(parsed?.payload.body).toBe("");
  });

  it("recognizes the delivery enums", () => {
    expect(isStreamChunkMode("words")).toBe(true);
    expect(isStreamChunkMode(1)).toBe(false);
    expect(isStreamSseFormat("openai")).toBe(true);
    expect(isStreamSseFormat(1)).toBe(false);
    expect(isStreamWsFormat("binary")).toBe(true);
    expect(isStreamWsFormat(1)).toBe(false);
    expect(isStreamChunkedFormat("ollama")).toBe(true);
    expect(isStreamChunkedFormat(1)).toBe(false);
    expect(isStreamRepeat("loop")).toBe(true);
    expect(isStreamRepeat(1)).toBe(false);
    expect(isStreamWsHeartbeat("protocol")).toBe(true);
    expect(isStreamWsHeartbeat(1)).toBe(false);
    expect(isStreamCloseCode(1000)).toBe(true);
    expect(isStreamCloseCode(4500)).toBe(true);
    expect(isStreamCloseCode(1002)).toBe(false);
    expect(chunkedContentType("text")).toContain("text/plain");
    expect(chunkedContentType("ndjson")).toContain("ndjson");
    expect(formatSseData("a\r\nb\rc")).toBe("data: a\ndata: b\ndata: c\n\n");
  });

  it("splits characters, words, lines, a json array, and the whole body", () => {
    const characters = planStream(document({ chunkMode: "characters", chunkSize: 2, payload: { storage: "inline", body: "abcd" } }));
    expect(characters.chunks).toHaveLength(2);

    const words = planStream(document({ chunkMode: "words", payload: { storage: "inline", body: "one  two" } }));
    expect(words.chunks.map((chunk) => chunk.wire)).toEqual([
      "data: one\n\n",
      "data: two\n\n",
    ]);

    const lines = planStream(document({ chunkMode: "lines", payload: { storage: "inline", body: "a\r\n\nb" } }));
    expect(lines.chunks).toHaveLength(2);

    const json = planStream(
      document({
        chunkMode: "json-array",
        sseFormat: "event",
        payload: {
          storage: "inline",
          body: JSON.stringify([
            "plain",
            1,
            true,
            null,
            { event: "tick", id: 7, data: "x" },
            { event: "", data: { n: 1 } },
            { event: "bare" },
          ]),
        },
      }),
    );
    expect(json.chunks[4]?.wire).toContain("id: 7");
    expect(json.chunks[4]?.wire).toContain("event: tick");

    const broken = planStream(document({ chunkMode: "json-array", payload: { storage: "inline", body: "not-json" } }));
    expect(broken.chunks[0]?.wire).toContain("not-json");

    const empty = planStream(document({ chunkMode: "whole", payload: { storage: "inline", body: "" } }));
    expect(empty.chunks).toHaveLength(0);

    const stored = planStream(document({ payload: { storage: "object", body: "ignored" } }));
    expect(stored.chunks).toHaveLength(0);
  });

  it("frames SSE, WebSocket, and chunked deliveries", () => {
    const event = planStream(
      document({
        sseFormat: "event",
        sseEventName: "message",
        eventIds: true,
        chunkMode: "whole",
        retryMs: 3000,
        resume: true,
        sendDone: true,
        heartbeatMs: 1000,
      }),
    );
    expect(event.chunks[0]?.wire.startsWith("retry: 3000")).toBe(true);
    expect(event.trailer?.wire).toContain("[DONE]");
    expect(event.heartbeatChunk).toBe(": keepalive\n\n");

    const resumed = planStream(
      document({ eventIds: true, chunkMode: "words", resume: true, payload: { storage: "inline", body: "a b c" } }),
      "1",
    );
    expect(resumed.chunks).toHaveLength(2);

    const missed = planStream(document({ eventIds: true, chunkMode: "whole", resume: true }), "missing");
    expect(missed.chunks).toHaveLength(1);
    expect(planStream(document({ resume: true }), null).chunks.length).toBeGreaterThan(0);

    const openai = planStream(
      document({
        sseFormat: "openai",
        chunkMode: "json-array",
        payload: {
          storage: "inline",
          body: JSON.stringify(['{"object":"chat.completion.chunk"}', "hi"]),
        },
      }),
    );
    expect(openai.chunks[0]?.wire).toContain("chat.completion.chunk");
    expect(openai.chunks[1]?.wire).toContain("finish_reason");
    expect(openai.trailer?.wire).toContain("[DONE]");

    const anthropic = planStream(document({ sseFormat: "anthropic", chunkMode: "whole" }));
    expect(anthropic.chunks[0]?.wire).toContain("message_start");
    expect(anthropic.trailer?.wire).toContain("message_stop");

    const gemini = planStream(document({ sseFormat: "gemini", chunkMode: "words", payload: { storage: "inline", body: "a b" } }));
    expect(gemini.chunks[1]?.wire).toContain("STOP");

    const wsJson = planStream(
      document({
        protocol: "websocket",
        wsFormat: "json",
        chunkMode: "whole",
        sendDone: true,
        heartbeatMs: 500,
        sequence: true,
        tickHz: 10,
        payload: { storage: "inline", body: "not-json" },
      }),
    );
    expect(wsJson.chunks[0]?.wire.startsWith("{")).toBe(true);
    expect(wsJson.trailer?.wire).toBe('{"done":true}');
    expect(wsJson.heartbeatChunk).toBe('{"type":"ping"}');
    expect(wsJson.intervalMs).toBe(100);

    const wsBinary = planStream(
      document({
        protocol: "websocket",
        wsFormat: "binary",
        chunkMode: "whole",
        sendDone: true,
        heartbeatMs: 500,
        wsHeartbeat: "protocol",
        dropConnectionAtPercent: 50,
        closeCode: 999,
        repeat: "loop",
      }),
    );
    expect(wsBinary.trailer?.binary).toBe(true);
    expect(wsBinary.heartbeatProtocol).toBe(true);
    expect(wsBinary.heartbeatChunk).toBeNull();
    expect(wsBinary.dropAfterChunks).toBe(1);
    expect(wsBinary.repeat).toBe("once");
    expect(wsBinary.closeCode).toBe(1000);

    const chunked = planStream(
      document({
        protocol: "chunked",
        chunkedFormat: "ndjson",
        chunkMode: "whole",
        sendDone: true,
        heartbeatMs: 100,
        sequence: true,
        payload: { storage: "inline", body: "plain" },
      }),
    );
    expect(chunked.chunks[0]?.wire.endsWith("\n")).toBe(true);
    expect(chunked.trailer?.wire).toContain('"done":true');
    expect(chunked.heartbeatChunk).toBe("\n");

    const ollama = planStream(document({ protocol: "chunked", chunkedFormat: "ollama", chunkMode: "whole" }));
    expect(ollama.chunks[0]?.wire).toContain('"done":false');
    expect(ollama.trailer?.wire).toContain('"done":true');

    const textDone = planStream(
      document({ protocol: "chunked", chunkedFormat: "text", chunkMode: "whole", sendDone: true, sequence: true }),
    );
    expect(textDone.trailer?.wire).toBe("[DONE]");
    expect(textDone.chunks[0]?.wire).toBe("hello world");

    const textSocketDone = planStream(
      document({ protocol: "websocket", wsFormat: "text", chunkMode: "whole", sendDone: true }),
    );
    expect(textSocketDone.trailer).toEqual({ wire: "[DONE]", id: null, binary: false });

    const ping = planStream(document({ protocol: "websocket", wsFormat: "text", heartbeatMs: 10, chunkMode: "whole" }));
    expect(ping.heartbeatChunk).toBe("ping");

    const objectPayload = planStream(
      document({ chunkMode: "json-array", payload: { storage: "inline", body: '{"a":1}' } }),
    );
    expect(objectPayload.chunks).toHaveLength(1);

    const blank = planStream(
      document({
        protocol: "websocket",
        wsFormat: "json",
        chunkMode: "json-array",
        sequence: true,
        payload: { storage: "inline", body: '[""]' },
      }),
    );
    expect(blank.chunks[0]?.wire).toContain('"seq"');

    const plainSequence = planStream(
      document({ protocol: "websocket", wsFormat: "text", chunkMode: "whole", sequence: true }),
    );
    expect(plainSequence.chunks[0]?.wire).toContain("hello world");

    const noIds = planStream(document({ resume: true, eventIds: false, chunkMode: "whole" }), "1");
    expect(noIds.chunks).toHaveLength(1);
  });
});
