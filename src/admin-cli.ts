/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import type { ClashPolicy, ImportResult, SaveResult } from "./app/admin.js";
import { commandHelp, parseClientLine, refLabel, type ClientCommand } from "./app/client-command.js";
import { BLANK_DRAFT, draftToYaml, yamlToDraft, type MockDraft, type MockRef } from "./app/draft.js";
import { collectImportFiles } from "./app/serve.js";
import { DEFAULT_HOST, DEFAULT_HTTP_PORT } from "./constants.js";

interface ClientSession {
  url: string;
  workspace: string;
  interactive: boolean;
}

export async function runClient(argv: readonly string[]): Promise<void> {
  const options = splitArgs(argv);
  const session: ClientSession = {
    url: options.url,
    workspace: options.workspace ?? "default",
    interactive: options.command.length === 0 && input.isTTY === true,
  };
  await ping(session.url);
  if (options.command.length === 0) {
    if (!session.interactive) {
      output.write(`${commandHelp()}\n`);
      return;
    }
    output.write(banner(session));
    for (;;) {
      const line = await ask(`${session.workspace}> `);
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const command = parseClientLine(line);
        if (command.type === "quit") {
          return;
        }
        await dispatch(session, command);
      } catch (error: unknown) {
        output.write(`${messageOf(error)}\n`);
      }
    }
  }
  await dispatch(session, parseClientLine(options.command));
}

async function dispatch(session: ClientSession, command: ClientCommand): Promise<void> {
  if (command.type === "help") {
    output.write(`${commandHelp()}\n`);
    return;
  }
  if (command.type === "quit") {
    return;
  }
  if (command.type === "workspaces") {
    const names = await workspaces(session.url);
    output.write(names.length === 0 ? "No workspaces yet.\n" : `${names.join("\n")}\n`);
    return;
  }
  if (command.type === "use") {
    const names = await workspaces(session.url);
    if (!names.includes(command.name)) {
      throw new Error(`No workspace named ${command.name}. Create it with new ${command.name}`);
    }
    session.workspace = command.name;
    output.write(`Using ${command.name}\n`);
    return;
  }
  if (command.type === "new") {
    await request(session.url, "/_admin/workspaces", { method: "POST", body: JSON.stringify({ name: command.name }) });
    session.workspace = command.name;
    output.write(`Created ${command.name}\n`);
    return;
  }
  if (command.type === "remove-workspace") {
    if (session.interactive) {
      const typed = await ask(`Type ${command.name} to delete that workspace and every mock in it: `);
      if (typed.trim() !== command.name) {
        output.write("Cancelled.\n");
        return;
      }
    }
    await request(session.url, `/_admin/workspaces/${encodeURIComponent(command.name)}`, { method: "DELETE" });
    output.write(`Deleted workspace ${command.name}\n`);
    if (session.workspace === command.name) {
      session.workspace = "default";
    }
    return;
  }
  if (command.type === "mocks") {
    const mocks = await listMocks(session);
    if (mocks.length === 0) {
      output.write(`No mocks in ${session.workspace}.\n`);
      return;
    }
    output.write(`${mocks.map((mock) => `${mock.method.padEnd(7)} ${mock.kind.padEnd(12)} ${mock.path}`).join("\n")}\n`);
    return;
  }
  if (command.type === "add") {
    const text = await editBuffer(BLANK_DRAFT);
    if (text === null) {
      output.write("No changes.\n");
      return;
    }
    await saveText(session, text, undefined);
    return;
  }
  if (command.type === "edit") {
    const loaded = await request(
      session.url,
      `/_admin/workspaces/${encodeURIComponent(session.workspace)}/draft?${queryOf(command.ref)}`,
    );
    const draft = draftOf(loaded["draft"]);
    const text = await editBuffer(draftToYaml(draft));
    if (text === null) {
      output.write("No changes.\n");
      return;
    }
    await saveText(session, text, command.ref);
    return;
  }
  if (command.type === "remove") {
    if (session.interactive) {
      const answer = (await ask(`Delete ${refLabel(command.ref)} from ${session.workspace}? [y/N] `)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        output.write("Cancelled.\n");
        return;
      }
    }
    await request(session.url, `/_admin/workspaces/${encodeURIComponent(session.workspace)}/draft?${queryOf(command.ref)}`, {
      method: "DELETE",
    });
    output.write(`Deleted ${refLabel(command.ref)}\n`);
    return;
  }
  const files = await collectImportFiles([command.file]);
  await sendImport(
    session,
    files.map((file) => ({ filename: file.filename, text: file.buffer.toString("utf8") })),
    command.clash,
  );
}

