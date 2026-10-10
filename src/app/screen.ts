/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { ScreenModel, TrafficEvent } from "./screen-types.js";

export type { ScreenModel, TrafficEvent } from "./screen-types.js";

interface Segment {
  text: string;
  color?: string;
}

/**
 * One frame of the local server view.
 * Each returned line is `columns - 1` visible characters, so a terminal does not wrap it.
 */
export function renderScreen(model: ScreenModel, columns: number, rows: number, color: boolean): string {
  const width = Math.max(20, columns - 1);
  const height = Math.max(8, rows);
  const footer = 1;
  const header = 5;
  const body = height - header - footer;
  const requestBlock = Math.min(14, Math.max(3, Math.floor(body * 0.45)));
  const mockBlock = body - requestBlock;
  const mockRows = Math.max(0, mockBlock - 2);
  const requestRows = Math.max(0, requestBlock - 2);
  const offset = clampOffset(model.mockOffset, model.mocks.length, mockRows);
  const visibleMocks = model.mocks.slice(offset, offset + mockRows);
  const hiddenAbove = offset > 0;
  const hiddenBelow = offset + visibleMocks.length < model.mocks.length;
  const visibleEvents = model.events.slice(-requestRows);

  const lines: string[] = [];
  lines.push(rule(width, " mock-engine ", color));
  lines.push(
    segments(
      [
        { text: "  http   ", color: "2" },
        { text: fit(model.httpUrl, width - 9) },
      ],
      width,
      color,
    ),
  );
  const grpcNote = model.grpcServices === 0 ? "no services" : `${String(model.grpcServices)} service${model.grpcServices === 1 ? "" : "s"}`;
  const grpcText = `${model.grpcUrl}   ${grpcNote}`;
  lines.push(
    segments(
      [
        { text: "  grpc   ", color: "2" },
        { text: fit(grpcText, width - 9) },
      ],
      width,
      color,
    ),
  );
  const meta = `${model.storeKind}   up ${uptime(model.now - model.startedAt)}   ${String(model.totalRequests)} request${model.totalRequests === 1 ? "" : "s"}`;
  lines.push(segments([{ text: "  " }, { text: fit(meta, width - 2), color: "2" }], width, color));
  lines.push(rule(width, mockTitle(model.mocks.length, hiddenAbove, hiddenBelow), color));

  if (mockRows > 0) {
    lines.push(columnsLine(["METHOD", "KIND", "TARGET"], [8, 12, 0], width, "2", color));
    if (visibleMocks.length === 0) {
      lines.push(segments([{ text: "  " }, { text: fit("nothing served yet", width - 2), color: "2" }], width, color));
      for (let index = 1; index < mockRows; index += 1) {
        lines.push(blank(width));
      }
    } else {
      for (const mock of visibleMocks) {
        lines.push(columnsLine([mock.method, mock.kind, mock.target], [8, 12, 0], width, undefined, color));
      }
      for (let index = visibleMocks.length; index < mockRows; index += 1) {
        lines.push(blank(width));
      }
    }
  }

  lines.push(rule(width, ` requests  ${String(model.totalRequests)} `, color));
  if (requestRows > 0) {
    lines.push(columnsLine(["TIME", "STATUS", "METHOD", "TARGET", "MS"], [8, 8, 7, 0, 6], width, "2", color));
    if (visibleEvents.length === 0) {
      lines.push(segments([{ text: "  " }, { text: fit("waiting for traffic", width - 2), color: "2" }], width, color));
      for (let index = 1; index < requestRows; index += 1) {
        lines.push(blank(width));
      }
    } else {
      for (let index = visibleEvents.length; index < requestRows; index += 1) {
        lines.push(blank(width));
      }
      for (const event of visibleEvents) {
        lines.push(requestLine(event, width, color));
      }
    }
  }

  while (lines.length < height - 1) {
    lines.push(blank(width));
  }
  const footerLine = model.hint === undefined ? "  j/k scroll mocks    q quit" : `  j/k scroll mocks    q quit    ${model.hint}`;
  lines.push(segments([{ text: footerLine, color: "2" }], width, color));
  return lines.slice(0, height).join("\n");
}

export function formatTrafficLine(event: TrafficEvent): string {
  return `${clock(event.at)}  ${event.status.padEnd(8)} ${event.method.padEnd(7)} ${event.target}  ${String(event.durationMs)}ms`;
}

function mockTitle(count: number, above: boolean, below: boolean): string {
  const more = above || below ? "  j/k" : "";
  return ` mocks  ${String(count)}${more} `;
}

function clampOffset(offset: number, count: number, window: number): number {
  if (window <= 0 || count <= window) {
    return 0;
  }
  const max = count - window;
  if (offset < 0) {
    return 0;
  }
  return offset > max ? max : offset;
}

function statusColor(status: string): string {
  if (status === "OK" || /^2\d\d$/.test(status)) {
    return "32";
  }
  if (/^3\d\d$/.test(status)) {
    return "36";
  }
  if (status === "NOT_FOUND" || /^4\d\d$/.test(status)) {
    return "33";
  }
  return "31";
}

function requestLine(event: TrafficEvent, width: number, enabled: boolean): string {
  const pieces = rowPieces(
    [clock(event.at), event.status, event.method, event.target, String(event.durationMs)],
    [8, 8, 7, 0, 6],
    width,
  );
  return segments(
    [
      { text: `${pieces[0] ?? ""}${pieces[1] ?? ""}${pieces[2] ?? ""}` },
      { text: pieces[3] ?? "", color: statusColor(event.status) },
      { text: pieces.slice(4).join("") },
    ],
    width,
    enabled,
  );
}

function columnsLine(
  cells: readonly string[],
  widths: readonly number[],
  width: number,
  color: string | undefined,
  enabled: boolean,
): string {
  const text = rowPieces(cells, widths, width).join("");
  return segments([{ text, ...(color === undefined ? {} : { color }) }], width, enabled);
}

function rowPieces(cells: readonly string[], widths: readonly number[], width: number): string[] {
  const fixed = widths.reduce((sum, column) => sum + (column > 0 ? column : 0), 0);
  const gaps = Math.max(0, cells.length - 1);
  const flex = Math.max(1, width - 2 - fixed - gaps);
  const pieces = ["  "];
  cells.forEach((cell, index) => {
    if (index > 0) {
      pieces.push(" ");
    }
    const column = widths[index] ?? 0;
    pieces.push(fit(cell, column === 0 ? flex : column));
  });
  return pieces;
}

function segments(parts: readonly Segment[], width: number, enabled: boolean): string {
  let used = 0;
  let out = "";
  for (const part of parts) {
    const room = width - used;
    if (room <= 0) {
      break;
    }
    const text = part.text.slice(0, room);
    used += text.length;
    out += enabled && part.color !== undefined ? `\x1b[${part.color}m${text}\x1b[0m` : text;
  }
  if (used < width) {
    out += " ".repeat(width - used);
  }
  return out;
}

function rule(width: number, title: string, enabled: boolean): string {
  const label = `─${title}`;
  const body = label.length >= width ? label.slice(0, width) : label + "─".repeat(width - label.length);
  return segments([{ text: body, color: "36" }], width, enabled);
}

function blank(width: number): string {
  return " ".repeat(width);
}

function fit(text: string, width: number): string {
  if (text.length <= width) {
    return text.padEnd(width);
  }
  if (width === 1) {
    return "…";
  }
  return `${text.slice(0, width - 1)}…`;
}

function clock(ms: number): string {
  const date = new Date(ms);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function uptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}
