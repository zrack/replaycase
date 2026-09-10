import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson, canonicalSha256, sha256Hex } from "./canonical";

describe("canonical JSON and SHA-256", () => {
  it("sorts object keys recursively without changing array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 }, rows: [{ c: 4, a: 5 }] })).toBe(
      '{"a":{"b":3,"y":2},"rows":[{"a":5,"c":4}],"z":1}',
    );
  });

  it("matches the platform SHA-256 implementation", () => {
    const cases = [
      new Uint8Array(),
      new TextEncoder().encode("abc"),
      new TextEncoder().encode("ReplayCase decoder pack identity"),
      Uint8Array.from({ length: 1_024 }, (_, index) => index % 251),
    ];
    for (const bytes of cases) {
      expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(canonicalSha256({ z: 1, a: 2 })).toBe(
      createHash("sha256").update('{"a":2,"z":1}').digest("hex"),
    );
  });
});
