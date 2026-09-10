import { describe, expect, it } from "vitest";

import { bytesToHex, encodeFrame, SUPPORTED_DECODER } from "./decoder";
import {
  buildComparisonFinding,
  compareSources,
  comparisonFindingHash,
  ComparisonFindingValidationError,
  createSessionComparisonSource,
  serializeComparisonFinding,
  suggestComparisonFindingFilename,
  validateComparisonFinding,
} from "./comparison";
import { parseSession } from "./session";
import type {
  CaptureIntegrityReceipt,
  SessionDocumentV2,
  SourceRecord,
} from "./types";

function record(
  id: string,
  index: number,
  offsetUs: number,
  sequence: number,
  options: { corruptChecksum?: boolean; rssiDbm?: number } = {},
): SourceRecord {
  const bytes = encodeFrame({
    familyId: 0x02,
    sequence,
    deviceTimeMs: Math.floor(offsetUs / 1_000),
    payload: new Uint8Array(8),
    corruptChecksum: options.corruptChecksum,
  });
  return {
    id,
    index,
    sourceId: "comparison-source",
    offsetUs,
    dataHex: bytesToHex(bytes),
    captureBytes: bytes.length,
    wireBytes: bytes.length,
    transport: { kind: "udp" },
    ...(options.rssiDbm == null
      ? {}
      : { signal: { rssiDbm: options.rssiDbm, provenance: "gateway-sidecar" as const } }),
  };
}

function receipt(records: readonly SourceRecord[]): CaptureIntegrityReceipt {
  const bytes = records.reduce((sum, sourceRecord) => sum + sourceRecord.captureBytes, 0);
  return {
    schemaVersion: 1,
    status: "verified",
    assessmentBasis: "udp-bridge-reconciled",
    stopDisposition: "confirmed",
    stopOffsetUs: 4_000_000,
    eventLogComplete: true,
    input: {
      unit: "datagram",
      observedUnits: records.length,
      observedBytes: bytes,
      transportReportedUnits: records.length,
      transportReportedBytes: bytes,
    },
    retained: { records: records.length, bytes },
    issueCodes: [],
  };
}

function session(
  id: string,
  sourceRecords: SourceRecord[],
  options: { schemaHash?: string } = {},
) {
  const document: SessionDocumentV2 = {
    format: "narrowslink/session",
    formatVersion: 2,
    id,
    title: `Comparison ${id}`,
    startedAt: "2026-07-24T20:00:00.000Z",
    displayTimeZone: "America/Los_Angeles",
    durationUs: 4_000_000,
    source: {
      id: "comparison-source",
      kind: "udp",
      label: "Loopback UDP",
      address: "127.0.0.1",
      port: 9_104,
    },
    decoder: {
      ...SUPPORTED_DECODER,
      ...(options.schemaHash == null ? {} : { schemaHash: options.schemaHash }),
    },
    records: sourceRecords,
    incidents: [{
      id: `${id}-incident`,
      title: `${id} controlled range`,
      startUs: 500_000,
      endUs: 3_500_000,
      severity: "warning",
    }],
    transportEvents: [],
    captureIntegrity: receipt(sourceRecords),
  };
  return parseSession(document);
}

function controlledPair() {
  const baseline = session("baseline", [
    record("baseline-1", 0, 500_000, 1, { rssiDbm: -70 }),
    record("baseline-2", 1, 1_500_000, 2, { rssiDbm: -72 }),
    record("baseline-3", 2, 2_500_000, 3, { rssiDbm: -71 }),
  ]);
  const candidate = session("candidate", [
    record("candidate-1", 0, 500_000, 1, { rssiDbm: -82 }),
    record("candidate-2", 1, 1_500_000, 2, { corruptChecksum: true, rssiDbm: -90 }),
    record("candidate-3", 2, 2_500_000, 3, { rssiDbm: -86 }),
  ]);
  return {
    baseline: createSessionComparisonSource(baseline, baseline.incidents[0]!),
    candidate: createSessionComparisonSource(candidate, candidate.incidents[0]!),
  };
}

