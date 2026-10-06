/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { addMocksToSchema } from "@graphql-tools/mock";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { graphql, parse, subscribe } from "graphql";

import { graphqlQueryRejection } from "./limits.js";

export interface GraphqlOperationInput {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVariables(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isRecord(value) ? value : undefined;
}

export function operationFrom(value: unknown): GraphqlOperationInput {
  if (typeof value === "string") {
    return { query: value };
  }
  if (!isRecord(value)) {
    return { query: "" };
  }
  const query = value["query"];
  const operation: GraphqlOperationInput = {
    query: typeof query === "string" ? query : "",
  };
  const variables = parseVariables(value["variables"]);
  if (variables !== undefined) {
    operation.variables = variables;
  }
  const operationName = value["operationName"];
  if (typeof operationName === "string" && operationName.trim().length > 0) {
    operation.operationName = operationName.trim();
  }
  return operation;
}

function envelope(error: unknown): { data: null; errors: Array<{ message: string }> } {
  const message = error instanceof Error && error.message.length > 0 ? error.message : "GraphQL execution failed";
  return { data: null, errors: [{ message }] };
}

/** Default execution when the host hook does not replace the response. */
export async function executeSdl(sdl: string, operation: GraphqlOperationInput): Promise<unknown> {
  const rejected = graphqlQueryRejection(operation.query);
  if (rejected !== null) {
    return envelope(new Error(rejected));
  }
  try {
    const schema = addMocksToSchema({
      schema: makeExecutableSchema({ typeDefs: sdl }),
    });
    const result = await graphql({
      schema,
      source: operation.query,
      ...(operation.variables !== undefined ? { variableValues: operation.variables } : {}),
      ...(operation.operationName !== undefined ? { operationName: operation.operationName } : {}),
    });
    return result;
  } catch (error: unknown) {
    return envelope(error);
  }
}

export async function subscribeSdl(sdl: string, operation: GraphqlOperationInput): Promise<unknown[]> {
  const rejected = graphqlQueryRejection(operation.query);
  if (rejected !== null) {
    return [envelope(new Error(rejected))];
  }
  try {
    const schema = addMocksToSchema({
      schema: makeExecutableSchema({ typeDefs: sdl }),
    });
    const result = await subscribe({
      schema,
      document: parse(operation.query),
      ...(operation.variables !== undefined ? { variableValues: operation.variables } : {}),
      ...(operation.operationName !== undefined ? { operationName: operation.operationName } : {}),
    });
    if (result !== null && typeof result === "object" && Symbol.asyncIterator in result) {
      const envelopes: unknown[] = [];
      for await (const payload of result as AsyncIterable<unknown>) {
        envelopes.push(payload);
      }
      return envelopes;
    }
    return [result];
  } catch (error: unknown) {
    return [envelope(error)];
  }
}
