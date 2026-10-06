/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

export interface StreamDocument {
  id: string;
  workspaceId: string;
  path: string;
  protocol: "sse" | "websocket" | "chunked";
  sourceType: "dataset" | "custom";
  datasetId: string | null;
  payload: { storage: string; body: string; type?: string; mimeType?: string; sizeBytes?: number };
  durationMs: number;
  dropConnectionAtPercent: number | null;
  chunkMode: "characters" | "words" | "lines" | "json-array" | "whole";
  chunkSize: number | null;
  sseFormat: "data" | "event" | "openai" | "anthropic" | "gemini";
  wsFormat: "text" | "json" | "binary";
  chunkedFormat: "text" | "ndjson" | "ollama";
  tickHz: number | null;
  sequence: boolean;
  sseEventName: string | null;
  eventIds: boolean;
  sendDone: boolean;
  heartbeatMs: number | null;
  initialDelayMs: number;
  retryMs: number | null;
  resume: boolean;
  repeat: "once" | "loop";
  closeCode: number;
  closeReason: string;
  subprotocols: string[];
  echo: boolean;
  wsHeartbeat: "message" | "protocol";
}

type StreamMockConfig = StreamDocument;
type StreamChunkMode = StreamDocument["chunkMode"];
type StreamSseFormat = StreamDocument["sseFormat"];
type StreamWsFormat = StreamDocument["wsFormat"];
type StreamChunkedFormat = StreamDocument["chunkedFormat"];
type StreamRepeat = StreamDocument["repeat"];
type StreamWsHeartbeat = StreamDocument["wsHeartbeat"];

const TARGET_TICK_MS = 50;
const CHUNK_MODES = new Set<StreamChunkMode>(["characters", "words", "lines", "json-array", "whole"]);
const SSE_FORMATS = new Set<StreamSseFormat>(["data", "event", "openai", "anthropic", "gemini"]);
const WS_FORMATS = new Set<StreamWsFormat>(["text", "json", "binary"]);
const CHUNKED_FORMATS = new Set<StreamChunkedFormat>(["text", "ndjson", "ollama"]);
const REPEATS = new Set<StreamRepeat>(["once", "loop"]);
const WS_HEARTBEATS = new Set<StreamWsHeartbeat>(["message", "protocol"]);
const NAMED_CLOSE_CODES = new Set([1000, 1001, 1008, 1011]);

export interface PlannedChunk {
  wire: string;
  id: string | null;
  binary: boolean;
}

export interface StreamPlan {
  chunks: PlannedChunk[];
  intervalMs: number;
  dropAfterChunks: number | null;
  trailer: PlannedChunk | null;
  heartbeatMs: number | null;
  /** Data-frame heartbeat. `null` when the heartbeat is a protocol ping or off. */
  heartbeatChunk: string | null;
  /** WebSocket opcode ping. SSE heartbeats stay comments in `heartbeatChunk`. */
  heartbeatProtocol: boolean;
  initialDelayMs: number;
  repeat: StreamRepeat;
  closeCode: number;
  closeReason: string;
}

