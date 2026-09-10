import { z } from "zod";

import type { VerifiedDecodedPacket } from "../../verifier/evidence-verifier";
import { encodeSessionDocument } from "../data/session-file";
import type { ReceiverDocument } from "../receiver/receiver-document";
import { canonicalJson, sha256Hex } from "./canonical";
import type {
  CaptureIntegrityReceipt,
  DecodedField,
  DecodedFrame,
  DiagnosticEvent,
  IncidentProjection,
  IntegrityStatus,
  ParsedSession,
  SourceRecord,
} from "./types";

export const COMPARISON_FINDING_FORMAT = "narrowslink/comparison-finding" as const;
export const COMPARISON_FINDING_FORMAT_VERSION = 1 as const;
export const COMPARISON_RANGE_SEMANTICS = "half-open [startUs, endUs)" as const;
export const MAX_COMPARISON_FINDING_BYTES = 1024 * 1024;
export const MAX_COMPARISON_CONCLUSION_LENGTH = 4_000;

const TEXT_ENCODER = new TextEncoder();
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type ComparisonSourceKind = "session" | "evidence-bundle";
export type ComparisonStatus =
  | "comparable"
  | "review-required"
  | "not-comparable"
  | "unavailable";
export type ComparisonAssessment =
  | "improved"
  | "regressed"
  | "unchanged"
  | "unresolved";
export type ComparisonDirection =
  | "increased"
  | "decreased"
  | "unchanged"
  | "unresolved";
export type ComparisonAlignment =
  | { mode: "range-start" }
  | {
      mode: "shared-event";
      label: string;
      baselineAnchorUs: number;
      candidateAnchorUs: number;
    };

export interface ComparisonRange {
  id: string | null;
  title: string;
  startUs: number;
  endUs: number;
}

export interface ComparisonDecoderIdentity {
  id: string;
  revision: string;
  schemaHash: string;
  packHash: string | null;
  runtimeId: string | null;
  runtimeRevision: string | null;
}

interface ComparisonFrame {
  id: string;
  offsetUs: number;
  sourceRecordId: string;
  status: "complete" | "partial" | "invalid";
  integrityStatus: IntegrityStatus["status"];
  familyName: string;
  fields: readonly DecodedField[];
}

interface ComparisonDiagnostic {
  id: string;
  severity: "info" | "warning" | "critical";
  startUs: number;
  endUs?: number;
}

export interface ComparisonSource {
  kind: ComparisonSourceKind;
  identity: string;
  title: string;
  sessionId: string;
  startedAt: string;
  displayTimeZone: string;
  durationUs: number;
  sourceId: string;
  decoder: ComparisonDecoderIdentity;
  range: ComparisonRange;
  captureIntegrity: CaptureIntegrityReceipt;
  evidenceCompleteness: "verified" | "incomplete" | "unknown";
  recordsAvailable: boolean;
  decodedFramesAvailable: boolean;
  diagnosticsAvailable: boolean;
  records: readonly SourceRecord[];
  frames: readonly ComparisonFrame[];
  diagnostics: readonly ComparisonDiagnostic[];
  limitations: readonly string[];
}

export interface ComparisonArea {
  id:
    | "alignment"
    | "packet-evidence"
    | "capture-evidence"
    | "diagnostics"
    | "decoded-fields"
    | "link-observations";
  label: string;
  status: ComparisonStatus;
  reason: string;
}

export interface ComparisonMetric {
  id: string;
  label: string;
  category: "packets" | "diagnostics" | "link" | "decoded";
  unit: string;
  status: ComparisonStatus;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  direction: ComparisonDirection;
  assessment: ComparisonAssessment;
  reason: string;
  baselineEvidenceCount: number;
  candidateEvidenceCount: number;
  baselineEvidenceIds: readonly string[];
  candidateEvidenceIds: readonly string[];
}

export interface ComparisonModel {
  baseline: ComparisonSource;
  candidate: ComparisonSource;
  alignment: {
    mode: ComparisonAlignment["mode"];
    label: string;
    baselineAnchorUs: number;
    candidateAnchorUs: number;
    overlap: {
      startRelativeUs: number;
      endRelativeUs: number;
      durationUs: number;
      baselineStartUs: number;
      baselineEndUs: number;
      candidateStartUs: number;
      candidateEndUs: number;
    };
    unmatched: {
      baselineBeforeUs: number;
      baselineAfterUs: number;
      candidateBeforeUs: number;
      candidateAfterUs: number;
    };
  };
  areas: readonly ComparisonArea[];
  metrics: readonly ComparisonMetric[];
  assessment: ComparisonAssessment;
  limitations: readonly string[];
}

export interface ComparisonFinding {
  format: typeof COMPARISON_FINDING_FORMAT;
  formatVersion: typeof COMPARISON_FINDING_FORMAT_VERSION;
  generatedAt: string;
  identity: {
    algorithm: "SHA-256";
    canonicalSha256: string;
  };
  inputs: {
    baseline: ComparisonFindingInput;
    candidate: ComparisonFindingInput;
  };
  alignment: ComparisonModel["alignment"];
  comparability: readonly ComparisonArea[];
  metrics: readonly ComparisonMetric[];
  assessment: ComparisonAssessment;
  conclusion: string;
  limitations: readonly string[];
}

interface ComparisonFindingInput {
  kind: ComparisonSourceKind;
  identity: string;
  title: string;
  sessionId: string;
  startedAt: string;
  displayTimeZone: string;
  durationUs: number;
  sourceId: string;
  range: ComparisonRange & {
    rangeSemantics: typeof COMPARISON_RANGE_SEMANTICS;
  };
  decoder: ComparisonDecoderIdentity;
  captureEvidence: {
    status: CaptureIntegrityReceipt["status"];
    assessmentBasis: CaptureIntegrityReceipt["assessmentBasis"];
    evidenceCompleteness: ComparisonSource["evidenceCompleteness"];
  };
  evidenceAvailability: {
    records: boolean;
    decodedFrames: boolean;
    diagnostics: boolean;
  };
  alignedEvidence: {
    recordCount: number;
    decodedFrameCount: number;
    diagnosticCount: number;
    rssiObservationCount: number;
    rssiProvenance: readonly NonNullable<SourceRecord["signal"]>["provenance"][];
  };
}

