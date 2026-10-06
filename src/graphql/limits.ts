/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { Kind, parse, type DocumentNode, type SelectionNode, type SelectionSetNode } from "graphql";

const MAX_QUERY_DEPTH = 8;
const MAX_FIELD_COUNT = 100;
const MAX_ALIAS_COUNT = 20;

/**
 * Reject oversized public GraphQL documents before execution.
 * Parse errors return null so the executor can report them.
 */
export function graphqlQueryRejection(source: string): string | null {
  let document: DocumentNode;
  try {
    document = parse(source);
  } catch {
    return null;
  }

  const fragments = new Map<string, SelectionSetNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition.selectionSet);
    }
  }

  let fields = 0;
  let aliases = 0;

  function walk(selectionSet: SelectionSetNode, depth: number, stack: Set<string>): string | null {
    if (depth > MAX_QUERY_DEPTH) {
      return "Query is too deep";
    }
    for (const selection of selectionSet.selections) {
      const rejected = walkSelection(selection, depth, stack);
      if (rejected !== null) {
        return rejected;
      }
    }
    return null;
  }

  function walkSelection(selection: SelectionNode, depth: number, stack: Set<string>): string | null {
    if (selection.kind === Kind.FIELD) {
      fields += 1;
      if (selection.alias !== undefined) {
        aliases += 1;
      }
      if (fields > MAX_FIELD_COUNT) {
        return "Query selects too many fields";
      }
      if (aliases > MAX_ALIAS_COUNT) {
        return "Query uses too many aliases";
      }
      if (selection.selectionSet !== undefined) {
        return walk(selection.selectionSet, depth + 1, stack);
      }
      return null;
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      return walk(selection.selectionSet, depth, stack);
    }
    const name = selection.name.value;
    if (stack.has(name)) {
      return "Query fragment cycle is not allowed";
    }
    const fragment = fragments.get(name);
    if (fragment === undefined) {
      return null;
    }
    stack.add(name);
    const rejected = walk(fragment, depth, stack);
    stack.delete(name);
    return rejected;
  }

  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      const rejected = walk(definition.selectionSet, 1, new Set());
      if (rejected !== null) {
        return rejected;
      }
    }
  }
  return null;
}