async function saveText(session: ClientSession, text: string, previous: MockRef | undefined): Promise<void> {
  const draft = yamlToDraft(text);
  let result = await putDraft(session, draft, "reject", previous);
  if (!result.applied) {
    const policy = await choosePolicy(session, result.clashes.map((clash) => clash.label));
    if (policy === "cancel") {
      output.write("Cancelled.\n");
      return;
    }
    result = await putDraft(session, draft, policy, previous);
  }
  output.write(`${savedLine(result)}\n`);
}

async function sendImport(
  session: ClientSession,
  files: readonly { filename: string; text: string }[],
  clash: ClashPolicy | undefined,
): Promise<void> {
  let result = await postImport(session, files, clash ?? "reject");
  if (!result.applied) {
    if (clash !== undefined) {
      throw new Error(`Already exists:\n${result.clashes.map((clashItem) => `  ${clashItem.label}`).join("\n")}`);
    }
    const policy = await choosePolicy(session, result.clashes.map((item) => item.label));
    if (policy === "cancel") {
      output.write("Cancelled.\n");
      return;
    }
    result = await postImport(session, files, policy);
  }
  output.write(`${importLine(result)}\n`);
}

async function choosePolicy(session: ClientSession, labels: readonly string[]): Promise<ClashPolicy | "cancel"> {
  output.write(`Already exists:\n${labels.map((label) => `  ${label}`).join("\n")}\n`);
  if (!session.interactive) {
    throw new Error("Pass --clash replace or --clash skip to decide what happens to those paths.");
  }
  const answer = (await ask("replace, skip, or cancel? [r/s/c] ")).trim().toLowerCase();
  if (answer === "r" || answer === "replace") {
    return "replace";
  }
  if (answer === "s" || answer === "skip") {
    return "skip";
  }
  return "cancel";
}

function savedLine(result: SaveResult): string {
  if (result.action === "skipped") {
    return `Left ${result.label} as it was.`;
  }
  if (result.action === "replaced") {
    return `Replaced ${result.label}.`;
  }
  return `Saved ${result.label}.`;
}

function importLine(result: ImportResult): string {
  const parts = [
    result.created.length > 0 ? `added ${String(result.created.length)}` : "",
    result.replaced.length > 0 ? `replaced ${String(result.replaced.length)}` : "",
    result.skipped.length > 0 ? `skipped ${String(result.skipped.length)}` : "",
    result.ignoredDuplicates > 0 ? `ignored ${String(result.ignoredDuplicates)} duplicate${result.ignoredDuplicates === 1 ? "" : "s"} in the file` : "",
  ].filter((part) => part.length > 0);
  return parts.length === 0 ? "Nothing to import." : `${parts.join(", ")}.`;
}

async function putDraft(session: ClientSession, draft: MockDraft, clash: ClashPolicy, previous: MockRef | undefined): Promise<SaveResult> {
  const body: { clash: ClashPolicy; draft: MockDraft; previous?: MockRef } = { clash, draft };
  if (previous !== undefined) {
    body.previous = previous;
  }
  const payload = await request(session.url, `/_admin/workspaces/${encodeURIComponent(session.workspace)}/draft`, {
    method: "PUT",
    body: JSON.stringify(body),
  }, [200, 409]);
  return payload as unknown as SaveResult;
}

async function postImport(
  session: ClientSession,
  files: readonly { filename: string; text: string }[],
  clash: ClashPolicy,
): Promise<ImportResult> {
  const payload = await request(
    session.url,
    `/_admin/workspaces/${encodeURIComponent(session.workspace)}/import`,
    { method: "POST", body: JSON.stringify({ clash, files }) },
    [200, 409],
  );
  return payload as unknown as ImportResult;
}

