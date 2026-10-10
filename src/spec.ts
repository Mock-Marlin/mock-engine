/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { load } from "js-yaml";

import { saveDraft } from "./app/admin.js";
import { describeRef, draftFromRecord, refOf, sameRef, type MockDraft, type MockRef } from "./app/draft.js";
import { PROTO_FILE_NAME, SPEC_FILENAMES, WORKSPACE_NAME } from "./constants.js";
import type { ImportedEndpoint } from "./import/types.js";
import { writeImportedRestMocks } from "./import/write.js";
import type { KeyLayout } from "./keys.js";
import { SpecError, type MockSpec, type SpecProto } from "./spec-types.js";
import type { MockStore } from "./store.js";

export { SPEC_FILENAMES, SPEC_TEMPLATE } from "./constants.js";
export { SpecError } from "./spec-types.js";
export type { MockSpec, SpecProto } from "./spec-types.js";

const KNOWN_FIELDS = new Set(["version", "workspace", "imports", "mocks", "protos"]);

/**
 * `mock-engine.yaml` or `mock-engine.yml` in `directory`.
 * Both names at once is an error. Neither name returns null.
 */
export async function discoverSpecFile(directory: string = process.cwd()): Promise<string | null> {
  const yamlName = SPEC_FILENAMES[0];
  const ymlName = SPEC_FILENAMES[1];
  const yaml = path.join(directory, yamlName);
  const yml = path.join(directory, ymlName);
  const hasYaml = existsSync(yaml);
  const hasYml = existsSync(yml);
  if (hasYaml && hasYml) {
    throw new SpecError(directory, "", `found both ${yamlName} and ${ymlName}`);
  }
  if (hasYaml) {
    return yaml;
  }
  if (hasYml) {
    return yml;
  }
  return null;
}

/** Read a spec file. Paths inside it resolve from the file's directory. */
export async function loadSpecFile(filePath: string): Promise<MockSpec> {
  const absolute = path.resolve(filePath);
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch {
    throw new SpecError(absolute, "", "file not found");
  }
  return parseSpec(text, absolute);
}

/** Parse spec text. `filePath` is used in errors and as the base for relative paths. */
export async function parseSpec(text: string, filePath: string): Promise<MockSpec> {
  const absolute = path.resolve(filePath);
  let parsed: unknown;
  try {
    parsed = load(text);
  } catch (error: unknown) {
    throw new SpecError(absolute, "", (error as Error).message);
  }
  if (!isRecord(parsed)) {
    throw new SpecError(absolute, "", "must be a YAML object");
  }
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_FIELDS.has(key)) {
      throw new SpecError(absolute, key, "unknown field");
    }
  }
  if (parsed["version"] !== 1) {
    throw new SpecError(absolute, "version", "must be 1");
  }
  const workspace = workspaceField(absolute, parsed["workspace"]);
  const imports = await importFields(absolute, parsed["imports"]);
  const mocks = mockFields(absolute, parsed["mocks"]);
  const protos = await protoFields(absolute, parsed["protos"]);
  assertGrpcProtos(absolute, mocks, protos);
  return { filePath: absolute, version: 1, workspace, imports, mocks, protos };
}

/**
 * Write a spec into a workspace that has already been cleared.
 * Import files are written first. Explicit mocks replace an imported route with the same method and path.
 * Returns the number of imported REST rows plus mock entries.
 */
export async function applySpec(
  store: MockStore,
  keys: KeyLayout,
  workspace: string,
  spec: MockSpec,
  imported: readonly ImportedEndpoint[],
): Promise<number> {
  let count = 0;
  if (imported.length > 0) {
    count += await writeImportedRestMocks(store, workspace, imported, keys);
  }
  for (const draft of spec.mocks) {
    await saveDraft(store, keys, workspace, draft, "replace");
    count += 1;
  }
  if (spec.protos.length > 0) {
    await store.set(
      keys.grpcSchema(workspace),
      JSON.stringify({
        files: spec.protos.map((file) => ({ name: file.name, content: file.content })),
      }),
    );
  }
  return count;
}

/** Routes a spec would serve, one per line. `imported` rows are listed after the mocks. */
export function formatSpecReport(spec: MockSpec, imported: readonly { method: string; path: string }[] = []): string {
  const lines = [`workspace ${spec.workspace}`];
  for (const draft of spec.mocks) {
    lines.push(describeRef(refOf(draft)));
  }
  for (const row of imported) {
    lines.push(`${row.method} ${row.path}`);
  }
  if (lines.length === 1) {
    lines.push("(no routes)");
  }
  return lines.join("\n");
}