interface SemanticChunk {
  raw: string;
  event: string | null;
  id: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStreamChunkMode(value: unknown): value is StreamChunkMode {
  return typeof value === "string" && CHUNK_MODES.has(value as StreamChunkMode);
}

export function isStreamSseFormat(value: unknown): value is StreamSseFormat {
  return typeof value === "string" && SSE_FORMATS.has(value as StreamSseFormat);
}

export function isStreamWsFormat(value: unknown): value is StreamWsFormat {
  return typeof value === "string" && WS_FORMATS.has(value as StreamWsFormat);
}

export function isStreamChunkedFormat(value: unknown): value is StreamChunkedFormat {
  return typeof value === "string" && CHUNKED_FORMATS.has(value as StreamChunkedFormat);
}

export function chunkedContentType(format: StreamChunkedFormat): string {
  if (format === "text") {
    return "text/plain; charset=utf-8";
  }
  return "application/x-ndjson; charset=utf-8";
}

export function isStreamRepeat(value: unknown): value is StreamRepeat {
  return typeof value === "string" && REPEATS.has(value as StreamRepeat);
}

export function isStreamWsHeartbeat(value: unknown): value is StreamWsHeartbeat {
  return typeof value === "string" && WS_HEARTBEATS.has(value as StreamWsHeartbeat);
}

export function isStreamCloseCode(value: number): boolean {
  return NAMED_CLOSE_CODES.has(value) || (value >= 4000 && value <= 4999);
}

export function defaultStreamDelivery(): Pick<
  StreamMockConfig,
  | "chunkMode"
  | "chunkSize"
  | "sseFormat"
  | "wsFormat"
  | "chunkedFormat"
  | "sseEventName"
  | "eventIds"
  | "sendDone"
  | "heartbeatMs"
  | "initialDelayMs"
  | "retryMs"
  | "resume"
  | "repeat"
  | "closeCode"
  | "closeReason"
  | "subprotocols"
  | "echo"
  | "wsHeartbeat"
  | "tickHz"
  | "sequence"
> {
  return {
    chunkMode: "characters",
    chunkSize: null,
    sseFormat: "data",
    wsFormat: "text",
    chunkedFormat: "text",
    sseEventName: null,
    eventIds: false,
    sendDone: false,
    heartbeatMs: null,
    initialDelayMs: 0,
    retryMs: null,
    resume: false,
    repeat: "once",
    closeCode: 1000,
    closeReason: "Stream complete",
    subprotocols: [],
    echo: false,
    wsHeartbeat: "message",
    tickHz: null,
    sequence: false,
  };
}

function stringifyJson(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
}

function isJsonText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function splitCharacters(payload: string, chunkSize: number | null, durationMs: number): string[] {
  const length = payload.length;
  if (length === 0) {
    return [];
  }

  const size =
    chunkSize !== null && chunkSize > 0
      ? chunkSize
      : Math.ceil(length / Math.min(length, Math.max(1, Math.floor(durationMs / TARGET_TICK_MS))));

  const chunks: string[] = [];
  for (let offset = 0; offset < length; offset += size) {
    chunks.push(payload.slice(offset, offset + size));
  }
  return chunks;
}

function semanticFromValue(value: unknown): SemanticChunk {
  if (typeof value === "string") {
    return { raw: value, event: null, id: null };
  }

  if (isRecord(value)) {
    const eventName = value["event"];
    const event = typeof eventName === "string" && eventName.length > 0 ? eventName : null;
    const idValue = value["id"];
    const id = idValue === undefined || idValue === null ? null : String(idValue);

    if (Object.prototype.hasOwnProperty.call(value, "data")) {
      const data = value["data"];
      if (typeof data === "string") {
        return { raw: data, event, id };
      }
      return { raw: stringifyJson(data) ?? "", event, id };
    }

    return { raw: stringifyJson(value) ?? "", event, id };
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { raw: stringifyJson(value) ?? String(value), event: null, id: null };
  }

  return { raw: stringifyJson(value) ?? "", event: null, id: null };
}

function splitJsonArray(payload: string): SemanticChunk[] {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (Array.isArray(parsed)) {
      return parsed.map(semanticFromValue);
    }
    return [semanticFromValue(parsed)];
  } catch {
    return [{ raw: payload, event: null, id: null }];
  }
}

function splitPayload(payload: string, config: StreamMockConfig): SemanticChunk[] {
  switch (config.chunkMode) {
    case "whole":
      return payload.length === 0 ? [] : [{ raw: payload, event: null, id: null }];
    case "lines":
      return payload
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => ({ raw: line, event: null, id: null }));
    case "words":
      return payload
        .split(/\s+/)
        .filter((word) => word.length > 0)
        .map((word) => ({ raw: word, event: null, id: null }));
    case "json-array":
      return splitJsonArray(payload);
    case "characters":
    default:
      return splitCharacters(payload, config.chunkSize, config.durationMs).map((raw) => ({
        raw,
        event: null,
        id: null,
      }));
  }
}

export function formatSseData(chunk: string): string {
  const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  let body = "";
  for (const line of lines) {
    body += `data: ${line}\n`;
  }
  return `${body}\n`;
}

function formatSseEvent(chunk: string, eventName: string | null, id: string | null): string {
  let head = "";
  if (id !== null && id.length > 0) {
    head += `id: ${id}\n`;
  }
  if (eventName !== null && eventName.length > 0) {
    head += `event: ${eventName}\n`;
  }
  return `${head}${formatSseData(chunk)}`;
}