async function listMocks(session: ClientSession): Promise<Array<{ kind: string; method: string; path: string }>> {
  const payload = await request(session.url, `/_admin/workspaces/${encodeURIComponent(session.workspace)}/mocks`);
  const mocks = payload["mocks"];
  if (!Array.isArray(mocks)) {
    return [];
  }
  return mocks.flatMap((item) => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (typeof record["kind"] !== "string" || typeof record["method"] !== "string" || typeof record["path"] !== "string") {
      return [];
    }
    return [{ kind: record["kind"], method: record["method"], path: record["path"] }];
  });
}

async function workspaces(url: string): Promise<string[]> {
  const payload = await request(url, "/_admin/workspaces");
  const names = payload["workspaces"];
  if (!Array.isArray(names)) {
    return [];
  }
  return names.filter((name): name is string => typeof name === "string");
}

async function ping(url: string): Promise<void> {
  await request(url, "/_admin/workspaces");
}

async function request(
  url: string,
  pathName: string,
  init: { method?: string; body?: string } = {},
  accept: readonly number[] = [200, 201],
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${url}${pathName}`, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? {} : { "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  } catch {
    throw new Error(`Cannot reach ${url}. Start the server with mock-engine in another terminal.`);
  }
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text.length > 0) {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  }
  if (!accept.includes(response.status)) {
    const error = typeof payload["error"] === "string" ? payload["error"] : `Request failed (${String(response.status)})`;
    throw new Error(error);
  }
  return payload;
}

function draftOf(value: unknown): MockDraft {
  return yamlToDraft(draftToYaml(value as MockDraft));
}

function queryOf(ref: MockRef): string {
  const params = new URLSearchParams();
  params.set("kind", ref.kind);
  if (ref.method.length > 0) {
    params.set("method", ref.method);
  }
  if (ref.path.length > 0) {
    params.set("path", ref.path);
  }
  if (ref.service.length > 0) {
    params.set("service", ref.service);
  }
  if (ref.rpc.length > 0) {
    params.set("rpc", ref.rpc);
  }
  return params.toString();
}

async function editBuffer(initial: string): Promise<string | null> {
  const editor = process.env["EDITOR"] || process.env["VISUAL"] || "nano";
  const directory = await mkdtemp(path.join(tmpdir(), "mock-engine-"));
  const file = path.join(directory, "mock.yml");
  try {
    await writeFile(file, initial.endsWith("\n") ? initial : `${initial}\n`, "utf8");
    const status = await new Promise<number>((resolve, reject) => {
      const child = spawn(editor, [file], { stdio: "inherit", shell: editor.includes(" ") });
      child.on("error", () => {
        reject(new Error(`Could not start ${editor}. Set EDITOR to vim or nano.`));
      });
      child.on("exit", (code) => {
        resolve(code ?? 1);
      });
    });
    if (status !== 0) {
      return null;
    }
    const next = await readFile(file, "utf8");
    return next === initial || next === `${initial}\n` ? null : next;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function splitArgs(argv: readonly string[]): { url: string; workspace?: string; command: string } {
  const host = process.env["HOST"] && process.env["HOST"].length > 0 ? process.env["HOST"] : DEFAULT_HOST;
  const port = process.env["PORT"] && process.env["PORT"].length > 0 ? process.env["PORT"] : String(DEFAULT_HTTP_PORT);
  let url = `http://${host}:${port}`;
  let workspace: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--url" || arg === "--workspace") {
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === "--url") {
        url = next;
      } else {
        workspace = next;
      }
      index += 1;
      continue;
    }
    if (arg !== undefined) {
      rest.push(arg);
    }
  }
  const command = rest.join(" ");
  return workspace === undefined ? { url, command } : { url, workspace, command };
}

function banner(session: ClientSession): string {
  const editor = process.env["EDITOR"] || process.env["VISUAL"] || "nano";
  return [
    "mock-engine client",
    `  server     ${session.url}`,
    `  workspace  ${session.workspace}`,
    `  editor     ${editor}`,
    "",
    "Type help. add and edit open your editor, then save the mock into the server.",
    "",
  ].join("\n");
}

async function ask(question: string): Promise<string> {
  const prompt = readline.createInterface({ input, output });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