function workspaceField(filePath: string, value: unknown): string {
  if (value === undefined) {
    return "default";
  }
  if (typeof value !== "string" || !WORKSPACE_NAME.test(value)) {
    throw new SpecError(filePath, "workspace", "must use letters, numbers, dots, underscores, and dashes");
  }
  return value;
}

async function importFields(filePath: string, value: unknown): Promise<string[]> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new SpecError(filePath, "imports", "must be a list of paths");
  }
  const directory = path.dirname(filePath);
  const imports: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new SpecError(filePath, `imports[${String(index)}]`, "must be a path");
    }
    const resolved = path.resolve(directory, item.trim());
    try {
      await stat(resolved);
    } catch {
      throw new SpecError(filePath, `imports[${String(index)}]`, `not found: ${resolved}`);
    }
    imports.push(resolved);
  }
  return imports;
}

function mockFields(filePath: string, value: unknown): MockDraft[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new SpecError(filePath, "mocks", "must be a list");
  }
  const mocks: MockDraft[] = [];
  const seen: MockRef[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const field = `mocks[${String(index)}]`;
    let draft: MockDraft;
    try {
      draft = draftFromRecord(value[index]);
    } catch (error: unknown) {
      throw new SpecError(filePath, field, (error as Error).message);
    }
    const ref = refOf(draft);
    if (seen.some((item) => sameRef(item, ref))) {
      throw new SpecError(filePath, field, `repeats ${describeRef(ref)}`);
    }
    seen.push(ref);
    mocks.push(draft);
  }
  return mocks;
}

async function protoFields(filePath: string, value: unknown): Promise<SpecProto[]> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new SpecError(filePath, "protos", "must be a list");
  }
  const directory = path.dirname(filePath);
  const protos: SpecProto[] = [];
  const names = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const field = `protos[${String(index)}]`;
    const item = value[index];
    if (!isRecord(item)) {
      throw new SpecError(filePath, field, "must be an object");
    }
    const name = item["name"];
    if (typeof name !== "string" || !PROTO_FILE_NAME.test(name)) {
      throw new SpecError(filePath, `${field}.name`, "must be a file name ending in .proto");
    }
    if (names.has(name)) {
      throw new SpecError(filePath, `${field}.name`, `repeats ${name}`);
    }
    names.add(name);
    protos.push({ name, content: await protoContent(filePath, field, directory, item) });
  }
  return protos;
}

async function protoContent(
  filePath: string,
  field: string,
  directory: string,
  item: Record<string, unknown>,
): Promise<string> {
  const hasFile = item["file"] !== undefined;
  const hasContent = item["content"] !== undefined;
  if (hasFile === hasContent) {
    throw new SpecError(filePath, field, hasFile ? "use file or content, not both" : "file or content is required");
  }
  if (hasContent) {
    const content = item["content"];
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new SpecError(filePath, `${field}.content`, "must be proto source");
    }
    return content;
  }
  const file = item["file"];
  if (typeof file !== "string" || file.trim().length === 0) {
    throw new SpecError(filePath, `${field}.file`, "must be a path");
  }
  const resolved = path.resolve(directory, file.trim());
  try {
    return await readFile(resolved, "utf8");
  } catch {
    throw new SpecError(filePath, `${field}.file`, `not found: ${resolved}`);
  }
}

function assertGrpcProtos(filePath: string, mocks: readonly MockDraft[], protos: readonly SpecProto[]): void {
  for (let index = 0; index < mocks.length; index += 1) {
    const draft = mocks[index] as MockDraft;
    if (draft.kind !== "grpc") {
      continue;
    }
    const declared = protos.some((file) => protoDeclaresService(file.content, draft.service));
    if (!declared) {
      throw new SpecError(filePath, `mocks[${String(index)}]`, `protos do not declare ${draft.service}`);
    }
  }
}

function protoDeclaresService(content: string, service: string): boolean {
  const dot = service.lastIndexOf(".");
  const short = dot === -1 ? service : service.slice(dot + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(short)) {
    return false;
  }
  return new RegExp(`\\bservice\\s+${short}\\b`).test(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
