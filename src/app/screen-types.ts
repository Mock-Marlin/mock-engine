/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { ServedMock } from "./catalog-types.js";

/** One finished HTTP response or native gRPC call. */
export interface TrafficEvent {
  at: number;
  kind: "http" | "grpc";
  method: string;
  target: string;
  status: string;
  durationMs: number;
}

/** Data drawn by the local server screen. */
export interface ScreenModel {
  storeKind: string;
  httpUrl: string;
  grpcUrl: string;
  grpcServices: number;
  startedAt: number;
  now: number;
  mocks: readonly ServedMock[];
  mockOffset: number;
  events: readonly TrafficEvent[];
  totalRequests: number;
  hint?: string;
}