describe("comparative replay contract", () => {
  it("compares only the explicitly aligned overlap and retains unmatched tails", () => {
    const { baseline, candidate } = controlledPair();
    const model = compareSources(baseline, candidate, {
      mode: "shared-event",
      label: "First heartbeat after radio reset",
      baselineAnchorUs: 1_500_000,
      candidateAnchorUs: 500_000,
    });

    expect(model.alignment.overlap).toEqual({
      startRelativeUs: 0,
      endRelativeUs: 2_000_000,
      durationUs: 2_000_000,
      baselineStartUs: 1_500_000,
      baselineEndUs: 3_500_000,
      candidateStartUs: 500_000,
      candidateEndUs: 2_500_000,
    });
    expect(model.alignment.unmatched).toEqual({
      baselineBeforeUs: 1_000_000,
      baselineAfterUs: 0,
      candidateBeforeUs: 0,
      candidateAfterUs: 1_000_000,
    });
  });

  it("reports a controlled integrity and signal regression with traceable evidence", () => {
    const { baseline, candidate } = controlledPair();
    const model = compareSources(baseline, candidate, { mode: "range-start" });

    const integrity = model.metrics.find((metric) => metric.id === "integrity-failure-rate");
    const rssi = model.metrics.find((metric) => metric.id === "average-rssi");
    expect(integrity).toMatchObject({
      baseline: 0,
      candidate: 1 / 3,
      direction: "increased",
      assessment: "regressed",
      candidateEvidenceIds: ["frame-candidate-2"],
    });
    expect(rssi).toMatchObject({
      baseline: -71,
      candidate: -86,
      delta: -15,
      direction: "decreased",
      assessment: "regressed",
    });
    expect(model.assessment).toBe("regressed");
  });

  it("withholds packet and field deltas when decoder identity differs", () => {
    const { baseline, candidate: validCandidate } = controlledPair();
    const candidate = structuredClone(validCandidate);
    candidate.decoder.schemaHash = "a".repeat(64);
    const model = compareSources(baseline, candidate, { mode: "range-start" });

    expect(model.areas.find((area) => area.id === "packet-evidence")?.status).toBe("not-comparable");
    expect(model.metrics.find((metric) => metric.id === "integrity-failure-rate")).toMatchObject({
      status: "not-comparable",
      delta: null,
      direction: "unresolved",
      assessment: "unresolved",
    });
    expect(model.assessment).toBe("unresolved");
  });

  it("requires selected raw support before comparing exported decoded evidence", () => {
    const { baseline, candidate: originalCandidate } = controlledPair();
    const candidate = {
      ...originalCandidate,
      recordsAvailable: false,
      records: [],
    };
    const model = compareSources(baseline, candidate, { mode: "range-start" });

    expect(model.areas.find((area) => area.id === "packet-evidence")?.status).toBe("review-required");
    expect(model.areas.find((area) => area.id === "diagnostics")?.status).toBe("review-required");
    expect(model.areas.find((area) => area.id === "decoded-fields")?.status).toBe("review-required");
    expect(model.metrics.find((metric) => metric.id === "integrity-failure-rate")).toMatchObject({
      status: "review-required",
      delta: null,
      assessment: "unresolved",
    });
    expect(model.assessment).toBe("unresolved");
  });

  it("withholds RSSI deltas when observation provenance differs", () => {
    const { baseline, candidate: originalCandidate } = controlledPair();
    const candidate = {
      ...originalCandidate,
      records: originalCandidate.records.map((sourceRecord) => ({
        ...sourceRecord,
        signal: sourceRecord.signal == null
          ? undefined
          : { ...sourceRecord.signal, provenance: "decoded-packet" as const },
      })),
    };
    const model = compareSources(baseline, candidate, { mode: "range-start" });

    expect(model.areas.find((area) => area.id === "link-observations")).toMatchObject({
      status: "not-comparable",
      reason: expect.stringContaining("evidence bases differ"),
    });
    expect(model.metrics.find((metric) => metric.id === "average-rssi")).toMatchObject({
      baseline: -71,
      candidate: -86,
      delta: null,
      direction: "unresolved",
      assessment: "unresolved",
    });
    expect(model.assessment).toBe("unresolved");
  });

  it("requires matching decoders for decoded-packet RSSI", () => {
    const { baseline: originalBaseline, candidate: originalCandidate } = controlledPair();
    const decodedSignalRecords = (sourceRecords: typeof originalBaseline.records) =>
      sourceRecords.map((sourceRecord) => ({
        ...sourceRecord,
        signal: sourceRecord.signal == null
          ? undefined
          : { ...sourceRecord.signal, provenance: "decoded-packet" as const },
      }));
    const baseline = { ...originalBaseline, records: decodedSignalRecords(originalBaseline.records) };
    const candidate = {
      ...originalCandidate,
      decoder: { ...originalCandidate.decoder, schemaHash: "c".repeat(64) },
      records: decodedSignalRecords(originalCandidate.records),
    };
    const model = compareSources(baseline, candidate, { mode: "range-start" });

    expect(model.areas.find((area) => area.id === "link-observations")).toMatchObject({
      status: "not-comparable",
      reason: "Decoded-packet RSSI is withheld because decoder identity differs.",
    });
    expect(model.metrics.find((metric) => metric.id === "average-rssi")?.delta).toBeNull();
  });

  it("rejects anchors outside the selected half-open ranges", () => {
    const { baseline, candidate } = controlledPair();
    expect(() => compareSources(baseline, candidate, {
      mode: "shared-event",
      label: "Invalid end anchor",
      baselineAnchorUs: baseline.range.endUs,
      candidateAnchorUs: candidate.range.startUs,
    })).toThrow("Each comparison anchor must fall inside");
  });

  it("exports and verifies a checksummed portable finding", () => {
    const { baseline, candidate } = controlledPair();
    const model = compareSources(baseline, candidate, { mode: "range-start" });
    const finding = buildComparisonFinding(
      model,
      "Candidate regressed on integrity failures and bounded RSSI observations.",
      "2026-07-24T22:00:00.000Z",
    );

    expect(finding.inputs.baseline.identity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(finding.identity.canonicalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(finding.inputs.baseline.range.rangeSemantics).toBe("half-open [startUs, endUs)");
    expect(finding.inputs.baseline).toMatchObject({
      durationUs: 4_000_000,
      evidenceAvailability: {
        records: true,
        decodedFrames: true,
        diagnostics: true,
      },
      alignedEvidence: {
        recordCount: 3,
        decodedFrameCount: 3,
        rssiObservationCount: 3,
        rssiProvenance: ["gateway-sidecar"],
      },
    });
    expect(finding.metrics.find((metric) => metric.id === "packet-rate")).toMatchObject({
      baselineEvidenceCount: 3,
      candidateEvidenceCount: 3,
      baselineEvidenceIds: ["frame-baseline-1", "frame-baseline-2", "frame-baseline-3"],
    });
    expect(validateComparisonFinding(JSON.parse(serializeComparisonFinding(finding)))).toEqual(finding);
    expect(suggestComparisonFindingFilename(model)).toBe("baseline-vs-candidate.nlcompare.json");
  });

  it("validates a legacy-branded finding without rewriting its content or identity", () => {
    const { baseline, candidate } = controlledPair();
    const finding = structuredClone(buildComparisonFinding(
      compareSources(baseline, candidate, { mode: "range-start" }),
      "Legacy operator conclusion.",
      "2026-07-24T22:00:00.000Z",
    ));
    finding.limitations = finding.limitations.map((value) => value.replace("ReplayCase", "NarrowsLink"));
    finding.identity.canonicalSha256 = comparisonFindingHash(finding);
    const bytes = JSON.stringify(finding);
    expect(validateComparisonFinding(JSON.parse(bytes))).toEqual(finding);
    expect(JSON.stringify(finding)).toBe(bytes);
  });

  it("rejects a finding whose conclusion was changed after sealing", () => {
    const { baseline, candidate } = controlledPair();
    const finding = buildComparisonFinding(
      compareSources(baseline, candidate, { mode: "range-start" }),
      "Initial bounded conclusion.",
      "2026-07-24T22:00:00.000Z",
    );
    const altered = structuredClone(finding);
    altered.conclusion = "Altered conclusion.";

    expect(() => validateComparisonFinding(altered)).toThrow(ComparisonFindingValidationError);
    expect(() => validateComparisonFinding(altered)).toThrow("does not match its declared identity");
  });

  it("rejects contradictory overlap evidence even after the checksum is recomputed", () => {
    const { baseline, candidate } = controlledPair();
    const finding = buildComparisonFinding(
      compareSources(baseline, candidate, { mode: "range-start" }),
      "Controlled conclusion.",
      "2026-07-24T22:00:00.000Z",
    );
    const altered = structuredClone(finding);
    altered.alignment.overlap.baselineStartUs += 1;
    altered.identity.canonicalSha256 = comparisonFindingHash(altered);

    expect(() => validateComparisonFinding(altered)).toThrow("contradictory range or metric evidence");
  });

  it("rejects a recomputed finding that calls decoder-incompatible evidence comparable", () => {
    const { baseline, candidate } = controlledPair();
    const finding = buildComparisonFinding(
      compareSources(baseline, candidate, { mode: "range-start" }),
      "Controlled conclusion.",
      "2026-07-24T22:00:00.000Z",
    );
    const altered = structuredClone(finding);
    altered.inputs.candidate.decoder.schemaHash = "b".repeat(64);
    altered.identity.canonicalSha256 = comparisonFindingHash(altered);

    expect(() => validateComparisonFinding(altered)).toThrow(ComparisonFindingValidationError);
    expect(() => validateComparisonFinding(altered)).toThrow("contradictory range or metric evidence");
  });
});
