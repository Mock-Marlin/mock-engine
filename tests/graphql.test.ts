/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeSdl, operationFrom, subscribeSdl } from "../src/graphql/execute.js";
import { graphqlPlaygroundHtml } from "../src/graphql/playground.js";
import { handleGraphqlSocket, type GraphqlSocketResult } from "../src/graphql/ws.js";

const SDL = "type Query { hello: String }";

interface FakeSocket {
  readyState: number;
  sent: string[];
  closed: { code?: number | undefined; reason?: string | undefined } | null;
  failSend: boolean;
  failClose: boolean;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error", listener: (...args: any[]) => void): void;
  emit(event: "message" | "close" | "error", ...args: unknown[]): void;
}

function fakeSocket(): FakeSocket {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const socket: FakeSocket = {
    readyState: 1,
    sent: [],
    closed: null,
    failSend: false,
    failClose: false,
    send(data: string): void {
      if (socket.failSend) {
        throw new Error("send failed");
      }
      socket.sent.push(data);
    },
    close(code?: number, reason?: string): void {
      if (socket.failClose) {
        throw new Error("close failed");
      }
      socket.closed = { code, reason };
      socket.readyState = 3;
    },
    on(event, listener): void {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    emit(event, ...args): void {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
  };
  return socket;
}

async function push(socket: FakeSocket, message: unknown, isBinary = false): Promise<void> {
  const data = typeof message === "string" ? message : JSON.stringify(message);
  socket.emit("message", data, isBinary);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("GraphQL execution", () => {
  it("reads an operation from a string, an object, or nothing", () => {
    expect(operationFrom("{ hello }").query).toBe("{ hello }");
    expect(operationFrom(1).query).toBe("");
    expect(operationFrom({ query: 1 }).query).toBe("");
    const parsed = operationFrom({
      query: "query Named { hello }",
      variables: '{"id":1}',
      operationName: " Named ",
    });
    expect(parsed.variables).toEqual({ id: 1 });
    expect(parsed.operationName).toBe("Named");
    expect(operationFrom({ query: "{ hello }", variables: "not-json" }).variables).toBeUndefined();
    expect(operationFrom({ query: "{ hello }", variables: "[]" }).variables).toBeUndefined();
    expect(operationFrom({ query: "{ hello }", variables: null }).variables).toBeUndefined();
    expect(operationFrom({ query: "{ hello }", variables: { id: 2 } }).variables).toEqual({ id: 2 });
  });

  it("executes a query and reports a broken schema", async () => {
    const ok = await executeSdl(SDL, { query: "{ hello }" });
    expect(ok).toHaveProperty("data");
    const broken = await executeSdl("type Query {", { query: "{ hello }" });
    expect(broken).toMatchObject({ data: null, errors: [{ message: expect.any(String) }] });
  });

  it("collects a mocked subscription and reports a parse failure", async () => {
    const envelopes = await subscribeSdl("type Query { hello: String } type Subscription { tick: String }", {
      query: "subscription Named { tick }",
      operationName: "Named",
      variables: { unused: true },
    });
    expect(envelopes.length).toBeGreaterThan(0);
    const failed = await subscribeSdl(SDL, { query: "subscription {" });
    expect(failed[0]).toMatchObject({ data: null });
  });

  it("escapes the playground endpoint", () => {
    const html = graphqlPlaygroundHtml('/s/acme/"<q>&');
    expect(html).toContain("/s/acme/&quot;&lt;q>&amp;");
    expect(html).toContain("graphql-transport-ws");
  });
});

describe("graphql-transport-ws", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("acknowledges the connection, answers a subscribe, and ignores a second ack", async () => {
    const socket = fakeSocket();
    handleGraphqlSocket(socket, async () => ({
      delayMs: 0,
      envelopes: [{ data: { hello: "there" } }],
    }));
    await push(socket, { type: "ping" });
    expect(socket.sent.at(-1)).toContain('"pong"');
    await push(socket, { type: "connection_init" });
    expect(socket.sent.at(-1)).toContain("connection_ack");
    await push(socket, { type: "ping" });
    await push(socket, { type: "pong" });
    await push(socket, { type: "connection_ack" });
    await push(socket, { id: "1", type: "subscribe", payload: { query: "{ hello }" } });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(socket.sent.some((frame) => frame.includes('"next"'))).toBe(true);
    expect(socket.sent.some((frame) => frame.includes('"complete"'))).toBe(true);
  });

  it("closes on a bad handshake, bad frames, and a duplicate subscribe", async () => {
    const early = fakeSocket();
    handleGraphqlSocket(early, async () => ({ delayMs: 0, envelopes: [] }));
    await push(early, { type: "subscribe" });
    expect(early.closed?.code).toBe(4401);

    const binary = fakeSocket();
    handleGraphqlSocket(binary, async () => ({ delayMs: 0, envelopes: [] }));
    binary.emit("message", Buffer.from("x"), true);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(binary.closed?.code).toBe(4400);

    const weird = fakeSocket();
    handleGraphqlSocket(weird, async () => ({ delayMs: 0, envelopes: [] }));
    weird.emit("message", 1, false);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(weird.closed?.code).toBe(4400);

    const invalid = fakeSocket();
    handleGraphqlSocket(invalid, async () => ({ delayMs: 0, envelopes: [] }));
    await push(invalid, "{");
    expect(invalid.closed?.code).toBe(4400);

    const shape = fakeSocket();
    handleGraphqlSocket(shape, async () => ({ delayMs: 0, envelopes: [] }));
    await push(shape, { hello: true });
    expect(shape.closed?.code).toBe(4400);

    const socket = fakeSocket();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    handleGraphqlSocket(socket, async (): Promise<GraphqlSocketResult> => {
      await gate;
      return { delayMs: 5, envelopes: [{ data: null }] };
    });
    await push(socket, { type: "connection_init" });
    await push(socket, { id: "1", type: "subscribe", payload: {} });
    await push(socket, { id: "1", type: "subscribe", payload: {} });
    expect(socket.closed?.code).toBe(4409);

    const again = fakeSocket();
    handleGraphqlSocket(again, async () => ({ delayMs: 0, envelopes: [] }));
    await push(again, { type: "connection_init" });
    await push(again, { type: "connection_init" });
    expect(again.closed?.code).toBe(4429);

    const missing = fakeSocket();
    handleGraphqlSocket(missing, async () => ({ delayMs: 0, envelopes: [] }));
    await push(missing, { type: "connection_init" });
    await push(missing, { type: "subscribe", payload: {} });
    expect(missing.closed?.code).toBe(4400);

    const unknown = fakeSocket();
    handleGraphqlSocket(unknown, async () => ({ delayMs: 0, envelopes: [] }));
    await push(unknown, { type: "connection_init" });
    await push(unknown, { id: "1", type: "other" });
    expect(unknown.closed?.code).toBe(4400);
    release?.();
  });

  it("aborts an in-flight subscribe and reports a runner failure", async () => {
    const socket = fakeSocket();
    let started: (() => void) | undefined;
    const startedGate = new Promise<void>((resolve) => {
      started = resolve;
    });
    handleGraphqlSocket(socket, async () => {
      started?.();
      return { delayMs: 30, envelopes: [{ data: { hello: "late" } }] };
    });
    await push(socket, { type: "connection_init" });
    socket.emit("message", JSON.stringify({ id: "1", type: "subscribe", payload: {} }), false);
    await startedGate;
    await push(socket, { id: "1", type: "complete" });
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    expect(socket.sent.some((frame) => frame.includes('"next"'))).toBe(false);

    const failing = fakeSocket();
    handleGraphqlSocket(failing, async () => {
      throw new Error("boom");
    });
    await push(failing, { type: "connection_init" });
    await push(failing, { id: "2", type: "subscribe", payload: {} });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(failing.sent.some((frame) => frame.includes("boom"))).toBe(true);

    const closed = fakeSocket();
    handleGraphqlSocket(closed, async () => ({ delayMs: 0, envelopes: [{ data: null }] }));
    await push(closed, { type: "connection_init" });
    closed.emit("close");
    await push(closed, { id: "3", type: "subscribe", payload: {} });
    expect(closed.sent.filter((frame) => frame.includes('"next"'))).toHaveLength(0);

    const broken = fakeSocket();
    handleGraphqlSocket(broken, async () => ({ delayMs: 0, envelopes: [] }));
    broken.emit("error");
    broken.failClose = true;
    await push(broken, { type: "connection_init" });
  });

  it("times out when connection_init never arrives", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    handleGraphqlSocket(socket, async () => ({ delayMs: 0, envelopes: [] }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.closed?.code).toBe(4408);
  });

  it("waits for a delayed envelope and stops when the client completes mid-stream", async () => {
    vi.useFakeTimers();
    const delayed = fakeSocket();
    handleGraphqlSocket(delayed, async () => ({ delayMs: 25, envelopes: [{ data: { hello: "late" } }] }));
    delayed.emit("message", JSON.stringify({ type: "connection_init" }), false);
    await vi.advanceTimersByTimeAsync(0);
    delayed.emit("message", JSON.stringify({ id: "1", type: "subscribe", payload: {} }), false);
    await vi.advanceTimersByTimeAsync(25);
    expect(delayed.sent.some((frame) => frame.includes("late"))).toBe(true);
    vi.useRealTimers();

    const socket = fakeSocket();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    handleGraphqlSocket(socket, async () => ({
      delayMs: 0,
      envelopes: (async function* frames(): AsyncGenerator<unknown> {
        yield { data: { n: 1 } };
        await gate;
        yield { data: { n: 2 } };
      })(),
    }));
    await push(socket, { type: "connection_init" });
    socket.emit("message", JSON.stringify({ id: "1", type: "subscribe", payload: {} }), false);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    await push(socket, { id: "1", type: "complete" });
    release?.();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(socket.sent.filter((frame) => frame.includes('"next"'))).toHaveLength(1);

    const closing = fakeSocket();
    let started: (() => void) | undefined;
    const startedGate = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: (() => void) | undefined;
    const finishGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    handleGraphqlSocket(closing, async () => {
      started?.();
      await finishGate;
      return { delayMs: 0, envelopes: [{ data: { n: 1 } }] };
    });
    await push(closing, { type: "connection_init" });
    closing.emit("message", JSON.stringify({ id: "9", type: "subscribe", payload: {} }), false);
    await startedGate;
    closing.emit("close");
    finish?.();

    const failing = fakeSocket();
    let errored: (() => void) | undefined;
    const erroredGate = new Promise<void>((resolve) => {
      errored = resolve;
    });
    handleGraphqlSocket(failing, async () => {
      errored?.();
      await new Promise(() => undefined);
      return { delayMs: 0, envelopes: [] };
    });
    await push(failing, { type: "connection_init" });
    failing.emit("message", JSON.stringify({ id: "8", type: "subscribe", payload: {} }), false);
    await erroredGate;
    failing.emit("error");
  });

  it("ignores sends after the socket is no longer open", async () => {
    const socket = fakeSocket();
    handleGraphqlSocket(socket, async () => ({ delayMs: 0, envelopes: [{ data: null }] }));
    await push(socket, { type: "connection_init" });
    socket.readyState = 3;
    await push(socket, { id: "1", type: "subscribe", payload: {} });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(socket.sent.some((frame) => frame.includes('"next"'))).toBe(false);
    socket.failSend = true;
    socket.readyState = 1;
    await push(socket, { type: "ping" });
  });
});
