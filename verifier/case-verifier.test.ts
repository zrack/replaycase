import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { caseFixture, CASE_TEST_TIME } from "../tests/fixtures/case";
import { canonicalJson, sha256Hex } from "../src/domain/canonical";
import {
  caseContent,
  resolveCaseCitation,
  sealCase,
  type CaseCitation,
} from "../src/domain/case";
import {
  buildComparisonFinding,
  compareSources,
  comparisonFindingHash,
  createReceiverComparisonSource,
} from "../src/domain/comparison";
import {
  buildCaseArchive,
  CASE_ZIP_POLICY,
  verifyCaseArchive,
} from "./case-verifier";
import { inspectZip } from "./evidence-zip";

const pack = (entries: Record<string, Uint8Array>) =>
  zipSync(entries, { level: 0, mtime: new Date(1980, 0, 1) });
const encode = (value: unknown) =>
  new TextEncoder().encode(canonicalJson(value));

describe("portable case verifier", () => {
  it("orders timestamps by instant rather than fractional-second spelling", async () => {
    const { content, bundles } = await caseFixture();
    content.createdAt = "2026-09-19T12:00:00Z";
    content.updatedAt = "2026-09-19T12:00:00.001Z";
    expect(buildCaseArchive(content, bundles).manifest.updatedAt).toBe(
      content.updatedAt,
    );
    content.updatedAt = "2026-09-19T11:59:59.999Z";
    expect(() => buildCaseArchive(content, bundles)).toThrow(
      /precedes its creation/i,
    );
  });
  it("rejects aggregate nested expansion before parsing nested evidence", async () => {
    const { content } = await caseFixture();
    const padding = new Uint8Array(33 * 1024 * 1024);
    const bundles = [0, 1].map((index) =>
      zipSync(
        { "manifest.json": padding, SHA256SUMS: new Uint8Array([index]) },
        { level: 6, mtime: new Date(1980, 0, 1) },
      ),
    );
    content.bundles = bundles.map((bytes, index) => ({
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
      label: `Expanded ${index}`,
      fileName: `${index}.nlb`,
    }));
    expect(() => buildCaseArchive(content, bundles)).toThrow(
      /aggregate bundle size/,
    );
  });
  it("round-trips exact source bytes, citations, findings and independently reproduced comparisons", async () => {
    const { content, bundles } = await caseFixture();
    const original = buildCaseArchive(content, bundles);
    const failure = original.bundles[1]!.document;
    const citations: CaseCitation[] = [
      {
        kind: "range",
        bundleHash: failure.bundle.sha256,
        startUs: 0,
        endUs: 3_000_000,
      },
      {
        kind: "record",
        bundleHash: failure.bundle.sha256,
        recordId: "record-1",
      },
      {
        kind: "diagnostic",
        bundleHash: failure.bundle.sha256,
        diagnosticId: failure.evidence.diagnostics[0]!.id,
      },
    ];
    content.findings = [
      {
        id: "e47ad85e-ea18-4c65-bf2b-a1a818c85555",
        kind: "question",
        body: "Did the reset alter checksum behavior?",
        citations,
        createdAt: CASE_TEST_TIME,
        updatedAt: CASE_TEST_TIME,
      },
    ];
    content.comparisons = [
      buildComparisonFinding(
        compareSources(
          createReceiverComparisonSource(original.bundles[0]!.document),
          createReceiverComparisonSource(failure),
          { mode: "range-start" },
        ),
        "Checksum failures increased.",
        CASE_TEST_TIME,
      ),
    ];
    const built = buildCaseArchive(content, bundles);
    const received = verifyCaseArchive(built.archive);
    expect(received.archiveHash).toBe(built.archiveHash);
    expect(received.manifest).toEqual(built.manifest);
    expect(received.bundles.map((bundle) => bundle.bytes)).toEqual(bundles);
    expect(received.bundles[0]!.document.claims.authenticity).toBe(
      "not-established",
    );
    expect(received.bundles[0]!.document.claims.captureEvidence).toBe(
      "unknown",
    );
    expect(
      buildCaseArchive(caseContent(received.manifest), bundles).archive,
    ).toEqual(built.archive);
    expect(resolveCaseCitation(citations[1]!, failure)).toEqual(
      failure.evidence.rawRecords[1],
    );
  });

  it("rejects absent or altered bundles without repairing the archive", async () => {
    const { content, bundles } = await caseFixture();
    const entries = unzipSync(buildCaseArchive(content, bundles).archive);
    const path = `bundles/${content.bundles[0]!.sha256}.nlb`;
    const bytes = entries[path]!;
    delete entries[path];
    expect(() => verifyCaseArchive(pack(entries))).toThrow(
      /missing|undeclared/i,
    );
    entries[path] = Uint8Array.from(bytes);
    entries[path]![40] = (entries[path]![40] ?? 0) ^ 1;
    expect(() => verifyCaseArchive(pack(entries))).toThrow(/checksum/i);
  });

  it("rejects incompatible, noncanonical, altered and unknown manifest fields", async () => {
    const { content, bundles } = await caseFixture();
    const entries = unzipSync(buildCaseArchive(content, bundles).archive);
    for (const changed of [
      { ...sealCase(content), formatVersion: 2 },
      { ...sealCase(content), title: "Altered" },
      { ...sealCase(content), extra: true },
    ]) {
      expect(() =>
        verifyCaseArchive(pack({ ...entries, "case.json": encode(changed) })),
      ).toThrow();
    }
    expect(() =>
      verifyCaseArchive(
        pack({
          ...entries,
          "case.json": new TextEncoder().encode(
            JSON.stringify(sealCase(content), null, 2),
          ),
        }),
      ),
    ).toThrow(/canonical/i);
    expect(() =>
      verifyCaseArchive(
        pack({ ...entries, "case.json": new Uint8Array(1024 * 1024 + 1) }),
      ),
    ).toThrow(/1 MiB/);
  });

  it("rejects unknown paths, nested cases and duplicate bundle identities", async () => {
    const { content, bundles } = await caseFixture();
    const built = buildCaseArchive(content, bundles);
    const entries = unzipSync(built.archive);
    for (const path of [
      "../case.json",
      "bundles/nested.nlcase",
      "unlisted.txt",
    ])
      expect(() =>
        verifyCaseArchive(pack({ ...entries, [path]: new Uint8Array([1]) })),
      ).toThrow();
    expect(() =>
      buildCaseArchive(
        { ...content, bundles: [...content.bundles, content.bundles[0]!] },
        [...bundles, bundles[0]!],
      ),
    ).toThrow(/duplicate/i);
  });

  it.each([
    { kind: "range", startUs: 0, endUs: 3_000_001 },
    { kind: "range", startUs: 2, endUs: 2 },
    { kind: "record", recordId: "not-included" },
    { kind: "diagnostic", diagnosticId: "missing-diagnostic" },
  ])("rejects unresolved citation %j", async (target) => {
    const { content, bundles } = await caseFixture();
    content.findings = [
      {
        id: "e47ad85e-ea18-4c65-bf2b-a1a818c85555",
        kind: "finding",
        body: "Observed behavior",
        citations: [
          { ...target, bundleHash: content.bundles[0]!.sha256 } as CaseCitation,
        ],
        createdAt: CASE_TEST_TIME,
        updatedAt: CASE_TEST_TIME,
      },
    ];
    expect(() => buildCaseArchive(content, bundles)).toThrow(/citation/i);
  });

  it("recalculates comparison evidence instead of trusting a newly hashed false finding", async () => {
    const { content, bundles } = await caseFixture();
    const built = buildCaseArchive(content, bundles);
    const model = compareSources(
      createReceiverComparisonSource(built.bundles[0]!.document),
      createReceiverComparisonSource(built.bundles[1]!.document),
      { mode: "range-start" },
    );
    const finding = structuredClone(
      buildComparisonFinding(model, "Observed", CASE_TEST_TIME),
    );
    finding.inputs.baseline.title = "False source description";
    finding.identity.canonicalSha256 = comparisonFindingHash(finding);
    content.comparisons = [finding];
    expect(() => buildCaseArchive(content, bundles)).toThrow();
  });

  it("keeps the original ZIP limits and enforces a separately bounded case profile", async () => {
    const { content, bundles } = await caseFixture();
    const archive = buildCaseArchive(content, bundles).archive;
    expect(() => inspectZip(archive)).toThrow(/not part/);
    expect(inspectZip(archive, CASE_ZIP_POLICY).entries).toHaveLength(4);
    expect(() =>
      inspectZip(archive, { ...CASE_ZIP_POLICY, totalUncompressedBytes: 10 }),
    ).toThrow(/uncompressed limit/);
    expect(() =>
      inspectZip(archive, { ...CASE_ZIP_POLICY, entries: 2 }),
    ).toThrow(/at most 2/);
  });
});
