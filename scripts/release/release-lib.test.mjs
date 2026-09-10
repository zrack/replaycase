import { describe, expect, it } from "vitest";

import {
  assertCycloneDxReferences,
  isAnnotatedTagAtHead,
  normalizeCycloneDx,
} from "./release-lib.mjs";

const identity = Object.freeze({
  version: "0.1.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  sourceDateEpoch: 1_700_000_000,
});

function sourceSbom() {
  return {
    $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        "bom-ref": "replaycase@0.1.0",
        name: "replaycase",
        version: "0.1.0",
        type: "application",
        properties: [],
      },
      tools: [],
    },
    components: [
      {
        "bom-ref": "dependency@1.0.0",
        name: "dependency",
        version: "1.0.0",
        type: "library",
      },
    ],
    dependencies: [
      {
        ref: "replaycase@0.1.0",
        dependsOn: ["dependency@1.0.0"],
      },
      {
        ref: "dependency@1.0.0",
        dependsOn: ["replaycase@0.1.0"],
      },
    ],
  };
}

describe("release SBOM normalization", () => {
  it("rewrites every root reference and retains a closed dependency graph", () => {
    const normalized = normalizeCycloneDx(sourceSbom(), identity);
    const rootReference = "pkg:npm/replaycase@0.1.0";

    expect(normalized.metadata.component["bom-ref"]).toBe(rootReference);
    expect(normalized.dependencies).toEqual([
      {
        ref: "dependency@1.0.0",
        dependsOn: [rootReference],
      },
      {
        ref: rootReference,
        dependsOn: ["dependency@1.0.0"],
      },
    ]);
    expect(() => assertCycloneDxReferences(normalized)).not.toThrow();
  });

  it("rejects a dependency reference that is absent from the component graph", () => {
    const malformed = sourceSbom();
    malformed.dependencies.push({ ref: "missing@1.0.0", dependsOn: [] });

    expect(() => assertCycloneDxReferences(malformed))
      .toThrow(/does not resolve to a component/);
  });
});

describe("strict release tag identity", () => {
  it("accepts only an annotated tag object that points at HEAD", () => {
    expect(isAnnotatedTagAtHead(true, "tag")).toBe(true);
    expect(isAnnotatedTagAtHead(true, "commit")).toBe(false);
    expect(isAnnotatedTagAtHead(false, "tag")).toBe(false);
  });
});
