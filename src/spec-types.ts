/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import type { MockDraft } from "./app/draft-types.js";

/** Thrown when a spec is missing, both filenames exist, or a field is invalid. */
export class SpecError extends Error {
  readonly filePath: string;
  readonly field: string;

  constructor(filePath: string, field: string, detail: string) {
    super(field.length > 0 ? `${filePath}: ${field}: ${detail}` : `${filePath}: ${detail}`);
    this.name = "SpecError";
    this.filePath = filePath;
    this.field = field;
  }
}

/** One proto file written into the workspace gRPC schema. */
export interface SpecProto {
  name: string;
  content: string;
}

/** A parsed spec. Every path is absolute and resolved from the file's directory. */
export interface MockSpec {
  filePath: string;
  version: 1;
  workspace: string;
  imports: string[];
  mocks: MockDraft[];
  protos: SpecProto[];
}