function frameWebsocket(raw: string, wsFormat: StreamWsFormat): string {
  if (wsFormat === "json") {
    return isJsonText(raw) ? raw.trim() : (stringifyJson(raw) ?? JSON.stringify(raw));
  }
  return raw;
}

function isCompletionChunk(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && parsed["object"] === "chat.completion.chunk";
  } catch {
    return false;
  }
}

function openAiPayload(raw: string, isLast: boolean): string {
  if (isCompletionChunk(raw)) {
    return raw.trim();
  }
  return JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: { content: raw },
        finish_reason: isLast ? "stop" : null,
      },
    ],
  });
}

function sseNamed(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicPreamble(): PlannedChunk {
  const messageStart = sseNamed("message_start", {
    type: "message_start",
    message: {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-mock",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  const blockStart = sseNamed("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  return { wire: messageStart + blockStart, id: null, binary: false };
}

function anthropicDelta(text: string): string {
  return sseNamed("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
}

function anthropicCloser(): PlannedChunk {
  const stop = sseNamed("content_block_stop", { type: "content_block_stop", index: 0 });
  const delta = sseNamed("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  const done = sseNamed("message_stop", { type: "message_stop" });
  return { wire: stop + delta + done, id: null, binary: false };
}

function geminiPayload(raw: string, isLast: boolean): string {
  const candidate: Record<string, unknown> = {
    content: { parts: [{ text: raw }], role: "model" },
    index: 0,
  };
  if (isLast) {
    candidate["finishReason"] = "STOP";
  }
  return JSON.stringify({ candidates: [candidate] });
}

function frameChunked(raw: string, format: StreamChunkedFormat): string {
  if (format === "text") {
    return raw;
  }
  if (format === "ollama") {
    return `${JSON.stringify({
      model: "mock",
      message: { role: "assistant", content: raw },
      done: false,
    })}\n`;
  }
  const line = isJsonText(raw) ? raw.trim() : (stringifyJson(raw) ?? JSON.stringify(raw));
  return `${line}\n`;
}

function frameSse(
  raw: string,
  sseFormat: StreamSseFormat,
  eventName: string | null,
  id: string | null,
): string {
  if (sseFormat === "event") {
    return formatSseEvent(raw, eventName ?? "message", id);
  }
  return formatSseEvent(raw, null, id);
}

function frameChunk(semantic: SemanticChunk, config: StreamMockConfig, index: number, total: number): PlannedChunk {
  const numberedId = config.eventIds ? String(index + 1) : null;
  const id = semantic.id ?? numberedId;
  const isLast = index === total - 1;

  if (config.protocol === "websocket") {
    return {
      wire: frameWebsocket(semantic.raw, config.wsFormat),
      id,
      binary: config.wsFormat === "binary",
    };
  }

  if (config.protocol === "chunked") {
    return {
      wire: frameChunked(semantic.raw, config.chunkedFormat),
      id,
      binary: false,
    };
  }

  if (config.sseFormat === "anthropic") {
    return { wire: anthropicDelta(semantic.raw), id, binary: false };
  }

  const eventName = semantic.event ?? config.sseEventName;
  let raw = semantic.raw;
  if (config.sseFormat === "openai") {
    raw = openAiPayload(semantic.raw, isLast);
  } else if (config.sseFormat === "gemini") {
    raw = geminiPayload(semantic.raw, isLast);
  }
  return {
    wire: frameSse(raw, config.sseFormat === "event" ? "event" : "data", eventName, id),
    id,
    binary: false,
  };
}

function applyResume(chunks: PlannedChunk[], config: StreamMockConfig, lastEventId: string | null): PlannedChunk[] {
  if (!config.resume || config.protocol !== "sse" || lastEventId === null || lastEventId.length === 0) {
    return chunks;
  }
  if (!chunks.some((chunk) => chunk.id !== null)) {
    return chunks;
  }
  const match = chunks.findIndex((chunk) => chunk.id === lastEventId);
  if (match === -1) {
    return chunks;
  }
  return chunks.slice(match + 1);
}

function prependRetry(chunks: PlannedChunk[], config: StreamMockConfig): PlannedChunk[] {
  if (config.protocol !== "sse" || config.retryMs === null || chunks.length === 0) {
    return chunks;
  }
  const [first, ...rest] = chunks;
  if (first === undefined) {
    return chunks;
  }
  return [{ ...first, wire: `retry: ${String(config.retryMs)}\n${first.wire}` }, ...rest];
}

function doneTrailer(config: StreamMockConfig): PlannedChunk | null {
  if (config.protocol === "sse" && config.sseFormat === "anthropic") {
    return anthropicCloser();
  }
  if (config.protocol === "chunked" && config.chunkedFormat === "ollama") {
    return {
      wire: `${JSON.stringify({
        model: "mock",
        message: { role: "assistant", content: "" },
        done: true,
      })}\n`,
      id: null,
      binary: false,
    };
  }
  const wantsDone = config.sendDone || (config.protocol === "sse" && config.sseFormat === "openai");
  if (!wantsDone) {
    return null;
  }
  if (config.protocol === "sse") {
    return { wire: formatSseData("[DONE]"), id: null, binary: false };
  }
  if (config.protocol === "chunked") {
    if (config.chunkedFormat === "ndjson") {
      return { wire: '{"done":true}\n', id: null, binary: false };
    }
    return { wire: "[DONE]", id: null, binary: false };
  }
  if (config.wsFormat === "json") {
    return { wire: '{"done":true}', id: null, binary: false };
  }
  if (config.wsFormat === "binary") {
    return { wire: "[DONE]", id: null, binary: true };
  }
  return { wire: "[DONE]", id: null, binary: false };
}

function heartbeatChunk(config: StreamMockConfig): string | null {
  if (config.heartbeatMs === null) {
    return null;
  }
  if (config.protocol === "websocket" && config.wsHeartbeat === "protocol") {
    return null;
  }
  if (config.protocol === "sse") {
    return ": keepalive\n\n";
  }
  if (config.protocol === "chunked") {
    return "\n";
  }
  if (config.wsFormat === "json") {
    return '{"type":"ping"}';
  }
  return "ping";
}

function sequenceEnvelope(wire: string, seq: number, t: number): string {
  const trimmed = wire.endsWith("\n") ? wire.slice(0, -1) : wire;
  let data: unknown = trimmed;
  try {
    data = JSON.parse(trimmed);
  } catch {
    data = trimmed;
  }
  return JSON.stringify({ seq, t, data });
}

function applySequence(chunks: PlannedChunk[], config: StreamMockConfig, intervalMs: number): PlannedChunk[] {
  if (!config.sequence || config.protocol === "sse") {
    return chunks;
  }
  if (config.protocol === "chunked" && config.chunkedFormat === "text") {
    return chunks;
  }
  return chunks.map((chunk, index) => {
    const wrapped = sequenceEnvelope(chunk.wire, index + 1, index * intervalMs);
    const newline = config.protocol === "chunked" ? "\n" : "";
    return { ...chunk, wire: `${wrapped}${newline}`, binary: false };
  });
}

function paceIntervalMs(config: StreamMockConfig, chunkCount: number): number {
  if (config.tickHz !== null && config.tickHz > 0) {
    return Math.max(1, Math.round(1000 / config.tickHz));
  }
  if (chunkCount <= 1) {
    return Math.max(1, config.durationMs);
  }
  return Math.max(1, Math.floor(config.durationMs / (chunkCount - 1)));
}

/**
 * Split `payload` by `chunkMode`, then frame each piece for SSE, WebSocket, or chunked HTTP.
 * Drop percent is applied as a complete-chunk cutoff so JSON/line messages stay intact.
 * `lastEventId` is the SSE `Last-Event-ID` header; it is ignored unless `resume` is on.
 */
export function planStream(config: StreamMockConfig, lastEventId: string | null = null): StreamPlan {
  const source = config.payload.storage === "inline" ? config.payload.body : "";
  const semantics = splitPayload(source, config);
  const framed = semantics.map((item, index) => frameChunk(item, config, index, semantics.length));
  if (config.protocol === "sse" && config.sseFormat === "anthropic" && semantics.length > 0) {
    framed.unshift(anthropicPreamble());
  }
  const resumed = prependRetry(applyResume(framed, config, lastEventId), config);
  const intervalMs = paceIntervalMs(config, resumed.length);
  const chunks = applySequence(resumed, config, intervalMs);
  const dropAfterChunks =
    config.dropConnectionAtPercent === null
      ? null
      : Math.max(0, Math.ceil((chunks.length * config.dropConnectionAtPercent) / 100));

  const heartbeatMs = config.heartbeatMs;
  const protocolPing =
    config.protocol === "websocket" && config.wsHeartbeat === "protocol" && heartbeatMs !== null && heartbeatMs > 0;

  return {
    chunks,
    intervalMs,
    dropAfterChunks,
    trailer: doneTrailer(config),
    heartbeatMs,
    heartbeatChunk: heartbeatChunk(config),
    heartbeatProtocol: protocolPing,
    initialDelayMs: Math.max(0, config.initialDelayMs),
    repeat: dropAfterChunks === null ? config.repeat : "once",
    closeCode: isStreamCloseCode(config.closeCode) ? config.closeCode : 1000,
    closeReason: config.closeReason,
  };
}

function isStreamProtocol(value: unknown): value is StreamDocument["protocol"] {
  return value === "sse" || value === "websocket" || value === "chunked";
}

/**
 * Fill delivery defaults so a Redis document written before a field existed
 * still plans. Returns null when the document is not a stream config.
 */
export function normalizeStreamDocument(value: unknown): StreamDocument | null {
  if (!isRecord(value) || !isStreamProtocol(value["protocol"])) {
    return null;
  }
  const defaults = defaultStreamDelivery();
  const payload = value["payload"];
  const body =
    isRecord(payload) && typeof payload["body"] === "string" ? payload["body"] : "";
  const storage =
    isRecord(payload) && typeof payload["storage"] === "string" ? payload["storage"] : "inline";
  const duration = value["durationMs"];
  return {
    ...defaults,
    id: typeof value["id"] === "string" ? value["id"] : "",
    workspaceId: typeof value["workspaceId"] === "string" ? value["workspaceId"] : "",
    path: typeof value["path"] === "string" ? value["path"] : "/",
    protocol: value["protocol"],
    sourceType: value["sourceType"] === "dataset" ? "dataset" : "custom",
    datasetId: typeof value["datasetId"] === "string" ? value["datasetId"] : null,
    payload: { storage, body },
    durationMs: typeof duration === "number" && Number.isFinite(duration) ? duration : 1000,
    dropConnectionAtPercent:
      typeof value["dropConnectionAtPercent"] === "number" ? value["dropConnectionAtPercent"] : null,
    chunkMode: isStreamChunkMode(value["chunkMode"]) ? value["chunkMode"] : defaults.chunkMode,
    chunkSize: typeof value["chunkSize"] === "number" ? value["chunkSize"] : null,
    sseFormat: isStreamSseFormat(value["sseFormat"]) ? value["sseFormat"] : defaults.sseFormat,
    wsFormat: isStreamWsFormat(value["wsFormat"]) ? value["wsFormat"] : defaults.wsFormat,
    chunkedFormat: isStreamChunkedFormat(value["chunkedFormat"]) ? value["chunkedFormat"] : defaults.chunkedFormat,
    tickHz: typeof value["tickHz"] === "number" ? value["tickHz"] : null,
    sequence: value["sequence"] === true,
    sseEventName: typeof value["sseEventName"] === "string" ? value["sseEventName"] : null,
    eventIds: value["eventIds"] === true,
    sendDone: value["sendDone"] === true,
    heartbeatMs: typeof value["heartbeatMs"] === "number" ? value["heartbeatMs"] : null,
    initialDelayMs: typeof value["initialDelayMs"] === "number" ? value["initialDelayMs"] : 0,
    retryMs: typeof value["retryMs"] === "number" ? value["retryMs"] : null,
    resume: value["resume"] === true,
    repeat: isStreamRepeat(value["repeat"]) ? value["repeat"] : defaults.repeat,
    closeCode: typeof value["closeCode"] === "number" ? value["closeCode"] : defaults.closeCode,
    closeReason: typeof value["closeReason"] === "string" ? value["closeReason"] : defaults.closeReason,
    subprotocols: Array.isArray(value["subprotocols"])
      ? value["subprotocols"].filter((item): item is string => typeof item === "string")
      : [],
    echo: value["echo"] === true,
    wsHeartbeat: isStreamWsHeartbeat(value["wsHeartbeat"]) ? value["wsHeartbeat"] : defaults.wsHeartbeat,
  };
}