function deepFreeze<T>(value: T): T {
  if (value == null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertRange(range: ComparisonRange, durationUs: number): void {
  if (
    !Number.isSafeInteger(range.startUs)
    || !Number.isSafeInteger(range.endUs)
    || range.startUs < 0
    || range.endUs <= range.startUs
    || range.endUs > durationUs
  ) {
    throw new RangeError("Comparison ranges must be non-empty half-open intervals within their source duration.");
  }
}

function sessionIdentity(session: ParsedSession): string {
  return session.canonicalIdentity ?? `sha256:${sha256Hex(encodeSessionDocument(session.document))}`;
}

function descriptorIdentity(
  descriptor: ParsedSession["document"]["decoder"],
): ComparisonDecoderIdentity {
  return {
    id: descriptor.id,
    revision: descriptor.revision,
    schemaHash: descriptor.schemaHash.toLowerCase(),
    packHash: descriptor.packHash?.toLowerCase() ?? null,
    runtimeId: descriptor.runtimeId ?? null,
    runtimeRevision: descriptor.runtimeRevision ?? null,
  };
}

function frameFromSession(frame: DecodedFrame): ComparisonFrame {
  return {
    id: frame.id,
    offsetUs: frame.offsetUs,
    sourceRecordId: frame.sourceRecord.id,
    status: frame.status,
    integrityStatus: frame.integrity.status,
    familyName: frame.familyName,
    fields: frame.fields,
  };
}

function frameFromReceiver(frame: VerifiedDecodedPacket): ComparisonFrame {
  return {
    id: frame.id,
    offsetUs: frame.offsetUs,
    sourceRecordId: frame.sourceRecordId,
    status: frame.status,
    integrityStatus: frame.integrityStatus,
    familyName: frame.familyName,
    fields: frame.fields,
  };
}

function diagnosticFromSource(
  diagnostic: DiagnosticEvent | ReceiverDocument["evidence"]["diagnostics"][number],
): ComparisonDiagnostic {
  return {
    id: diagnostic.id,
    severity: diagnostic.severity,
    startUs: diagnostic.startUs,
    ...(diagnostic.endUs == null ? {} : { endUs: diagnostic.endUs }),
  };
}

export function createSessionComparisonSource(
  session: ParsedSession,
  incident: IncidentProjection,
): ComparisonSource {
  const range: ComparisonRange = {
    id: incident.id,
    title: incident.title,
    startUs: incident.startUs,
    endUs: incident.endUs,
  };
  assertRange(range, session.document.durationUs);
  const records = rowsInRange(session.document.records, range.startUs, range.endUs);
  const frames = rowsInRange(session.frames, range.startUs, range.endUs);
  const diagnostics = diagnosticsInRange(session.diagnostics, range.startUs, range.endUs);
  return deepFreeze({
    kind: "session",
    identity: sessionIdentity(session),
    title: session.document.title,
    sessionId: session.document.id,
    startedAt: session.document.startedAt,
    displayTimeZone: session.document.displayTimeZone,
    durationUs: session.document.durationUs,
    sourceId: session.document.source.id,
    decoder: descriptorIdentity(session.document.decoder),
    range,
    captureIntegrity: session.captureIntegrity,
    evidenceCompleteness: "verified",
    recordsAvailable: true,
    decodedFramesAvailable: true,
    diagnosticsAvailable: true,
    records,
    frames: frames.map(frameFromSession),
    diagnostics: diagnostics.map(diagnosticFromSource),
    limitations: session.captureIntegrity.status === "verified"
      ? []
      : [`Capture evidence is ${session.captureIntegrity.status} (${session.captureIntegrity.assessmentBasis}).`],
  });
}

export function createReceiverComparisonSource(
  document: ReceiverDocument,
): ComparisonSource {
  const range: ComparisonRange = {
    id: document.incident.id,
    title: document.incident.title ?? document.sourceSession.title,
    startUs: document.incident.startUs,
    endUs: document.incident.endUs,
  };
  assertRange(range, document.sourceSession.durationUs);
  return deepFreeze({
    kind: "evidence-bundle",
    identity: `sha256:${document.bundle.sha256}`,
    title: document.sourceSession.title,
    sessionId: document.sourceSession.id,
    startedAt: document.sourceSession.startedAt,
    displayTimeZone: document.sourceSession.displayTimeZone,
    durationUs: document.sourceSession.durationUs,
    sourceId: document.sourceSession.sourceId,
    decoder: {
      id: document.sourceSession.decoderId,
      revision: document.sourceSession.decoderRevision,
      schemaHash: document.sourceSession.schemaHash.toLowerCase(),
      packHash: document.sourceSession.packHash?.toLowerCase() ?? null,
      runtimeId: document.sourceSession.runtimeId,
      runtimeRevision: document.sourceSession.runtimeRevision,
    },
    range,
    captureIntegrity: document.evidence.integrityReceipt,
    evidenceCompleteness: document.claims.evidenceCompleteness,
    recordsAvailable: document.availability.rawRecords.included,
    decodedFramesAvailable: document.availability.decodedPackets.included,
    diagnosticsAvailable: document.availability.diagnostics.included,
    records: document.evidence.rawRecords,
    frames: document.evidence.decodedPackets.map(frameFromReceiver),
    diagnostics: document.evidence.diagnostics.map(diagnosticFromSource),
    limitations: document.limitations,
  });
}

function sameDecoder(
  baseline: ComparisonDecoderIdentity,
  candidate: ComparisonDecoderIdentity,
): boolean {
  return baseline.id === candidate.id
    && baseline.revision === candidate.revision
    && baseline.schemaHash === candidate.schemaHash
    && baseline.packHash === candidate.packHash
    && baseline.runtimeId === candidate.runtimeId
    && baseline.runtimeRevision === candidate.runtimeRevision;
}

function resolveAlignment(
  baseline: ComparisonSource,
  candidate: ComparisonSource,
  alignment: ComparisonAlignment,
): ComparisonModel["alignment"] {
  const baselineAnchorUs = alignment.mode === "range-start"
    ? baseline.range.startUs
    : alignment.baselineAnchorUs;
  const candidateAnchorUs = alignment.mode === "range-start"
    ? candidate.range.startUs
    : alignment.candidateAnchorUs;

  if (
    !Number.isSafeInteger(baselineAnchorUs)
    || !Number.isSafeInteger(candidateAnchorUs)
    || baselineAnchorUs < baseline.range.startUs
    || baselineAnchorUs >= baseline.range.endUs
    || candidateAnchorUs < candidate.range.startUs
    || candidateAnchorUs >= candidate.range.endUs
  ) {
    throw new RangeError("Each comparison anchor must fall inside its selected half-open range.");
  }
  if (alignment.mode === "shared-event" && alignment.label.trim().length === 0) {
    throw new TypeError("Shared-event alignment requires an operator-supplied anchor label.");
  }

  const baselineRelativeStart = baseline.range.startUs - baselineAnchorUs;
  const baselineRelativeEnd = baseline.range.endUs - baselineAnchorUs;
  const candidateRelativeStart = candidate.range.startUs - candidateAnchorUs;
  const candidateRelativeEnd = candidate.range.endUs - candidateAnchorUs;
  const startRelativeUs = Math.max(baselineRelativeStart, candidateRelativeStart);
  const endRelativeUs = Math.min(baselineRelativeEnd, candidateRelativeEnd);
  if (endRelativeUs <= startRelativeUs) {
    throw new RangeError("The selected ranges do not overlap after applying the explicit anchors.");
  }

  return {
    mode: alignment.mode,
    label: alignment.mode === "range-start" ? "Selected range starts" : alignment.label.trim(),
    baselineAnchorUs,
    candidateAnchorUs,
    overlap: {
      startRelativeUs,
      endRelativeUs,
      durationUs: endRelativeUs - startRelativeUs,
      baselineStartUs: baselineAnchorUs + startRelativeUs,
      baselineEndUs: baselineAnchorUs + endRelativeUs,
      candidateStartUs: candidateAnchorUs + startRelativeUs,
      candidateEndUs: candidateAnchorUs + endRelativeUs,
    },
    unmatched: {
      baselineBeforeUs: startRelativeUs - baselineRelativeStart,
      baselineAfterUs: baselineRelativeEnd - endRelativeUs,
      candidateBeforeUs: startRelativeUs - candidateRelativeStart,
      candidateAfterUs: candidateRelativeEnd - endRelativeUs,
    },
  };
}

function rowsInRange<T extends { offsetUs: number }>(
  rows: readonly T[],
  startUs: number,
  endUs: number,
): T[] {
  return rows.filter((row) => row.offsetUs >= startUs && row.offsetUs < endUs);
}

function diagnosticsInRange<T extends { startUs: number; endUs?: number }>(
  diagnostics: readonly T[],
  startUs: number,
  endUs: number,
): T[] {
  return diagnostics.filter((diagnostic) => diagnostic.endUs == null
    ? diagnostic.startUs >= startUs && diagnostic.startUs < endUs
    : diagnostic.startUs < endUs && diagnostic.endUs > startUs);
}

function evidenceIds(values: readonly { id: string }[]): string[] {
  return values.slice(0, 64).map((value) => value.id);
}

function rssiProvenance(
  records: readonly SourceRecord[],
): NonNullable<SourceRecord["signal"]>["provenance"][] {
  return [...new Set(records.flatMap((record) =>
    record.signal?.rssiDbm == null ? [] : [record.signal.provenance]))].sort();
}

function direction(baseline: number | null, candidate: number | null): ComparisonDirection {
  if (baseline == null || candidate == null) return "unresolved";
  const epsilon = Math.max(1e-9, Math.abs(baseline) * 1e-9, Math.abs(candidate) * 1e-9);
  if (Math.abs(candidate - baseline) <= epsilon) return "unchanged";
  return candidate > baseline ? "increased" : "decreased";
}

function assessmentFor(
  change: ComparisonDirection,
  goal: "higher" | "lower" | "neutral",
): ComparisonAssessment {
  if (change === "unresolved") return "unresolved";
  if (change === "unchanged") return "unchanged";
  if (goal === "neutral") return "unresolved";
  if (goal === "higher") return change === "increased" ? "improved" : "regressed";
  return change === "decreased" ? "improved" : "regressed";
}

function metric(
  options: Omit<ComparisonMetric, "delta" | "direction" | "assessment"> & {
    goal: "higher" | "lower" | "neutral";
  },
): ComparisonMetric {
  const { goal, ...rest } = options;
  const comparable = rest.status === "comparable";
  const change = comparable ? direction(rest.baseline, rest.candidate) : "unresolved";
  return {
    ...rest,
    delta: comparable && rest.baseline != null && rest.candidate != null
      ? rest.candidate - rest.baseline
      : null,
    direction: change,
    assessment: comparable ? assessmentFor(change, goal) : "unresolved",
  };
}

function numericFieldSamples(
  frames: readonly ComparisonFrame[],
): Map<string, {
  name: string;
  unit: string;
  values: number[];
  ids: string[];
  evidenceCount: number;
  seenIds: Set<string>;
}> {
  const samples = new Map<string, {
    name: string;
    unit: string;
    values: number[];
    ids: string[];
    evidenceCount: number;
    seenIds: Set<string>;
  }>();
  for (const frame of frames) {
    for (const field of frame.fields) {
      if (field.quality !== "valid" || typeof field.value !== "number" || !Number.isFinite(field.value)) continue;
      const unit = field.unit ?? "";
      const key = `${field.name}\u0000${unit}`;
      const sample = samples.get(key) ?? {
        name: field.name,
        unit,
        values: [],
        ids: [],
        evidenceCount: 0,
        seenIds: new Set<string>(),
      };
      sample.values.push(field.value);
      if (!sample.seenIds.has(frame.id)) {
        sample.seenIds.add(frame.id);
        sample.evidenceCount += 1;
        if (sample.ids.length < 64) sample.ids.push(frame.id);
      }
      samples.set(key, sample);
    }
  }
  return samples;
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function comparisonAreas(
  baseline: ComparisonSource,
  candidate: ComparisonSource,
  decoderMatches: boolean,
  baselineFrames: readonly ComparisonFrame[],
  candidateFrames: readonly ComparisonFrame[],
  baselineRecords: readonly SourceRecord[],
  candidateRecords: readonly SourceRecord[],
): ComparisonArea[] {
  const sameCaptureBasis = baseline.captureIntegrity.assessmentBasis
    === candidate.captureIntegrity.assessmentBasis;
  const baselineSignalProvenance = rssiProvenance(baselineRecords);
  const candidateSignalProvenance = rssiProvenance(candidateRecords);
  const hasBaselineSignal = baselineSignalProvenance.length > 0;
  const hasCandidateSignal = candidateSignalProvenance.length > 0;
  const sameSingleSignalBasis = baselineSignalProvenance.length === 1
    && candidateSignalProvenance.length === 1
    && baselineSignalProvenance[0] === candidateSignalProvenance[0];
  const signalDecoderCompatible = baselineSignalProvenance[0] !== "decoded-packet"
    || decoderMatches;
  return [
    {
      id: "alignment",
      label: "Alignment",
      status: "comparable",
      reason: "Both sources are bounded to the same explicit relative overlap.",
    },
    {
      id: "packet-evidence",
      label: "Packet evidence",
      status: !baseline.decodedFramesAvailable || !candidate.decodedFramesAvailable
        ? "unavailable"
        : !decoderMatches
          ? "not-comparable"
          : !baseline.recordsAvailable || !candidate.recordsAvailable
            ? "review-required"
            : "comparable",
      reason: !baseline.decodedFramesAvailable || !candidate.decodedFramesAvailable
        ? "Decoded packet evidence is absent from at least one input."
        : !decoderMatches
          ? "Packet deltas are withheld because decoder identity differs."
          : !baseline.recordsAvailable || !candidate.recordsAvailable
            ? "Decoded packets are present, but selected raw records are absent from at least one input."
            : "Both inputs use the exact same decoder, schema, pack, and runtime identity with selected raw records available.",
    },
    {
      id: "capture-evidence",
      label: "Capture evidence",
      status: sameCaptureBasis
        && baseline.captureIntegrity.status === "verified"
        && candidate.captureIntegrity.status === "verified"
        ? "comparable"
        : "review-required",
      reason: sameCaptureBasis
        ? `Capture assessments share the ${baseline.captureIntegrity.assessmentBasis} basis; statuses are ${baseline.captureIntegrity.status} and ${candidate.captureIntegrity.status}.`
        : `Capture assessment bases differ: ${baseline.captureIntegrity.assessmentBasis} versus ${candidate.captureIntegrity.assessmentBasis}.`,
    },
    {
      id: "diagnostics",
      label: "Diagnostics",
      status: !baseline.diagnosticsAvailable || !candidate.diagnosticsAvailable
        ? "unavailable"
        : !decoderMatches
          ? "not-comparable"
          : !baseline.recordsAvailable
            || !candidate.recordsAvailable
            || !baseline.decodedFramesAvailable
            || !candidate.decodedFramesAvailable
            ? "review-required"
            : "comparable",
      reason: !baseline.diagnosticsAvailable || !candidate.diagnosticsAvailable
        ? "Diagnostics were excluded from at least one input."
        : !decoderMatches
          ? "Diagnostic deltas are withheld because decoder execution differs."
          : !baseline.recordsAvailable
            || !candidate.recordsAvailable
            || !baseline.decodedFramesAvailable
            || !candidate.decodedFramesAvailable
            ? "Diagnostics are present, but their selected raw or decoded support is absent from at least one input."
            : "Diagnostic types share the same decoder execution contract and selected source support.",
    },
    {
      id: "decoded-fields",
      label: "Decoded fields",
      status: !baseline.decodedFramesAvailable || !candidate.decodedFramesAvailable
        ? "unavailable"
        : !decoderMatches
          ? "not-comparable"
          : !baseline.recordsAvailable || !candidate.recordsAvailable
            ? "review-required"
            : baselineFrames.length === 0 || candidateFrames.length === 0
              ? "unavailable"
              : "comparable",
      reason: !decoderMatches
        ? "Field values are not compared across decoder identities."
        : !baseline.recordsAvailable || !candidate.recordsAvailable
          ? "Decoded fields are present, but selected raw records are absent from at least one input."
          : "Only common numeric fields with an exact field name and unit are compared.",
    },
    {
      id: "link-observations",
      label: "Link observations",
      status: !hasBaselineSignal || !hasCandidateSignal
        ? "unavailable"
        : sameSingleSignalBasis && signalDecoderCompatible ? "comparable" : "not-comparable",
      reason: !hasBaselineSignal || !hasCandidateSignal
        ? "RSSI observations are absent from at least one aligned input."
        : sameSingleSignalBasis && signalDecoderCompatible
          ? `Both inputs contain bounded RSSI observations from ${baselineSignalProvenance[0]}.`
          : sameSingleSignalBasis
            ? "Decoded-packet RSSI is withheld because decoder identity differs."
            : `RSSI evidence bases differ or are mixed: baseline ${baselineSignalProvenance.join(", ")}; candidate ${candidateSignalProvenance.join(", ")}.`,
    },
  ];
}

function buildMetrics(
  baseline: ComparisonSource,
  candidate: ComparisonSource,
  alignment: ComparisonModel["alignment"],
  areas: readonly ComparisonArea[],
): ComparisonMetric[] {
  const baselineFrames = rowsInRange(
    baseline.frames,
    alignment.overlap.baselineStartUs,
    alignment.overlap.baselineEndUs,
  );
  const candidateFrames = rowsInRange(
    candidate.frames,
    alignment.overlap.candidateStartUs,
    alignment.overlap.candidateEndUs,
  );
  const baselineDiagnostics = diagnosticsInRange(
    baseline.diagnostics,
    alignment.overlap.baselineStartUs,
    alignment.overlap.baselineEndUs,
  );
  const candidateDiagnostics = diagnosticsInRange(
    candidate.diagnostics,
    alignment.overlap.candidateStartUs,
    alignment.overlap.candidateEndUs,
  );
  const baselineRecords = rowsInRange(
    baseline.records,
    alignment.overlap.baselineStartUs,
    alignment.overlap.baselineEndUs,
  );
  const candidateRecords = rowsInRange(
    candidate.records,
    alignment.overlap.candidateStartUs,
    alignment.overlap.candidateEndUs,
  );
  const seconds = alignment.overlap.durationUs / 1_000_000;
  const area = (id: ComparisonArea["id"]) => areas.find((candidateArea) => candidateArea.id === id)!;
  const packetStatus = area("packet-evidence").status;
  const diagnosticStatus = area("diagnostics").status;
  const linkStatus = area("link-observations").status;
  const packetReason = area("packet-evidence").reason;
  const diagnosticReason = area("diagnostics").reason;
  const linkReason = area("link-observations").reason;
  const baselineFailures = baselineFrames.filter((frame) => frame.integrityStatus !== "valid");
  const candidateFailures = candidateFrames.filter((frame) => frame.integrityStatus !== "valid");
  const baselineComplete = baselineFrames.filter((frame) => frame.status === "complete");
  const candidateComplete = candidateFrames.filter((frame) => frame.status === "complete");
  const baselineWarnings = baselineDiagnostics.filter((item) => item.severity === "warning");
  const candidateWarnings = candidateDiagnostics.filter((item) => item.severity === "warning");
  const baselineCritical = baselineDiagnostics.filter((item) => item.severity === "critical");
  const candidateCritical = candidateDiagnostics.filter((item) => item.severity === "critical");
  const baselineSignal = baselineRecords.flatMap((record) =>
    record.signal?.rssiDbm == null ? [] : [record.signal.rssiDbm]);
  const candidateSignal = candidateRecords.flatMap((record) =>
    record.signal?.rssiDbm == null ? [] : [record.signal.rssiDbm]);

  const metrics: ComparisonMetric[] = [
    metric({
      id: "packet-rate",
      label: "Decoded packet rate",
      category: "packets",
      unit: "frames/s",
      status: packetStatus,
      baseline: packetStatus === "unavailable" ? null : baselineFrames.length / seconds,
      candidate: packetStatus === "unavailable" ? null : candidateFrames.length / seconds,
      goal: "neutral",
      reason: `${packetReason} Traffic volume alone is not treated as better or worse.`,
      baselineEvidenceCount: baselineFrames.length,
      candidateEvidenceCount: candidateFrames.length,
      baselineEvidenceIds: evidenceIds(baselineFrames),
      candidateEvidenceIds: evidenceIds(candidateFrames),
    }),
    metric({
      id: "complete-frame-pct",
      label: "Complete decoded frames",
      category: "packets",
      unit: "%",
      status: packetStatus,
      baseline: baselineFrames.length > 0 ? (baselineComplete.length / baselineFrames.length) * 100 : null,
      candidate: candidateFrames.length > 0 ? (candidateComplete.length / candidateFrames.length) * 100 : null,
      goal: "higher",
      reason: packetReason,
      baselineEvidenceCount: baselineFrames.length,
      candidateEvidenceCount: candidateFrames.length,
      baselineEvidenceIds: evidenceIds(baselineFrames),
      candidateEvidenceIds: evidenceIds(candidateFrames),
    }),
    metric({
      id: "integrity-failure-rate",
      label: "Integrity failures",
      category: "packets",
      unit: "failures/s",
      status: packetStatus,
      baseline: packetStatus === "unavailable" ? null : baselineFailures.length / seconds,
      candidate: packetStatus === "unavailable" ? null : candidateFailures.length / seconds,
      goal: "lower",
      reason: packetReason,
      baselineEvidenceCount: baselineFailures.length,
      candidateEvidenceCount: candidateFailures.length,
      baselineEvidenceIds: evidenceIds(baselineFailures),
      candidateEvidenceIds: evidenceIds(candidateFailures),
    }),
    metric({
      id: "warning-diagnostic-rate",
      label: "Warning diagnostics",
      category: "diagnostics",
      unit: "events/s",
      status: diagnosticStatus,
      baseline: diagnosticStatus === "unavailable" ? null : baselineWarnings.length / seconds,
      candidate: diagnosticStatus === "unavailable" ? null : candidateWarnings.length / seconds,
      goal: "lower",
      reason: diagnosticReason,
      baselineEvidenceCount: baselineWarnings.length,
      candidateEvidenceCount: candidateWarnings.length,
      baselineEvidenceIds: evidenceIds(baselineWarnings),
      candidateEvidenceIds: evidenceIds(candidateWarnings),
    }),
    metric({
      id: "critical-diagnostic-rate",
      label: "Critical diagnostics",
      category: "diagnostics",
      unit: "events/s",
      status: diagnosticStatus,
      baseline: diagnosticStatus === "unavailable" ? null : baselineCritical.length / seconds,
      candidate: diagnosticStatus === "unavailable" ? null : candidateCritical.length / seconds,
      goal: "lower",
      reason: diagnosticReason,
      baselineEvidenceCount: baselineCritical.length,
      candidateEvidenceCount: candidateCritical.length,
      baselineEvidenceIds: evidenceIds(baselineCritical),
      candidateEvidenceIds: evidenceIds(candidateCritical),
    }),
    metric({
      id: "average-rssi",
      label: "Average RSSI",
      category: "link",
      unit: "dBm",
      status: linkStatus,
      baseline: average(baselineSignal),
      candidate: average(candidateSignal),
      goal: "higher",
      reason: linkReason,
      baselineEvidenceCount: baselineSignal.length,
      candidateEvidenceCount: candidateSignal.length,
      baselineEvidenceIds: evidenceIds(baselineRecords.filter((record) => record.signal?.rssiDbm != null)),
      candidateEvidenceIds: evidenceIds(candidateRecords.filter((record) => record.signal?.rssiDbm != null)),
    }),
  ];

  if (area("decoded-fields").status === "comparable") {
    const baselineFields = numericFieldSamples(baselineFrames);
    const candidateFields = numericFieldSamples(candidateFrames);
    for (const key of [...baselineFields.keys()].filter((fieldKey) => candidateFields.has(fieldKey)).sort()) {
      const baselineField = baselineFields.get(key)!;
      const candidateField = candidateFields.get(key)!;
      metrics.push(metric({
        id: `field:${encodeURIComponent(baselineField.name)}:${encodeURIComponent(baselineField.unit)}`,
        label: `${baselineField.name} average`,
        category: "decoded",
        unit: baselineField.unit || "value",
        status: "comparable",
        baseline: average(baselineField.values),
        candidate: average(candidateField.values),
        goal: "neutral",
        reason: "Exact decoder identity, field name, and unit match. Field direction is not assigned operational meaning.",
        baselineEvidenceCount: baselineField.evidenceCount,
        candidateEvidenceCount: candidateField.evidenceCount,
        baselineEvidenceIds: baselineField.ids,
        candidateEvidenceIds: candidateField.ids,
      }));
    }
  }
  return metrics;
}

function overallAssessment(
  areas: readonly ComparisonArea[],
  metrics: readonly ComparisonMetric[],
): ComparisonAssessment {
  if (areas.some((area) => area.status === "review-required" || area.status === "not-comparable")) {
    return "unresolved";
  }
  const assessments = metrics.map((metricRow) => metricRow.assessment);
  const improved = assessments.includes("improved");
  const regressed = assessments.includes("regressed");
  if (improved && !regressed) return "improved";
  if (regressed && !improved) return "regressed";
  if (!improved && !regressed && assessments.some((value) => value === "unchanged")) return "unchanged";
  return "unresolved";
}

export function compareSources(
  baseline: ComparisonSource,
  candidate: ComparisonSource,
  requestedAlignment: ComparisonAlignment,
): ComparisonModel {
  const alignment = resolveAlignment(baseline, candidate, requestedAlignment);
  const decoderMatches = sameDecoder(baseline.decoder, candidate.decoder);
  const baselineFrames = rowsInRange(
    baseline.frames,
    alignment.overlap.baselineStartUs,
    alignment.overlap.baselineEndUs,
  );
  const candidateFrames = rowsInRange(
    candidate.frames,
    alignment.overlap.candidateStartUs,
    alignment.overlap.candidateEndUs,
  );
  const baselineRecords = rowsInRange(
    baseline.records,
    alignment.overlap.baselineStartUs,
    alignment.overlap.baselineEndUs,
  );
  const candidateRecords = rowsInRange(
    candidate.records,
    alignment.overlap.candidateStartUs,
    alignment.overlap.candidateEndUs,
  );
  const areas = comparisonAreas(
    baseline,
    candidate,
    decoderMatches,
    baselineFrames,
    candidateFrames,
    baselineRecords,
    candidateRecords,
  );
  const metrics = buildMetrics(baseline, candidate, alignment, areas);
  const limitations = [
    "Alignment is operator-declared; ReplayCase does not infer synchronized source clocks.",
    "Only the aligned intersection is used for numeric deltas; unmatched range tails remain excluded.",
    "A metric assessment describes observed evidence, not causal attribution.",
    ...baseline.limitations.map((value) => `Baseline: ${value}`),
    ...candidate.limitations.map((value) => `Candidate: ${value}`),
    ...areas.filter((area) => area.status !== "comparable").map((area) => `${area.label}: ${area.reason}`),
  ];
  return deepFreeze({
    baseline,
    candidate,
    alignment,
    areas,
    metrics,
    assessment: overallAssessment(areas, metrics),
    limitations: [...new Set(limitations)],
  });
}

function findingInput(
  source: ComparisonSource,
  alignedStartUs: number,
  alignedEndUs: number,
): ComparisonFindingInput {
  const records = rowsInRange(source.records, alignedStartUs, alignedEndUs);
  const frames = rowsInRange(source.frames, alignedStartUs, alignedEndUs);
  const diagnostics = diagnosticsInRange(source.diagnostics, alignedStartUs, alignedEndUs);
  const signalRecords = records.filter((record) => record.signal?.rssiDbm != null);
  return {
    kind: source.kind,
    identity: source.identity,
    title: source.title,
    sessionId: source.sessionId,
    startedAt: source.startedAt,
    displayTimeZone: source.displayTimeZone,
    durationUs: source.durationUs,
    sourceId: source.sourceId,
    range: {
      ...source.range,
      rangeSemantics: COMPARISON_RANGE_SEMANTICS,
    },
    decoder: source.decoder,
    captureEvidence: {
      status: source.captureIntegrity.status,
      assessmentBasis: source.captureIntegrity.assessmentBasis,
      evidenceCompleteness: source.evidenceCompleteness,
    },
    evidenceAvailability: {
      records: source.recordsAvailable,
      decodedFrames: source.decodedFramesAvailable,
      diagnostics: source.diagnosticsAvailable,
    },
    alignedEvidence: {
      recordCount: records.length,
      decodedFrameCount: frames.length,
      diagnosticCount: diagnostics.length,
      rssiObservationCount: signalRecords.length,
      rssiProvenance: rssiProvenance(signalRecords),
    },
  };
}

function findingPayload(
  finding: Omit<ComparisonFinding, "identity"> | ComparisonFinding,
): Omit<ComparisonFinding, "identity"> {
  const { identity: _identity, ...payload } = finding as ComparisonFinding;
  return payload;
}

export function comparisonFindingHash(
  finding: Omit<ComparisonFinding, "identity"> | ComparisonFinding,
): string {
  return sha256Hex(TEXT_ENCODER.encode(canonicalJson(findingPayload(finding))));
}

const boundedText = (maximum: number) => z.string().min(1).max(maximum);
const safeOffset = z.number().int().nonnegative().safe();
const signedSafeOffset = z.number().int().safe();
const nullableFinite = z.number().finite().nullable();
const comparisonStatusSchema = z.enum(["comparable", "review-required", "not-comparable", "unavailable"]);
const assessmentSchema = z.enum(["improved", "regressed", "unchanged", "unresolved"]);
const directionSchema = z.enum(["increased", "decreased", "unchanged", "unresolved"]);
const decoderIdentitySchema = z.object({
  id: boundedText(128),
  revision: boundedText(64),
  schemaHash: z.string().regex(SHA256_PATTERN),
  packHash: z.string().regex(SHA256_PATTERN).nullable(),
  runtimeId: z.string().min(1).max(128).nullable(),
  runtimeRevision: z.string().min(1).max(64).nullable(),
}).strict();
const findingRangeSchema = z.object({
  id: z.string().min(1).max(240).nullable(),
  title: boundedText(240),
  startUs: safeOffset,
  endUs: safeOffset,
  rangeSemantics: z.literal(COMPARISON_RANGE_SEMANTICS),
}).strict().refine((range) => range.endUs > range.startUs, "Comparison range must be non-empty.");
const findingInputSchema = z.object({
  kind: z.enum(["session", "evidence-bundle"]),
  identity: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  title: boundedText(240),
  sessionId: boundedText(240),
  startedAt: z.string().datetime({ offset: true }),
  displayTimeZone: boundedText(128),
  durationUs: safeOffset.refine((value) => value > 0, "Source duration must be positive."),
  sourceId: boundedText(240),
  range: findingRangeSchema,
  decoder: decoderIdentitySchema,
  captureEvidence: z.object({
    status: z.enum(["verified", "incomplete", "unknown"]),
    assessmentBasis: z.enum([
      "udp-bridge-reconciled",
      "udp-browser-observed",
      "web-serial-observed",
      "recorder-only",
      "file-source-unassessed",
      "legacy-v1",
    ]),
    evidenceCompleteness: z.enum(["verified", "incomplete", "unknown"]),
  }).strict(),
  evidenceAvailability: z.object({
    records: z.boolean(),
    decodedFrames: z.boolean(),
    diagnostics: z.boolean(),
  }).strict(),
  alignedEvidence: z.object({
    recordCount: safeOffset,
    decodedFrameCount: safeOffset,
    diagnosticCount: safeOffset,
    rssiObservationCount: safeOffset,
    rssiProvenance: z.array(z.enum(["gateway-sidecar", "decoded-packet"])).max(2),
  }).strict(),
}).strict();
const areaSchema = z.object({
  id: z.enum([
    "alignment",
    "packet-evidence",
    "capture-evidence",
    "diagnostics",
    "decoded-fields",
    "link-observations",
  ]),
  label: boundedText(120),
  status: comparisonStatusSchema,
  reason: boundedText(2_000),
}).strict();
const metricSchema = z.object({
  id: boundedText(512),
  label: boundedText(240),
  category: z.enum(["packets", "diagnostics", "link", "decoded"]),
  unit: boundedText(64),
  status: comparisonStatusSchema,
  baseline: nullableFinite,
  candidate: nullableFinite,
  delta: nullableFinite,
  direction: directionSchema,
  assessment: assessmentSchema,
  reason: boundedText(2_000),
  baselineEvidenceCount: safeOffset,
  candidateEvidenceCount: safeOffset,
  baselineEvidenceIds: z.array(boundedText(240)).max(64),
  candidateEvidenceIds: z.array(boundedText(240)).max(64),
}).strict();
const alignmentSchema = z.object({
  mode: z.enum(["range-start", "shared-event"]),
  label: boundedText(240),
  baselineAnchorUs: safeOffset,
  candidateAnchorUs: safeOffset,
  overlap: z.object({
    startRelativeUs: signedSafeOffset,
    endRelativeUs: signedSafeOffset,
    durationUs: safeOffset,
    baselineStartUs: safeOffset,
    baselineEndUs: safeOffset,
    candidateStartUs: safeOffset,
    candidateEndUs: safeOffset,
  }).strict(),
  unmatched: z.object({
    baselineBeforeUs: safeOffset,
    baselineAfterUs: safeOffset,
    candidateBeforeUs: safeOffset,
    candidateAfterUs: safeOffset,
  }).strict(),
}).strict();

export const comparisonFindingSchema = z.object({
  format: z.literal(COMPARISON_FINDING_FORMAT),
  formatVersion: z.literal(COMPARISON_FINDING_FORMAT_VERSION),
  generatedAt: z.string().datetime({ offset: true }),
  identity: z.object({
    algorithm: z.literal("SHA-256"),
    canonicalSha256: z.string().regex(SHA256_PATTERN),
  }).strict(),
  inputs: z.object({
    baseline: findingInputSchema,
    candidate: findingInputSchema,
  }).strict(),
  alignment: alignmentSchema,
  comparability: z.array(areaSchema).length(6),
  metrics: z.array(metricSchema).min(1).max(512),
  assessment: assessmentSchema,
  conclusion: z.string().max(MAX_COMPARISON_CONCLUSION_LENGTH),
  limitations: z.array(boundedText(2_000)).max(128),
}).strict();

export class ComparisonFindingValidationError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "ComparisonFindingValidationError";
    this.details = details;
  }
}

function nearlyEqual(left: number, right: number): boolean {
  const tolerance = Math.max(1e-9, Math.abs(left) * 1e-9, Math.abs(right) * 1e-9);
  return Math.abs(left - right) <= tolerance;
}

function metricGoal(metricId: string): "higher" | "lower" | "neutral" {
  if (metricId === "complete-frame-pct" || metricId === "average-rssi") return "higher";
  if (
    metricId === "integrity-failure-rate"
    || metricId === "warning-diagnostic-rate"
    || metricId === "critical-diagnostic-rate"
  ) return "lower";
  return "neutral";
}

const AREA_LABELS: Record<ComparisonArea["id"], string> = {
  alignment: "Alignment",
  "packet-evidence": "Packet evidence",
  "capture-evidence": "Capture evidence",
  diagnostics: "Diagnostics",
  "decoded-fields": "Decoded fields",
  "link-observations": "Link observations",
};

const CORE_METRIC_CONTRACT = {
  "packet-rate": { category: "packets", unit: "frames/s", areaId: "packet-evidence" },
  "complete-frame-pct": { category: "packets", unit: "%", areaId: "packet-evidence" },
  "integrity-failure-rate": { category: "packets", unit: "failures/s", areaId: "packet-evidence" },
  "warning-diagnostic-rate": { category: "diagnostics", unit: "events/s", areaId: "diagnostics" },
  "critical-diagnostic-rate": { category: "diagnostics", unit: "events/s", areaId: "diagnostics" },
  "average-rssi": { category: "link", unit: "dBm", areaId: "link-observations" },
} as const;

function sameStringValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectedFindingAreaStatuses(
  baseline: ComparisonFindingInput,
  candidate: ComparisonFindingInput,
): Record<ComparisonArea["id"], ComparisonStatus> {
  const decoderMatches = sameDecoder(baseline.decoder, candidate.decoder);
  const baselineSignalBasis = baseline.alignedEvidence.rssiProvenance;
  const candidateSignalBasis = candidate.alignedEvidence.rssiProvenance;
  const hasBothSignal = baseline.alignedEvidence.rssiObservationCount > 0
    && candidate.alignedEvidence.rssiObservationCount > 0;
  return {
    alignment: "comparable",
    "packet-evidence": !baseline.evidenceAvailability.decodedFrames
      || !candidate.evidenceAvailability.decodedFrames
      ? "unavailable"
      : !decoderMatches
        ? "not-comparable"
        : !baseline.evidenceAvailability.records || !candidate.evidenceAvailability.records
          ? "review-required"
          : "comparable",
    "capture-evidence": baseline.captureEvidence.assessmentBasis
      === candidate.captureEvidence.assessmentBasis
      && baseline.captureEvidence.status === "verified"
      && candidate.captureEvidence.status === "verified"
      ? "comparable"
      : "review-required",
    diagnostics: !baseline.evidenceAvailability.diagnostics
      || !candidate.evidenceAvailability.diagnostics
      ? "unavailable"
      : !decoderMatches
        ? "not-comparable"
        : !baseline.evidenceAvailability.records
          || !candidate.evidenceAvailability.records
          || !baseline.evidenceAvailability.decodedFrames
          || !candidate.evidenceAvailability.decodedFrames
          ? "review-required"
          : "comparable",
    "decoded-fields": !baseline.evidenceAvailability.decodedFrames
      || !candidate.evidenceAvailability.decodedFrames
      ? "unavailable"
      : !decoderMatches
        ? "not-comparable"
        : !baseline.evidenceAvailability.records || !candidate.evidenceAvailability.records
          ? "review-required"
          : baseline.alignedEvidence.decodedFrameCount === 0
            || candidate.alignedEvidence.decodedFrameCount === 0
            ? "unavailable"
            : "comparable",
    "link-observations": !hasBothSignal
      ? "unavailable"
      : baselineSignalBasis.length === 1
        && candidateSignalBasis.length === 1
        && baselineSignalBasis[0] === candidateSignalBasis[0]
        && (baselineSignalBasis[0] !== "decoded-packet" || decoderMatches)
        ? "comparable"
        : "not-comparable",
  };
}

function assertFindingSemantics(finding: ComparisonFinding): void {
  const details: string[] = [];
  const { baseline, candidate } = finding.inputs;
  const { alignment } = finding;
  const baselineRange = baseline.range;
  const candidateRange = candidate.range;
  for (const [label, input] of [["Baseline", baseline], ["Candidate", candidate]] as const) {
    const evidence = input.alignedEvidence;
    const canonicalSignalProvenance = [...new Set(evidence.rssiProvenance)].sort();
    if (input.range.endUs > input.durationUs) {
      details.push(`${label} range exceeds its declared source duration.`);
    }
    if (
      (!input.evidenceAvailability.records && evidence.recordCount !== 0)
      || (!input.evidenceAvailability.decodedFrames && evidence.decodedFrameCount !== 0)
      || (!input.evidenceAvailability.diagnostics && evidence.diagnosticCount !== 0)
    ) {
      details.push(`${label} aligned counts contradict its evidence-availability claims.`);
    }
    if (
      evidence.rssiObservationCount > evidence.recordCount
      || (evidence.rssiObservationCount === 0) !== (evidence.rssiProvenance.length === 0)
      || !sameStringValues(evidence.rssiProvenance, canonicalSignalProvenance)
    ) {
      details.push(`${label} RSSI observations do not reconcile with its record count and evidence bases.`);
    }
  }
  if (
    alignment.baselineAnchorUs < baselineRange.startUs
    || alignment.baselineAnchorUs >= baselineRange.endUs
    || alignment.candidateAnchorUs < candidateRange.startUs
    || alignment.candidateAnchorUs >= candidateRange.endUs
  ) {
    details.push("Alignment anchors must fall inside their declared input ranges.");
  }

  const baselineRelativeStart = baselineRange.startUs - alignment.baselineAnchorUs;
  const baselineRelativeEnd = baselineRange.endUs - alignment.baselineAnchorUs;
  const candidateRelativeStart = candidateRange.startUs - alignment.candidateAnchorUs;
  const candidateRelativeEnd = candidateRange.endUs - alignment.candidateAnchorUs;
  const expectedStart = Math.max(baselineRelativeStart, candidateRelativeStart);
  const expectedEnd = Math.min(baselineRelativeEnd, candidateRelativeEnd);
  const overlap = alignment.overlap;
  if (
    expectedEnd <= expectedStart
    || overlap.startRelativeUs !== expectedStart
    || overlap.endRelativeUs !== expectedEnd
    || overlap.durationUs !== expectedEnd - expectedStart
    || overlap.baselineStartUs !== alignment.baselineAnchorUs + expectedStart
    || overlap.baselineEndUs !== alignment.baselineAnchorUs + expectedEnd
    || overlap.candidateStartUs !== alignment.candidateAnchorUs + expectedStart
    || overlap.candidateEndUs !== alignment.candidateAnchorUs + expectedEnd
  ) {
    details.push("The aligned overlap does not reconcile with the input ranges and anchors.");
  }
  if (
    alignment.unmatched.baselineBeforeUs !== expectedStart - baselineRelativeStart
    || alignment.unmatched.baselineAfterUs !== baselineRelativeEnd - expectedEnd
    || alignment.unmatched.candidateBeforeUs !== expectedStart - candidateRelativeStart
    || alignment.unmatched.candidateAfterUs !== candidateRelativeEnd - expectedEnd
  ) {
    details.push("Unmatched range tails do not reconcile with the aligned overlap.");
  }
  if (
    alignment.mode === "range-start"
    && (
      alignment.baselineAnchorUs !== baselineRange.startUs
      || alignment.candidateAnchorUs !== candidateRange.startUs
      || alignment.label !== "Selected range starts"
    )
  ) {
    details.push("Range-start alignment must use both selected range starts and the canonical label.");
  }

  const expectedAreaIds: ComparisonArea["id"][] = [
    "alignment",
    "packet-evidence",
    "capture-evidence",
    "diagnostics",
    "decoded-fields",
    "link-observations",
  ];
  const areaIds = finding.comparability.map((area) => area.id);
  if (
    new Set(areaIds).size !== expectedAreaIds.length
    || expectedAreaIds.some((id) => !areaIds.includes(id))
  ) {
    details.push("Comparability must contain each required area exactly once.");
  }
  const areaById = new Map(finding.comparability.map((area) => [area.id, area]));
  const expectedAreaStatuses = expectedFindingAreaStatuses(baseline, candidate);
  for (const id of expectedAreaIds) {
    const area = areaById.get(id);
    if (
      area != null
      && (area.label !== AREA_LABELS[id] || area.status !== expectedAreaStatuses[id])
    ) {
      details.push(`Comparability area ${id} contradicts the declared input evidence.`);
    }
  }

  const metricIds = new Set<string>();
  for (const metricRow of finding.metrics) {
    if (metricIds.has(metricRow.id)) {
      details.push(`Metric id ${metricRow.id} is duplicated.`);
      continue;
    }
    metricIds.add(metricRow.id);
    if (
      new Set(metricRow.baselineEvidenceIds).size !== metricRow.baselineEvidenceIds.length
      || new Set(metricRow.candidateEvidenceIds).size !== metricRow.candidateEvidenceIds.length
      || metricRow.baselineEvidenceIds.length !== Math.min(metricRow.baselineEvidenceCount, 64)
      || metricRow.candidateEvidenceIds.length !== Math.min(metricRow.candidateEvidenceCount, 64)
    ) {
      details.push(`Metric ${metricRow.id} evidence counts do not reconcile with its bounded source IDs.`);
    }

    const coreContract = CORE_METRIC_CONTRACT[
      metricRow.id as keyof typeof CORE_METRIC_CONTRACT
    ];
    if (coreContract == null) {
      if (
        !metricRow.id.startsWith("field:")
        || metricRow.category !== "decoded"
        || metricRow.status !== expectedAreaStatuses["decoded-fields"]
        || metricRow.status !== "comparable"
      ) {
        details.push(`Metric ${metricRow.id} is not valid for the declared comparison contract.`);
      }
    } else if (
      metricRow.category !== coreContract.category
      || metricRow.unit !== coreContract.unit
      || metricRow.status !== expectedAreaStatuses[coreContract.areaId]
    ) {
      details.push(`Metric ${metricRow.id} contradicts its required category, unit, or comparability area.`);
    }

    const hasBothValues = metricRow.baseline != null && metricRow.candidate != null;
    const expectedDelta = hasBothValues ? metricRow.candidate! - metricRow.baseline! : null;
    const expectedDirection = metricRow.status === "comparable"
      ? direction(metricRow.baseline, metricRow.candidate)
      : "unresolved";
    const expectedAssessment = metricRow.status === "comparable"
      ? assessmentFor(expectedDirection, metricGoal(metricRow.id))
      : "unresolved";
    if (
      metricRow.status !== "comparable"
      && (metricRow.delta !== null || metricRow.direction !== "unresolved" || metricRow.assessment !== "unresolved")
    ) {
      details.push(`Metric ${metricRow.id} declares a delta or finding without comparable evidence.`);
    } else if (
      metricRow.status === "comparable"
      && (
        (expectedDelta == null) !== (metricRow.delta == null)
        || (expectedDelta != null && metricRow.delta != null && !nearlyEqual(metricRow.delta, expectedDelta))
        || metricRow.direction !== expectedDirection
        || metricRow.assessment !== expectedAssessment
      )
    ) {
      details.push(`Metric ${metricRow.id} does not reconcile with its source values and assessment rule.`);
    }

    const durationSeconds = alignment.overlap.durationUs / 1_000_000;
    const baselineAligned = baseline.alignedEvidence;
    const candidateAligned = candidate.alignedEvidence;
    const checkRate = (
      baselineCount: number,
      candidateCount: number,
      baselineValue: number | null,
      candidateValue: number | null,
    ) => {
      if (
        baselineValue == null
        || candidateValue == null
        || !nearlyEqual(baselineValue, baselineCount / durationSeconds)
        || !nearlyEqual(candidateValue, candidateCount / durationSeconds)
      ) {
        details.push(`Metric ${metricRow.id} does not reconcile with its aligned evidence counts.`);
      }
    };
    if (metricRow.id === "packet-rate") {
      if (
        metricRow.baselineEvidenceCount !== baselineAligned.decodedFrameCount
        || metricRow.candidateEvidenceCount !== candidateAligned.decodedFrameCount
      ) {
        details.push("Packet-rate evidence counts do not match the aligned decoded-frame counts.");
      }
      if (metricRow.status !== "unavailable") {
        checkRate(
          baselineAligned.decodedFrameCount,
          candidateAligned.decodedFrameCount,
          metricRow.baseline,
          metricRow.candidate,
        );
      }
    } else if (metricRow.id === "complete-frame-pct") {
      if (
        metricRow.baselineEvidenceCount !== baselineAligned.decodedFrameCount
        || metricRow.candidateEvidenceCount !== candidateAligned.decodedFrameCount
      ) {
        details.push("Complete-frame evidence counts do not match the aligned decoded-frame counts.");
      }
    } else if (metricRow.id === "integrity-failure-rate") {
      if (
        metricRow.baselineEvidenceCount > baselineAligned.decodedFrameCount
        || metricRow.candidateEvidenceCount > candidateAligned.decodedFrameCount
      ) {
        details.push("Integrity-failure evidence exceeds the aligned decoded-frame counts.");
      }
      if (metricRow.status !== "unavailable") {
        checkRate(
          metricRow.baselineEvidenceCount,
          metricRow.candidateEvidenceCount,
          metricRow.baseline,
          metricRow.candidate,
        );
      }
    } else if (
      metricRow.id === "warning-diagnostic-rate"
      || metricRow.id === "critical-diagnostic-rate"
    ) {
      if (
        metricRow.baselineEvidenceCount > baselineAligned.diagnosticCount
        || metricRow.candidateEvidenceCount > candidateAligned.diagnosticCount
      ) {
        details.push(`${metricRow.id} evidence exceeds the aligned diagnostic counts.`);
      }
      if (metricRow.status !== "unavailable") {
        checkRate(
          metricRow.baselineEvidenceCount,
          metricRow.candidateEvidenceCount,
          metricRow.baseline,
          metricRow.candidate,
        );
      }
    } else if (
      metricRow.id === "average-rssi"
      && (
        metricRow.baselineEvidenceCount !== baselineAligned.rssiObservationCount
        || metricRow.candidateEvidenceCount !== candidateAligned.rssiObservationCount
      )
    ) {
      details.push("Average-RSSI evidence counts do not match the aligned RSSI observations.");
    }
  }
  for (const requiredMetricId of Object.keys(CORE_METRIC_CONTRACT)) {
    if (!metricIds.has(requiredMetricId)) {
      details.push(`Required metric ${requiredMetricId} is missing.`);
    }
  }
  if (finding.assessment !== overallAssessment(finding.comparability, finding.metrics)) {
    details.push("The overall assessment does not reconcile with comparability and metric findings.");
  }
  if (details.length > 0) {
    throw new ComparisonFindingValidationError(
      "The comparison finding contains contradictory range or metric evidence.",
      details.slice(0, 8),
    );
  }
}

export function validateComparisonFinding(input: unknown): ComparisonFinding {
  const result = comparisonFindingSchema.safeParse(input);
  if (!result.success) {
    throw new ComparisonFindingValidationError(
      "The comparison finding does not match the ReplayCase format.",
      result.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "finding"}: ${issue.message}`),
    );
  }
  const finding = result.data as ComparisonFinding;
  assertFindingSemantics(finding);
  const actualHash = comparisonFindingHash(finding);
  if (actualHash !== finding.identity.canonicalSha256) {
    throw new ComparisonFindingValidationError("The comparison finding content does not match its declared identity.", [
      `Declared ${finding.identity.canonicalSha256}`,
      `Calculated ${actualHash}`,
    ]);
  }
  const bytes = TEXT_ENCODER.encode(canonicalJson(finding, true)).byteLength;
  if (bytes > MAX_COMPARISON_FINDING_BYTES) {
    throw new ComparisonFindingValidationError(
      `The comparison finding exceeds the ${MAX_COMPARISON_FINDING_BYTES}-byte limit.`,
    );
  }
  return deepFreeze(finding);
}

export function buildComparisonFinding(
  model: ComparisonModel,
  conclusion: string,
  generatedAt = new Date().toISOString(),
): ComparisonFinding {
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new TypeError("generatedAt must be an ISO-compatible timestamp.");
  }
  if (conclusion.length > MAX_COMPARISON_CONCLUSION_LENGTH) {
    throw new RangeError(`Comparison conclusions cannot exceed ${MAX_COMPARISON_CONCLUSION_LENGTH} characters.`);
  }
  const payload: Omit<ComparisonFinding, "identity"> = {
    format: COMPARISON_FINDING_FORMAT,
    formatVersion: COMPARISON_FINDING_FORMAT_VERSION,
    generatedAt,
    inputs: {
      baseline: findingInput(
        model.baseline,
        model.alignment.overlap.baselineStartUs,
        model.alignment.overlap.baselineEndUs,
      ),
      candidate: findingInput(
        model.candidate,
        model.alignment.overlap.candidateStartUs,
        model.alignment.overlap.candidateEndUs,
      ),
    },
    alignment: model.alignment,
    comparability: model.areas,
    metrics: model.metrics,
    assessment: model.assessment,
    conclusion,
    limitations: model.limitations,
  };
  return validateComparisonFinding({
    ...payload,
    identity: {
      algorithm: "SHA-256",
      canonicalSha256: comparisonFindingHash(payload),
    },
  });
}

export function serializeComparisonFinding(finding: ComparisonFinding): string {
  return `${canonicalJson(validateComparisonFinding(finding), true)}\n`;
}

export function suggestComparisonFindingFilename(model: ComparisonModel): string {
  const slug = `${model.baseline.sessionId}-vs-${model.candidate.sessionId}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return `${slug || "replaycase-comparison"}.nlcompare.json`;
}

/** Starts a local browser download without transmitting either source or the finding. */
export function downloadComparisonFinding(
  finding: ComparisonFinding,
  filename: string,
): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("Comparison finding downloads require a browser document.");
  }
  const url = URL.createObjectURL(new Blob(
    [serializeComparisonFinding(finding)],
    { type: "application/vnd.narrowslink.comparison-finding+json" },
  ));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.endsWith(".nlcompare.json") ? filename : `${filename}.nlcompare.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
