/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

/** Process-wide cap on sockets held open by hang faults and streams. */
const MAX_HELD_SOCKETS = 64;

let held = 0;

export function acquireHeldSocket(): boolean {
  if (held >= MAX_HELD_SOCKETS) {
    return false;
  }
  held += 1;
  return true;
}

export function releaseHeldSocket(): void {
  if (held > 0) {
    held -= 1;
  }
}
