/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

const KEEPALIVE_MS = 15_000;

/** Active SSE clients for the remote MCP transport. */
export class SessionManager {
  private readonly sessions = new Map<string, ServerResponse>();

  open(raw: ServerResponse, messagesPath: string): string {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, raw);

    const keepalive = setInterval(() => {
      if (raw.destroyed || raw.writableEnded) {
        clearInterval(keepalive);
        this.sessions.delete(sessionId);
        return;
      }
      raw.write(": keepalive\n\n");
    }, KEEPALIVE_MS);

    const drop = (): void => {
      clearInterval(keepalive);
      this.sessions.delete(sessionId);
    };
    raw.on("close", drop);
    raw.on("error", drop);

    const endpoint = `${messagesPath}?sessionId=${encodeURIComponent(sessionId)}`;
    raw.write(`event: endpoint\ndata: ${endpoint}\n\n`);
    return sessionId;
  }

  has(sessionId: string): boolean {
    const raw = this.sessions.get(sessionId);
    if (raw === undefined) {
      return false;
    }
    if (raw.destroyed || raw.writableEnded) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  emit(sessionId: string, payload: unknown): boolean {
    const raw = this.sessions.get(sessionId);
    if (raw === undefined || raw.destroyed || raw.writableEnded) {
      this.sessions.delete(sessionId);
      return false;
    }
    raw.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  }
}
