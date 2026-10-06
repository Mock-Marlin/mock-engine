/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";

import { graphqlQueryRejection } from "../src/graphql/limits.js";
import { acquireHeldSocket, releaseHeldSocket } from "../src/held-sockets.js";

describe("graphql query limits", () => {
  it("allows a small query and ignores parse errors", () => {
    expect(graphqlQueryRejection("{ user { id } }")).toBeNull();
    expect(graphqlQueryRejection("not graphql")).toBeNull();
  });

  it("rejects depth, field count, aliases, and fragment cycles", () => {
    const deep = "{ a { b { c { d { e { f { g { h { i } } } } } } } } }";
    expect(graphqlQueryRejection(deep)).toBe("Query is too deep");

    const fieldNames: string[] = [];
    const aliasNames: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      fieldNames.push(`f${index}`);
      if (index < 21) {
        aliasNames.push(`a${index}: id`);
      }
    }
    expect(graphqlQueryRejection(`{ ${fieldNames.join(" ")} }`)).toBe("Query selects too many fields");
    expect(graphqlQueryRejection(`{ ${aliasNames.join(" ")} }`)).toBe("Query uses too many aliases");

    expect(
      graphqlQueryRejection("query { ...A } fragment A on Query { ...B } fragment B on Query { ...A }"),
    ).toBe("Query fragment cycle is not allowed");

    expect(graphqlQueryRejection("query { user { ... on User { id } } }")).toBeNull();
    expect(graphqlQueryRejection("query { ...Missing }")).toBeNull();
  });
});

describe("held sockets", () => {
  it("refuses another socket at the cap and ignores an extra release", () => {
    releaseHeldSocket();
    const acquired: boolean[] = [];
    for (let index = 0; index < 64; index += 1) {
      acquired.push(acquireHeldSocket());
    }
    expect(acquired.every(Boolean)).toBe(true);
    expect(acquireHeldSocket()).toBe(false);
    for (let index = 0; index < 64; index += 1) {
      releaseHeldSocket();
    }
    expect(acquireHeldSocket()).toBe(true);
    releaseHeldSocket();
  });
});
