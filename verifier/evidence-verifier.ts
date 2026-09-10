import { z, type ZodType } from "zod";

import { sha256Hex } from "../src/domain/canonical";
import {
  EVIDENCE_ARCHIVE_LIMITS,
  EVIDENCE_ARTIFACT_MEDIA_TYPES,
  EVIDENCE_ENCODED_SOURCE_RECORD_ID_CHARACTERS,
  EVIDENCE_FRAME_ID_CHARACTERS,
  EVIDENCE_RANGE_SEMANTICS,
  EVIDENCE_SOURCE_RECORD_ID_CHARACTERS,
  MANDATORY_EVIDENCE_ARTIFACT_PATHS,
  OPTIONAL_EVIDENCE_ARTIFACT_GROUPS,
  SUPPORTED_EVIDENCE_BUNDLE_FORMAT_VERSIONS,
  evidenceBundleManifestSchema,
  evidenceDiagnosticsDocumentSchema,
  evidenceMarkersDocumentSchema,
  evidenceNotesDocumentSchema,
  evidenceTransportEventsDocumentSchema,
  evidenceTransportJournalDocumentSchema,
  evidenceTransportProvenanceDocumentSchema,
  type EvidenceArtifactPath,
  type EvidenceBundleManifest,
  type EvidenceDiagnostic,
  type EvidenceMarker,
  type EvidenceNote,
  type EvidenceTransportJournalDocument,
  type EvidenceTransportProvenanceDocument,
} from "../src/domain/evidence-contract";
import { decodeRecord, resolveDecoderPack } from "../src/domain/decoder";
import { verifyDecoderPackConformance } from "../src/domain/decoder-conformance";
import {
  decoderPackDocumentSchema,
  type DecoderDescriptor,
  type DecoderPackDocument,
} from "../src/domain/decoder-pack";
import {
  captureIntegrityReceiptSchema,
  sourceRecordSchema,
  sourceRecordV1Schema,
  type CaptureIntegrityReceipt,
  type DecodedField,
  type IntegrityStatus,
  type SourceRecord,
  type TransportEvent,
  type UdpBridgeJournal,
  type UdpRemoteEndpoint,
} from "../src/domain/types";
import { EvidenceZipError, readEvidenceZip } from "./evidence-zip";

export type EvidenceVerificationErrorCode =
  | "ARCHIVE_IO_ERROR"
  | "ARCHIVE_LIMIT_EXCEEDED"
  | "ARCHIVE_UNSAFE"
  | "ARCHIVE_STRUCTURE_INVALID"
  | "ARTIFACT_CONTRACT_MISMATCH"
  | "CHECKSUM_MISMATCH"
  | "CONTENT_INVALID"
  | "SEMANTIC_MISMATCH"
  | "UNSUPPORTED_BUNDLE_VERSION";

export class EvidenceVerificationError extends Error {
  readonly code: EvidenceVerificationErrorCode;
  readonly path?: string;

  constructor(code: EvidenceVerificationErrorCode, message: string, path?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvidenceVerificationError";
    this.code = code;
    this.path = path;
  }
}

export interface EvidenceVerificationReport {
  format: "narrowslink/bundle-verification-report";
  formatVersion: 1;
  integrity: "internally-consistent";
  evidence: "verified" | "incomplete" | "unknown";
  captureEvidence: CaptureIntegrityReceipt["status"];
  provenanceEvidence: EvidenceBundleManifest["provenance"]["status"];
  authenticity: "not-established";
  bundle: {
    bytes: number;
    sha256: string;
  };
  selection: EvidenceBundleManifest["selection"];
  session: {
    id: string;
    title: string;
    formatVersion: 1 | 2;
    sourceId: string;
    decoderId: string;
    decoderRevision: string;
    schemaHash: string;
    packHash: string | null;
    runtimeId: string | null;
    runtimeRevision: string | null;
  };
  artifacts: {
    count: number;
    paths: EvidenceArtifactPath[];
  };
  warnings: string[];
}

export interface VerifiedEvidenceBundle {
  paths: string[];
  manifest: EvidenceBundleManifest;
  rawRecords: SourceRecord[];
  decodedPackets: VerifiedDecodedPacket[];
  decodedRecordCount: number;
  diagnostics: EvidenceDiagnostic[];
  markers: EvidenceMarker[];
  notes: EvidenceNote[];
  transportEvents: TransportEvent[];
  integrityReceipt: CaptureIntegrityReceipt;
  transportProvenance: EvidenceTransportProvenanceDocument;
  transportJournal: EvidenceTransportJournalDocument;
  decoderPack: DecoderPackDocument | null;
  report: EvidenceVerificationReport;
}

export interface VerifiedDecodedPacket {
  id: string;
  ordinal: number;
  offsetUs: number;
  sourceRecordId: string;
  status: "complete" | "partial" | "invalid";
  integrityStatus: IntegrityStatus["status"];
  protocolVersion: number | null;
  familyId: number | null;
  familyName: string;
  sequence: number | null;
  deviceTimeMs: number | null;
  payloadLength: number | null;
  integrity: IntegrityStatus;
  fields: DecodedField[];
}

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const TEXT_ENCODER = new TextEncoder();
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FORMULA_PATTERN = /^[\t\r ]*[=+\-@]/;
const UDP_CAPTURE_ISSUE_CODES = new Set([
  "udp-event-sequence-discontinuity",
  "udp-counter-mismatch",
  "udp-kernel-drops-observed",
  "udp-bridge-error",
  "udp-event-stream-disconnected",
  "capture-backpressure",
  "capture-limit",
  "shutdown-unconfirmed",
  "duration-capped",
  "event-log-incomplete",
  "transport-provenance-incomplete",
]);
const SERIAL_CAPTURE_ISSUE_CODES = new Set([
  "capture-backpressure",
  "capture-limit",
  "serial-read-error",
  "serial-disconnected",
  "serial-tail-recovery-failed",
  "serial-counter-mismatch",
  "shutdown-unconfirmed",
  "duration-capped",
  "event-log-incomplete",
  "transport-provenance-incomplete",
]);

function spreadsheetSafeText(value: string): string {
  return value.startsWith("'") || FORMULA_PATTERN.test(value) ? `'${value}` : value;
}

function spreadsheetTextRepresentations(value: string): string[] {
  const current = spreadsheetSafeText(value);
  const legacy = FORMULA_PATTERN.test(value) ? `'${value}` : value;
  return current === legacy ? [current] : [current, legacy];
}

function originalSpreadsheetText(value: string): string {
  if (
    value.startsWith("'")
    && (value.slice(1).startsWith("'") || FORMULA_PATTERN.test(value.slice(1)))
  ) return value.slice(1);
  return value;
}

const decodedIntegritySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("valid"), checksum: z.number().int().min(0).max(65_535) }).strict(),
  z.object({
    status: z.literal("crc-failed"),
    expected: z.number().int().min(0).max(65_535),
    actual: z.number().int().min(0).max(65_535),
  }).strict(),
  z.object({
    status: z.literal("checksum-failed"),
    algorithm: z.string().min(1).max(64),
    expected: z.number().int().min(0).max(65_535),
    actual: z.number().int().min(0).max(65_535),
  }).strict(),
  z.object({
    status: z.enum(["truncated", "invalid-length", "unknown-family", "unsupported-version"]),
    reason: z.string().min(1).max(2_000),
  }).strict(),
]);

const decodedFieldSchema = z.object({
  name: z.string().min(1).max(128),
  raw: z.union([z.number().finite(), z.string().max(2_000), z.boolean()]),
  value: z.union([z.number().finite(), z.string().max(2_000), z.boolean(), z.null()]),
  unit: z.string().min(1).max(64).optional(),
  quality: z.enum(["valid", "out-of-range", "unavailable"]),
}).strict();

const schemaArtifactSchema = z.object({
  schema: z.object({
    id: z.string().min(1).max(128),
    revision: z.string().min(1).max(64),
    declaredSha256: z.string().regex(SHA256_PATTERN),
    packSha256: z.string().regex(SHA256_PATTERN).optional(),
    runtimeId: z.enum(["nsl01-binary-v1", "nmea0183-line-v1"]).optional(),
    runtimeRevision: z.literal("1").optional(),
    artifactIntegrity: z.literal("The evidence manifest independently hashes this exported schema artifact."),
  }).strict().superRefine((schema, context) => {
    const identityFields = [schema.packSha256, schema.runtimeId, schema.runtimeRevision];
    const present = identityFields.filter((value) => value != null).length;
    if (present !== 0 && present !== identityFields.length) {
      context.addIssue({
        code: "custom",
        message: "Decoder pack and runtime identity fields must be declared together.",
      });
    }
  }),
  sessionFormat: z.object({
    id: z.literal("narrowslink/session"),
    version: z.union([z.literal(1), z.literal(2)]),
  }).strict(),
  timing: z.object({
    displayTimeZone: z.string().min(1).max(100),
    offsetUnit: z.literal("integer microseconds from session.startedAt"),
    rangeSemantics: z.literal(EVIDENCE_RANGE_SEMANTICS),
    sessionStartedAt: z.string().max(64).datetime({ offset: true }),
  }).strict(),
  transportEvidence: z.object({
    eventRangeSemantics: z.string().min(1).max(500),
    sessionScopeEvents: z.string().min(1).max(500),
    integrityReceiptScope: z.literal("whole session"),
    provenanceScope: z.literal("whole session"),
    bridgeJournalScope: z.string().min(1).max(500),
  }).strict(),
  decoder: z.unknown(),
  decoderPack: decoderPackDocumentSchema.optional(),
}).strict();

const DECODED_HEADER = [
  "frame_id",
  "ordinal",
  "offset_us",
  "source_record_id",
  "status",
  "integrity",
  "protocol_version",
  "family_id",
  "family_name",
  "sequence",
  "device_time_ms",
  "payload_length",
  "integrity_json",
  "fields_json",
] as const;

const DIAGNOSTICS_HEADER = [
  "diagnostic_id",
  "type",
  "domain",
  "severity",
  "start_us",
  "end_us",
  "title",
  "description",
  "frame_ids",
] as const;

function fail(code: EvidenceVerificationErrorCode, message: string, path?: string, cause?: unknown): never {
  throw new EvidenceVerificationError(code, message, path, cause === undefined ? undefined : { cause });
}

function ensure(
  condition: unknown,
  code: EvidenceVerificationErrorCode,
  message: string,
  path?: string,
): asserts condition {
  if (!condition) fail(code, message, path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sha256(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

function isDeepStrictEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => isDeepStrictEqual(value, right[index]));
  }
  if (
    left == null
    || right == null
    || typeof left !== "object"
    || typeof right !== "object"
  ) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort(compareText);
  const rightKeys = Object.keys(rightRecord).sort(compareText);
  return isDeepStrictEqual(leftKeys, rightKeys)
    && leftKeys.every((key) => isDeepStrictEqual(leftRecord[key], rightRecord[key]));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown, pretty: boolean): string {
  return `${JSON.stringify(canonicalize(value), null, pretty ? 2 : undefined)}\n`;
}

function decodeText(entries: Map<string, Uint8Array>, path: string, maximumBytes = EVIDENCE_ARCHIVE_LIMITS.textBytes): string {
  const bytes = entries.get(path);
  ensure(bytes, "ARTIFACT_CONTRACT_MISMATCH", `Archive is missing ${path}.`, path);
  ensure(bytes.byteLength <= maximumBytes, "ARCHIVE_LIMIT_EXCEEDED", `${path} exceeds its text budget.`, path);
  try {
    const text = TEXT_DECODER.decode(bytes);
    ensure(!text.startsWith("\uFEFF"), "CONTENT_INVALID", `${path} must not contain a UTF-8 BOM.`, path);
    ensure(!text.includes("\0"), "CONTENT_INVALID", `${path} contains a NUL character.`, path);
    return text;
  } catch (error) {
    if (error instanceof EvidenceVerificationError) throw error;
    fail("CONTENT_INVALID", `${path} is not valid UTF-8.`, path, error);
  }
}

function assertJsonNesting(text: string, path: string): void {
  let depth = 0;
  let maximumDepth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      maximumDepth = Math.max(maximumDepth, depth);
      ensure(maximumDepth <= 128, "ARCHIVE_LIMIT_EXCEEDED", `${path} exceeds the JSON nesting limit.`, path);
    } else if (character === "}" || character === "]") {
      depth -= 1;
      ensure(depth >= 0, "CONTENT_INVALID", `${path} has invalid JSON structure.`, path);
    }
  }
  ensure(!inString && depth === 0, "CONTENT_INVALID", `${path} has invalid JSON structure.`, path);
}

function parseCanonicalJson<T>(entries: Map<string, Uint8Array>, path: string, schema: ZodType<T>): T {
  const text = decodeText(entries, path, EVIDENCE_ARCHIVE_LIMITS.jsonBytes);
  assertJsonNesting(text, path);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail("CONTENT_INVALID", `${path} is not valid JSON.`, path, error);
  }
  ensure(text === canonicalJson(value, true), "CONTENT_INVALID", `${path} is not canonical ReplayCase JSON.`, path);
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const suffix = issue ? ` (${issue.path.join(".") || "root"}: ${issue.message})` : "";
    fail("CONTENT_INVALID", `${path} does not match its evidence schema${suffix}.`, path, result.error);
  }
  return result.data;
}

function parseCompactJsonCell(text: string, path: string, row: number, column: string): unknown {
  ensure(text.length <= EVIDENCE_ARCHIVE_LIMITS.csvCellCharacters, "ARCHIVE_LIMIT_EXCEEDED", `${path} row ${row} ${column} is too large.`, path);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail("CONTENT_INVALID", `${path} row ${row} has invalid ${column} JSON.`, path, error);
  }
  ensure(JSON.stringify(canonicalize(value)) === text, "CONTENT_INVALID", `${path} row ${row} has non-canonical ${column} JSON.`, path);
  return value;
}

function recordCount(manifest: EvidenceBundleManifest, path: EvidenceArtifactPath): number {
  const artifact = manifest.artifacts.find((candidate) => candidate.path === path);
  ensure(artifact, "ARTIFACT_CONTRACT_MISMATCH", `Manifest is missing ${path}.`, path);
  ensure(artifact.recordCount !== undefined, "ARTIFACT_CONTRACT_MISMATCH", `${path} is missing recordCount.`, path);
  return artifact.recordCount;
}

function assertSelectionRange(range: { startUs: number; endUs: number }, manifest: EvidenceBundleManifest, path: string): void {
  ensure(
    range.startUs === manifest.selection.startUs && range.endUs === manifest.selection.endUs,
    "SEMANTIC_MISMATCH",
    `${path} selection range does not match manifest.json.`,
    path,
  );
}

function inSelection(offsetUs: number, manifest: EvidenceBundleManifest): boolean {
  return offsetUs >= manifest.selection.startUs && offsetUs < manifest.selection.endUs;
}

function intersectsSelection(event: TransportEvent, manifest: EvidenceBundleManifest): boolean {
  if (event.scope.kind === "session") return true;
  if (event.scope.kind === "point") return inSelection(event.scope.offsetUs, manifest);
  return event.scope.startUs < manifest.selection.endUs && event.scope.endUs > manifest.selection.startUs;
}

function parseRawRecords(entries: Map<string, Uint8Array>, manifest: EvidenceBundleManifest): SourceRecord[] {
  if (!manifest.inclusions.rawRecords) return [];
  const path = "raw/source-records.ndjson";
  const text = decodeText(entries, path);
  ensure(text === "" || text.endsWith("\n"), "CONTENT_INVALID", `${path} must end with LF when non-empty.`, path);
  let lineCount = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    lineCount += 1;
    ensure(lineCount <= EVIDENCE_ARCHIVE_LIMITS.ndjsonRecords, "ARCHIVE_LIMIT_EXCEEDED", `${path} has too many records.`, path);
  }
  ensure(lineCount === recordCount(manifest, path), "SEMANTIC_MISMATCH", `${path} recordCount does not match its content.`, path);
  const records: SourceRecord[] = [];
  const ids = new Set<string>();
  const indices = new Set<number>();
  let previousOffsetUs = -1;
  let previousIndex = -1;
  let lineStart = 0;
  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const lineEnd = text.indexOf("\n", lineStart);
    const lineNumber = lineIndex + 1;
    const lineCharacterLength = lineEnd - lineStart;
    ensure(lineCharacterLength <= EVIDENCE_ARCHIVE_LIMITS.ndjsonLineBytes, "ARCHIVE_LIMIT_EXCEEDED", `${path} line ${lineNumber} is too large.`, path);
    const line = text.slice(lineStart, lineEnd);
    ensure(line.length > 0, "CONTENT_INVALID", `${path} contains a blank line at ${lineNumber}.`, path);
    ensure(TEXT_ENCODER.encode(line).byteLength <= EVIDENCE_ARCHIVE_LIMITS.ndjsonLineBytes, "ARCHIVE_LIMIT_EXCEEDED", `${path} line ${lineNumber} is too large.`, path);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      fail("CONTENT_INVALID", `${path} line ${lineNumber} is not JSON.`, path, error);
    }
    ensure(JSON.stringify(canonicalize(value)) === line, "CONTENT_INVALID", `${path} line ${lineNumber} is not canonical JSON.`, path);
    const parsed = (manifest.session.formatVersion === 1 ? sourceRecordV1Schema : sourceRecordSchema).safeParse(value);
    if (!parsed.success) fail("CONTENT_INVALID", `${path} line ${lineNumber} is not a valid source record.`, path, parsed.error);
    const record = parsed.data;
    ensure(
      Number.isSafeInteger(record.index)
        && Number.isSafeInteger(record.captureBytes)
        && Number.isSafeInteger(record.wireBytes)
        && (record.transport.kernelDropCounter == null || Number.isSafeInteger(record.transport.kernelDropCounter)),
      "CONTENT_INVALID",
      `${path} line ${lineNumber} contains an unsafe integer.`,
      path,
    );
    ensure(!ids.has(record.id), "SEMANTIC_MISMATCH", `${path} contains duplicate record id ${record.id}.`, path);
    ensure(!indices.has(record.index), "SEMANTIC_MISMATCH", `${path} contains duplicate record index ${record.index}.`, path);
    ensure(record.offsetUs > previousOffsetUs || (record.offsetUs === previousOffsetUs && record.index > previousIndex), "SEMANTIC_MISMATCH", `${path} records are not ordered by offset and index.`, path);
    ensure(inSelection(record.offsetUs, manifest), "SEMANTIC_MISMATCH", `${path} record ${record.id} lies outside the selected range.`, path);
    ensure(record.sourceId === manifest.session.sourceId, "SEMANTIC_MISMATCH", `${path} record ${record.id} has the wrong sourceId.`, path);
    ensure(record.transport.kind === manifest.provenance.transport, "SEMANTIC_MISMATCH", `${path} record ${record.id} has the wrong transport kind.`, path);
    ensure(record.dataHex.length / 2 === record.captureBytes, "SEMANTIC_MISMATCH", `${path} record ${record.id} byte count does not match dataHex.`, path);
    ensure(record.wireBytes >= record.captureBytes, "SEMANTIC_MISMATCH", `${path} record ${record.id} declares fewer wire bytes than captured bytes.`, path);
    ids.add(record.id);
    indices.add(record.index);
    previousOffsetUs = record.offsetUs;
    previousIndex = record.index;
    records.push(record);
    lineStart = lineEnd + 1;
  }
  return records;
}

function parseCsv(text: string, path: string, maximumColumns: number): string[][] {
  ensure(text.endsWith("\n"), "CONTENT_INVALID", `${path} must end with LF.`, path);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    ensure(character !== "\r", "CONTENT_INVALID", `${path} must use LF line endings.`, path);
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          ensure(cell.length <= EVIDENCE_ARCHIVE_LIMITS.csvCellCharacters, "ARCHIVE_LIMIT_EXCEEDED", `${path} contains an oversized quoted cell.`, path);
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        cell += character;
        ensure(cell.length <= EVIDENCE_ARCHIVE_LIMITS.csvCellCharacters, "ARCHIVE_LIMIT_EXCEEDED", `${path} contains an oversized quoted cell.`, path);
      }
      continue;
    }
    if (afterQuote) {
      ensure(character === "," || character === "\n", "CONTENT_INVALID", `${path} has characters after a closing quote.`, path);
      afterQuote = false;
    } else if (character === '"') {
      ensure(cell === "", "CONTENT_INVALID", `${path} has an unexpected quote.`, path);
      quoted = true;
      continue;
    }
    if (character === ",") {
      ensure(row.length < maximumColumns - 1, "ARCHIVE_LIMIT_EXCEEDED", `${path} contains too many columns.`, path);
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      ensure(row.length < maximumColumns, "ARCHIVE_LIMIT_EXCEEDED", `${path} contains too many columns.`, path);
      row.push(cell);
      rows.push(row);
      ensure(rows.length <= EVIDENCE_ARCHIVE_LIMITS.csvRecords + 1, "ARCHIVE_LIMIT_EXCEEDED", `${path} has too many rows.`, path);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
    ensure(cell.length <= EVIDENCE_ARCHIVE_LIMITS.csvCellCharacters, "ARCHIVE_LIMIT_EXCEEDED", `${path} contains an oversized cell.`, path);
  }
  ensure(!quoted && !afterQuote && row.length === 0 && cell === "", "CONTENT_INVALID", `${path} ends in an incomplete CSV row.`, path);
  ensure(rows.length >= 1, "CONTENT_INVALID", `${path} is missing its header.`, path);
  ensure(rows.length - 1 <= EVIDENCE_ARCHIVE_LIMITS.csvRecords, "ARCHIVE_LIMIT_EXCEEDED", `${path} has too many rows.`, path);
  for (const [rowIndex, values] of rows.entries()) {
    if (rowIndex === 0) continue;
    for (const value of values) {
      ensure(!FORMULA_PATTERN.test(value), "CONTENT_INVALID", `${path} row ${rowIndex + 1} contains an unneutralized spreadsheet formula.`, path);
    }
  }
  return rows;
}

function parseIntegerCell(value: string, path: string, row: number, column: string, optional = false): number | null {
  if (optional && value === "") return null;
  ensure(/^(?:0|[1-9][0-9]*)$/.test(value), "CONTENT_INVALID", `${path} row ${row} has invalid ${column}.`, path);
  const parsed = Number(value);
  ensure(Number.isSafeInteger(parsed), "CONTENT_INVALID", `${path} row ${row} has unsafe ${column}.`, path);
  return parsed;
}

function verifyDecodedCsv(
  entries: Map<string, Uint8Array>,
  manifest: EvidenceBundleManifest,
  rawRecords: readonly SourceRecord[],
  decoderPack: DecoderPackDocument | null,
  warnings: string[],
): { recordCount: number; frameIds: Set<string>; packets: VerifiedDecodedPacket[] } {
  if (!manifest.inclusions.decodedPackets) {
    return { recordCount: 0, frameIds: new Set(), packets: [] };
  }
  const path = "decoded/packets.csv";
  const rows = parseCsv(decodeText(entries, path), path, DECODED_HEADER.length);
  ensure(isDeepStrictEqual(rows[0], [...DECODED_HEADER]), "CONTENT_INVALID", `${path} header is not the v3 decoded packet schema.`, path);
  ensure(rows.length - 1 === recordCount(manifest, path), "SEMANTIC_MISMATCH", `${path} recordCount does not match its rows.`, path);
  const rawByCsvId = new Map<string, SourceRecord | null>();
  for (const record of rawRecords) {
    for (const representation of spreadsheetTextRepresentations(record.id)) {
      const existing = rawByCsvId.get(representation);
      rawByCsvId.set(representation, existing === null || (existing !== undefined && existing.id !== record.id) ? null : record);
    }
  }
  const referencedRecordIds = new Set<string>();
  const sourceRecordIds = new Set<string>();
  const frameIds = new Set<string>();
  const packets: VerifiedDecodedPacket[] = [];
  let previousOrdinal = -1;
  let previousOffsetUs = -1;
  for (let index = 1; index < rows.length; index += 1) {
    const values = rows[index];
    const row = index + 1;
    ensure(values?.length === DECODED_HEADER.length, "CONTENT_INVALID", `${path} row ${row} has the wrong column count.`, path);
    const frameId = values[0] ?? "";
    const ordinal = parseIntegerCell(values[1] ?? "", path, row, "ordinal");
    const offsetUs = parseIntegerCell(values[2] ?? "", path, row, "offset_us");
    const sourceRecordId = values[3] ?? "";
    ensure(typeof ordinal === "number" && typeof offsetUs === "number", "CONTENT_INVALID", `${path} row ${row} has invalid offsets.`, path);
    const expandedSourceRecordId = sourceRecordId.length === EVIDENCE_ENCODED_SOURCE_RECORD_ID_CHARACTERS
      && sourceRecordId.startsWith("'")
      && (sourceRecordId.slice(1).startsWith("'") || FORMULA_PATTERN.test(sourceRecordId.slice(1)));
    ensure(frameId.length > 0 && frameId.length <= EVIDENCE_FRAME_ID_CHARACTERS && !frameIds.has(frameId), "SEMANTIC_MISMATCH", `${path} row ${row} has a duplicate or invalid frame id.`, path);
    ensure(
      sourceRecordId.length > 0
        && (sourceRecordId.length <= EVIDENCE_SOURCE_RECORD_ID_CHARACTERS || expandedSourceRecordId)
        && !sourceRecordIds.has(sourceRecordId),
      "SEMANTIC_MISMATCH",
      `${path} row ${row} has a duplicate or invalid source record id.`,
      path,
    );
    ensure(ordinal > previousOrdinal, "SEMANTIC_MISMATCH", `${path} frame ordinals must increase.`, path);
    ensure(offsetUs >= previousOffsetUs && inSelection(offsetUs, manifest), "SEMANTIC_MISMATCH", `${path} row ${row} lies outside or reorders the selected range.`, path);
    if (manifest.inclusions.rawRecords) {
      const referencedRecord = rawByCsvId.get(sourceRecordId);
      ensure(referencedRecord && !referencedRecordIds.has(referencedRecord.id), "SEMANTIC_MISMATCH", `${path} row ${row} references an absent, ambiguous, or repeated raw record.`, path);
      referencedRecordIds.add(referencedRecord.id);
    }
    sourceRecordIds.add(sourceRecordId);
    ensure(["complete", "partial", "invalid"].includes(values[4] ?? ""), "CONTENT_INVALID", `${path} row ${row} has invalid status.`, path);
    ensure(["valid", "crc-failed", "checksum-failed", "truncated", "invalid-length", "unknown-family", "unsupported-version"].includes(values[5] ?? ""), "CONTENT_INVALID", `${path} row ${row} has invalid integrity.`, path);
    for (const column of [6, 7, 9, 10, 11]) parseIntegerCell(values[column] ?? "", path, row, DECODED_HEADER[column] ?? "numeric field", true);
    const integrity = parseCompactJsonCell(values[12] ?? "", path, row, "integrity_json");
    const parsedIntegrity = decodedIntegritySchema.safeParse(integrity);
    ensure(parsedIntegrity.success, "CONTENT_INVALID", `${path} row ${row} integrity_json is invalid.`, path);
    const expectedStatus = parsedIntegrity.data.status === "valid"
      ? "complete"
      : parsedIntegrity.data.status === "truncated"
        ? "partial"
        : "invalid";
    ensure(
      values[5] === parsedIntegrity.data.status && values[4] === expectedStatus,
      "SEMANTIC_MISMATCH",
      `${path} row ${row} status columns contradict integrity_json.`,
      path,
    );
    const fields = parseCompactJsonCell(values[13] ?? "", path, row, "fields_json");
    const parsedFields = z.array(decodedFieldSchema).max(100).safeParse(fields);
    ensure(parsedFields.success, "CONTENT_INVALID", `${path} row ${row} fields_json is invalid.`, path);
    const sourceRecord = rawByCsvId.get(sourceRecordId);
    let reproducedFamilyName: string | null = null;
    let reproducedSourceRecordId: string | null = null;
    if (sourceRecord && decoderPack != null) {
      const decoded = decodeRecord(sourceRecord, ordinal, decoderPack);
      reproducedFamilyName = decoded.familyName;
      reproducedSourceRecordId = decoded.sourceRecord.id;
      const expected = [
        decoded.id,
        String(decoded.ordinal),
        String(decoded.offsetUs),
        spreadsheetSafeText(decoded.sourceRecord.id),
        decoded.status,
        decoded.integrity.status,
        decoded.protocolVersion == null ? "" : String(decoded.protocolVersion),
        decoded.familyId == null ? "" : String(decoded.familyId),
        spreadsheetSafeText(decoded.familyName),
        decoded.sequence == null ? "" : String(decoded.sequence),
        decoded.deviceTimeMs == null ? "" : String(decoded.deviceTimeMs),
        decoded.payloadLength == null ? "" : String(decoded.payloadLength),
        JSON.stringify(canonicalize(decoded.integrity)),
        JSON.stringify(canonicalize(decoded.fields)),
      ];
      const legacyExpected = [...expected];
      legacyExpected[3] = FORMULA_PATTERN.test(decoded.sourceRecord.id) ? `'${decoded.sourceRecord.id}` : decoded.sourceRecord.id;
      legacyExpected[8] = FORMULA_PATTERN.test(decoded.familyName) ? `'${decoded.familyName}` : decoded.familyName;
      ensure(
        isDeepStrictEqual(values, expected) || isDeepStrictEqual(values, legacyExpected),
        "SEMANTIC_MISMATCH",
        `${path} row ${row} does not reproduce through the declared local decoder.`,
        path,
      );
    }
    packets.push({
      id: frameId,
      ordinal,
      offsetUs,
      sourceRecordId: reproducedSourceRecordId ?? originalSpreadsheetText(sourceRecordId),
      status: values[4] as VerifiedDecodedPacket["status"],
      integrityStatus: parsedIntegrity.data.status,
      protocolVersion: parseIntegerCell(values[6] ?? "", path, row, "protocol_version", true),
      familyId: parseIntegerCell(values[7] ?? "", path, row, "family_id", true),
      familyName: reproducedFamilyName ?? originalSpreadsheetText(values[8] ?? ""),
      sequence: parseIntegerCell(values[9] ?? "", path, row, "sequence", true),
      deviceTimeMs: parseIntegerCell(values[10] ?? "", path, row, "device_time_ms", true),
      payloadLength: parseIntegerCell(values[11] ?? "", path, row, "payload_length", true),
      integrity: parsedIntegrity.data,
      fields: parsedFields.data,
    });
    frameIds.add(frameId);
    previousOrdinal = ordinal;
    previousOffsetUs = offsetUs;
  }
  if (manifest.inclusions.rawRecords) {
    ensure(referencedRecordIds.size === rawRecords.length, "SEMANTIC_MISMATCH", `${path} does not contain exactly one decoded row for every selected raw record.`, path);
  }
  if (manifest.inclusions.rawRecords && decoderPack == null) {
    warnings.push("Decoded packet rows could not be replay-checked because this receiver does not implement the declared decoder.");
  }
  return { recordCount: rows.length - 1, frameIds, packets };
}

function verifyDiagnostics(
  entries: Map<string, Uint8Array>,
  manifest: EvidenceBundleManifest,
  decodedFrameIds: ReadonlySet<string>,
): EvidenceDiagnostic[] {
  if (!manifest.inclusions.diagnostics) return [];
  const jsonPath = "diagnostics/diagnostics.json";
  const csvPath = "diagnostics/diagnostics.csv";
  const document = parseCanonicalJson(entries, jsonPath, evidenceDiagnosticsDocumentSchema);
  assertSelectionRange(document.range, manifest, jsonPath);
  ensure(document.diagnostics.length === recordCount(manifest, jsonPath), "SEMANTIC_MISMATCH", `${jsonPath} recordCount does not match its content.`, jsonPath);
  const ids = new Set<string>();
  for (const diagnostic of document.diagnostics) {
    ensure(!ids.has(diagnostic.id), "SEMANTIC_MISMATCH", `${jsonPath} contains duplicate diagnostic ${diagnostic.id}.`, jsonPath);
    ensure(
      diagnostic.startUs < manifest.session.durationUs
        && (diagnostic.endUs === undefined || diagnostic.endUs <= manifest.session.durationUs),
      "SEMANTIC_MISMATCH",
      `${jsonPath} diagnostic ${diagnostic.id} exceeds the declared session duration.`,
      jsonPath,
    );
    ensure(diagnostic.endUs === undefined ? inSelection(diagnostic.startUs, manifest) : diagnostic.startUs < manifest.selection.endUs && diagnostic.endUs > manifest.selection.startUs, "SEMANTIC_MISMATCH", `${jsonPath} diagnostic ${diagnostic.id} does not overlap the selection.`, jsonPath);
    if (diagnostic.endUs !== undefined) ensure(diagnostic.endUs > diagnostic.startUs, "SEMANTIC_MISMATCH", `${jsonPath} diagnostic ${diagnostic.id} has an empty range.`, jsonPath);
    if (manifest.inclusions.decodedPackets) {
      ensure(diagnostic.frameIds.every((frameId) => decodedFrameIds.has(frameId)), "SEMANTIC_MISMATCH", `${jsonPath} diagnostic ${diagnostic.id} references a frame outside decoded/packets.csv.`, jsonPath);
    }
    ids.add(diagnostic.id);
  }
  const rows = parseCsv(decodeText(entries, csvPath), csvPath, DIAGNOSTICS_HEADER.length);
  ensure(isDeepStrictEqual(rows[0], [...DIAGNOSTICS_HEADER]), "CONTENT_INVALID", `${csvPath} header is not the v3 diagnostics schema.`, csvPath);
  ensure(rows.length - 1 === document.diagnostics.length && rows.length - 1 === recordCount(manifest, csvPath), "SEMANTIC_MISMATCH", `${csvPath} count does not match diagnostics JSON.`, csvPath);
  for (let index = 1; index < rows.length; index += 1) {
    const values = rows[index];
    const diagnostic = document.diagnostics[index - 1];
    ensure(values?.length === DIAGNOSTICS_HEADER.length && diagnostic, "CONTENT_INVALID", `${csvPath} row ${index + 1} has the wrong column count.`, csvPath);
    ensure(values[0] === diagnostic.id && values[1] === diagnostic.type && values[2] === diagnostic.domain && values[3] === diagnostic.severity, "SEMANTIC_MISMATCH", `${csvPath} row ${index + 1} disagrees with diagnostics JSON.`, csvPath);
    const startUs = parseIntegerCell(values[4] ?? "", csvPath, index + 1, "start_us");
    const endUs = parseIntegerCell(values[5] ?? "", csvPath, index + 1, "end_us", true);
    ensure(startUs === diagnostic.startUs && (endUs ?? undefined) === diagnostic.endUs, "SEMANTIC_MISMATCH", `${csvPath} row ${index + 1} has mismatched offsets.`, csvPath);
    ensure(
      spreadsheetTextRepresentations(diagnostic.title).includes(values[6] ?? "")
      && spreadsheetTextRepresentations(diagnostic.description).includes(values[7] ?? "")
      && spreadsheetTextRepresentations(diagnostic.frameIds.join("|")).includes(values[8] ?? ""),
      "SEMANTIC_MISMATCH",
      `${csvPath} row ${index + 1} disagrees with diagnostics JSON.`,
      csvPath,
    );
  }
  return document.diagnostics;
}

function verifyMarkers(entries: Map<string, Uint8Array>, manifest: EvidenceBundleManifest): EvidenceMarker[] {
  if (!manifest.inclusions.markers) return [];
  const path = "markers/markers.json";
  const document = parseCanonicalJson(entries, path, evidenceMarkersDocumentSchema);
  assertSelectionRange(document.range, manifest, path);
  ensure(document.markers.length === recordCount(manifest, path), "SEMANTIC_MISMATCH", `${path} recordCount does not match its content.`, path);
  const ids = new Set<string>();
  let previousOffsetUs = -1;
  for (const marker of document.markers) {
    ensure(!ids.has(marker.id) && marker.offsetUs >= previousOffsetUs && inSelection(marker.offsetUs, manifest), "SEMANTIC_MISMATCH", `${path} marker ordering or range is invalid.`, path);
    ids.add(marker.id);
    previousOffsetUs = marker.offsetUs;
  }
  return document.markers;
}

function verifyNotes(entries: Map<string, Uint8Array>, manifest: EvidenceBundleManifest): EvidenceNote[] {
  if (!manifest.inclusions.notes) return [];
  const path = "notes/notes.json";
  const document = parseCanonicalJson(entries, path, evidenceNotesDocumentSchema);
  assertSelectionRange(document.range, manifest, path);
  ensure(document.notes.length === recordCount(manifest, path), "SEMANTIC_MISMATCH", `${path} recordCount does not match its content.`, path);
  const ids = new Set<string>();
  let previousOffsetUs = Number.NEGATIVE_INFINITY;
  for (const note of document.notes) {
    const offsetUs = note.offsetUs ?? Number.NEGATIVE_INFINITY;
    ensure(!ids.has(note.id) && offsetUs >= previousOffsetUs, "SEMANTIC_MISMATCH", `${path} note ordering is invalid.`, path);
    if (note.offsetUs !== undefined) ensure(inSelection(note.offsetUs, manifest), "SEMANTIC_MISMATCH", `${path} note ${note.id} lies outside the selection.`, path);
    ids.add(note.id);
    previousOffsetUs = offsetUs;
  }
  return document.notes;
}

function udpEndpointKey(endpoint: UdpRemoteEndpoint): string {
  return `${endpoint.family}\0${endpoint.address}\0${endpoint.port}`;
}

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === new Set(actual).size && isDeepStrictEqual([...actual].sort(compareText), [...expected].sort(compareText));
}

function verifyCaptureReceipt(
  manifest: EvidenceBundleManifest,
  receipt: CaptureIntegrityReceipt,
  events: readonly TransportEvent[],
  rawRecords: readonly SourceRecord[],
): void {
  const path = "transport/integrity-receipt.json";
  ensure(new Set(receipt.issueCodes).size === receipt.issueCodes.length, "SEMANTIC_MISMATCH", "Capture-integrity issue codes must be unique.", path);
  if (
    manifest.session.formatVersion === 2
    && receipt.assessmentBasis !== "file-source-unassessed"
  ) {
    ensure(receipt.eventLogComplete !== receipt.issueCodes.includes("event-log-incomplete"), "SEMANTIC_MISMATCH", "Capture-integrity event-log completeness conflicts with its issue codes.", path);
  }
  ensure((receipt.stopDisposition === "unconfirmed") === receipt.issueCodes.includes("shutdown-unconfirmed"), "SEMANTIC_MISMATCH", "Capture-integrity shutdown disposition conflicts with its issue codes.", path);
  ensure(
    (receipt.stopDisposition === "not-observed") === (receipt.stopOffsetUs === null),
    "SEMANTIC_MISMATCH",
    "Capture-integrity stop disposition conflicts with its stop offset.",
    path,
  );
  ensure(receipt.stopOffsetUs === null || receipt.stopOffsetUs <= manifest.session.durationUs, "SEMANTIC_MISMATCH", "Capture-integrity stop offset exceeds the declared session duration.", path);
  ensure(rawRecords.length <= receipt.retained.records, "SEMANTIC_MISMATCH", "Selected raw records exceed the whole-session receipt total.", path);
  const selectedBytes = rawRecords.reduce((total, record) => total + record.captureBytes, 0);
  ensure(selectedBytes <= receipt.retained.bytes, "SEMANTIC_MISMATCH", "Selected raw bytes exceed the whole-session receipt total.", path);
  if (manifest.inclusions.rawRecords && rawRecords.length === receipt.retained.records) {
    ensure(selectedBytes === receipt.retained.bytes, "SEMANTIC_MISMATCH", "Full-session raw bytes do not match the integrity receipt.", path);
  }

  if (receipt.status === "verified") {
    ensure(receipt.stopDisposition === "confirmed" && receipt.eventLogComplete && receipt.issueCodes.length === 0 && events.length === 0, "SEMANTIC_MISMATCH", "Verified capture integrity contains unresolved issues or events.", path);
  } else if (receipt.status === "incomplete") {
    ensure(receipt.issueCodes.length > 0 || events.length > 0 || !receipt.eventLogComplete || receipt.stopDisposition !== "confirmed", "SEMANTIC_MISMATCH", "Incomplete capture integrity does not disclose an unresolved condition.", path);
  } else {
    ensure(manifest.session.formatVersion === 1 || receipt.assessmentBasis === "file-source-unassessed", "SEMANTIC_MISMATCH", "Unknown capture integrity is only valid for legacy or unassessed file evidence.", path);
  }

  if (manifest.session.formatVersion === 1) {
    ensure(
      receipt.assessmentBasis === "legacy-v1"
        && receipt.status === "unknown"
        && receipt.stopDisposition === "not-observed"
        && !receipt.eventLogComplete
        && receipt.input.unit === "unknown"
        && receipt.input.observedUnits === null
        && receipt.input.observedBytes === null
        && receipt.input.transportReportedUnits === null
        && receipt.input.transportReportedBytes === null
        && isDeepStrictEqual(receipt.issueCodes, ["legacy-session-unassessed"]),
      "SEMANTIC_MISMATCH",
      "Legacy v1 evidence must retain its unassessed capture boundary.",
      path,
    );
  } else if (manifest.provenance.transport === "udp") {
    ensure(receipt.issueCodes.every((code) => UDP_CAPTURE_ISSUE_CODES.has(code)), "SEMANTIC_MISMATCH", "UDP capture integrity contains an issue code for another transport.", path);
    ensure(receipt.input.unit === "datagram", "SEMANTIC_MISMATCH", "UDP evidence requires datagram receipt counters.", path);
    const mismatchEvents = events.filter((event) => event.type === "udp-counter-mismatch");
    if (receipt.assessmentBasis === "udp-bridge-reconciled") {
      ensure(
        receipt.input.observedUnits !== null
          && receipt.input.observedBytes !== null
          && receipt.input.transportReportedUnits !== null
          && receipt.input.transportReportedBytes !== null,
        "SEMANTIC_MISMATCH",
        "Bridge-reconciled UDP evidence requires browser and bridge counters.",
        path,
      );
      const countersReconcile = receipt.input.observedUnits === receipt.input.transportReportedUnits
        && receipt.input.observedBytes === receipt.input.transportReportedBytes
        && receipt.retained.records === receipt.input.observedUnits
        && receipt.retained.bytes === receipt.input.observedBytes;
      ensure(
        receipt.issueCodes.includes("udp-counter-mismatch") === !countersReconcile
          && (countersReconcile
            ? mismatchEvents.length === 0
            : mismatchEvents.length <= 1 && (!receipt.eventLogComplete || mismatchEvents.length === 1)),
        "SEMANTIC_MISMATCH",
        "UDP bridge/browser counter reconciliation conflicts with receipt issues or events.",
        path,
      );
    } else if (receipt.assessmentBasis === "udp-browser-observed") {
      ensure(
        receipt.status === "incomplete"
          && receipt.stopDisposition === "unconfirmed"
          && receipt.input.observedUnits !== null
          && receipt.input.observedBytes !== null
          && receipt.input.transportReportedUnits === null
          && receipt.input.transportReportedBytes === null
          && !receipt.issueCodes.includes("udp-counter-mismatch")
          && mismatchEvents.length === 0,
        "SEMANTIC_MISMATCH",
        "Browser-observed UDP evidence must disclose unavailable terminal bridge counters.",
        path,
      );
    } else {
      ensure(
        receipt.assessmentBasis === "recorder-only"
          && receipt.status === "incomplete"
          && receipt.stopDisposition === "unconfirmed"
          && !receipt.eventLogComplete
          && receipt.input.observedUnits === null
          && receipt.input.observedBytes === null
          && receipt.input.transportReportedUnits === null
          && receipt.input.transportReportedBytes === null
          && !receipt.issueCodes.includes("udp-counter-mismatch")
          && mismatchEvents.length === 0,
        "SEMANTIC_MISMATCH",
        "Recorder-only UDP evidence must not claim adapter observations.",
        path,
      );
    }
  } else if (manifest.provenance.transport === "serial") {
    ensure(receipt.issueCodes.every((code) => SERIAL_CAPTURE_ISSUE_CODES.has(code)), "SEMANTIC_MISMATCH", "Serial capture integrity contains an issue code for another transport.", path);
    ensure(receipt.input.unit === "serial-read", "SEMANTIC_MISMATCH", "Serial evidence requires serial-read receipt counters.", path);
    const mismatchEvents = events.filter((event) => event.type === "serial-counter-mismatch");
    if (receipt.assessmentBasis === "web-serial-observed") {
      ensure(
        receipt.input.observedUnits !== null
          && receipt.input.observedBytes !== null
          && receipt.input.transportReportedUnits === null
          && receipt.input.transportReportedBytes === null,
        "SEMANTIC_MISMATCH",
        "Web Serial evidence contains invalid observation counters.",
        path,
      );
      const bytesReconcile = receipt.retained.bytes === receipt.input.observedBytes;
      ensure(
        receipt.issueCodes.includes("serial-counter-mismatch") === !bytesReconcile
          && (bytesReconcile
            ? mismatchEvents.length === 0
            : mismatchEvents.length <= 1 && (!receipt.eventLogComplete || mismatchEvents.length === 1)),
        "SEMANTIC_MISMATCH",
        "Serial byte reconciliation conflicts with receipt issues or events.",
        path,
      );
    } else {
      ensure(
        receipt.assessmentBasis === "recorder-only"
          && receipt.status === "incomplete"
          && receipt.stopDisposition === "unconfirmed"
          && !receipt.eventLogComplete
          && receipt.input.observedUnits === null
          && receipt.input.observedBytes === null
          && receipt.input.transportReportedUnits === null
          && receipt.input.transportReportedBytes === null
          && !receipt.issueCodes.includes("serial-counter-mismatch")
          && mismatchEvents.length === 0,
        "SEMANTIC_MISMATCH",
        "Recorder-only serial evidence must not claim adapter observations.",
        path,
      );
    }
  } else {
    ensure(
      receipt.assessmentBasis === "file-source-unassessed"
        && receipt.status === "unknown"
        && receipt.stopDisposition === "not-observed"
        && !receipt.eventLogComplete
        && receipt.input.unit === "unknown"
        && receipt.input.observedUnits === null
        && receipt.input.observedBytes === null
        && receipt.input.transportReportedUnits === null
        && receipt.input.transportReportedBytes === null
        && isDeepStrictEqual(receipt.issueCodes, ["file-source-unassessed"]),
      "SEMANTIC_MISMATCH",
      "File-source evidence must remain explicitly unassessed.",
      path,
    );
  }

  const issueCodes = new Set<string>(receipt.issueCodes);
  const shutdownEvents = events.filter((event) => event.type === "shutdown-unconfirmed");
  ensure(
    shutdownEvents.length <= 1
      && (receipt.stopDisposition === "unconfirmed" || shutdownEvents.length === 0)
      && (!receipt.eventLogComplete || receipt.stopDisposition !== "unconfirmed" || shutdownEvents.length === 1),
    "SEMANTIC_MISMATCH",
    "Capture-integrity shutdown status is not represented by one terminal transport event.",
    "transport/events.json",
  );
  const durationLimitEvents = events.filter((event) => event.type === "capture-limit" && event.limit === "duration");
  ensure(
    durationLimitEvents.length <= 1
      && (durationLimitEvents.length === 0 || issueCodes.has("duration-capped")),
    "SEMANTIC_MISMATCH",
    "Duration-capped receipt evidence conflicts with its included capture-limit event.",
    "transport/events.json",
  );
  for (const event of events) {
    ensure(issueCodes.has(event.type), "SEMANTIC_MISMATCH", `Transport event ${event.id} is absent from the whole-session receipt issue codes.`, "transport/events.json");
    if (manifest.provenance.transport !== "file") {
      ensure(event.transport === manifest.provenance.transport, "SEMANTIC_MISMATCH", `Transport event ${event.id} belongs to another transport.`, "transport/events.json");
    }
    if (event.type === "udp-counter-mismatch") {
      ensure(
        event.bridgeDatagrams === receipt.input.transportReportedUnits
        && event.bridgeBytes === receipt.input.transportReportedBytes
        && event.browserDatagrams === receipt.input.observedUnits
        && event.browserBytes === receipt.input.observedBytes
        && event.retainedRecords === receipt.retained.records
        && event.retainedBytes === receipt.retained.bytes,
        "SEMANTIC_MISMATCH",
        `UDP counter event ${event.id} conflicts with the receipt.`,
        "transport/events.json",
      );
    }
    if (event.type === "serial-counter-mismatch") {
      ensure(
        event.observedReads === receipt.input.observedUnits
        && event.observedBytes === receipt.input.observedBytes
        && event.retainedRecords === receipt.retained.records
        && event.retainedBytes === receipt.retained.bytes,
        "SEMANTIC_MISMATCH",
        `Serial counter event ${event.id} conflicts with the receipt.`,
        "transport/events.json",
      );
    }
  }

  if (receipt.eventLogComplete) {
    for (const type of ["udp-counter-mismatch", "udp-kernel-drops-observed", "serial-counter-mismatch"] as const) {
      if (!issueCodes.has(type)) continue;
      ensure(events.filter((event) => event.type === type).length === 1, "SEMANTIC_MISMATCH", `Complete event evidence requires one ${type} event.`, "transport/events.json");
    }
  }
}

function verifyUdpJournal(journal: UdpBridgeJournal, receipt: CaptureIntegrityReceipt, sessionStartedAt: string, durationUs: number): void {
  ensure(journal.startedAt === sessionStartedAt, "SEMANTIC_MISMATCH", "Journal start does not match the session start.", "transport/journal.json");
  ensure(
    (journal.kernelDroppedDatagramsSource === "linux-proc-net-udp-socket")
      === (journal.kernelDroppedDatagrams !== null),
    "SEMANTIC_MISMATCH",
    "Journal kernel-drop availability conflicts with its counter.",
    "transport/journal.json",
  );
  ensure(journal.entriesComplete === (journal.omittedEntries === 0), "SEMANTIC_MISMATCH", "Journal completeness conflicts with omitted entries.", "transport/journal.json");
  ensure(!(journal.state === "active" && journal.endedAt !== null), "SEMANTIC_MISMATCH", "An active journal cannot declare an end timestamp.", "transport/journal.json");
  ensure(!(journal.state === "clean" && (journal.endedAt === null || !journal.entriesComplete)), "SEMANTIC_MISMATCH", "A clean journal requires a complete terminal lifecycle.", "transport/journal.json");
  let previousSequence = -1;
  let previousOffsetUs = -1;
  let previousDatagrams = -1;
  let previousBytes = -1;
  for (const [index, entry] of journal.entries.entries()) {
    ensure(entry.sequence > previousSequence, "SEMANTIC_MISMATCH", "Journal sequences must increase.", "transport/journal.json");
    if (journal.entriesComplete) ensure(entry.sequence === index, "SEMANTIC_MISMATCH", "A complete journal must have contiguous sequences.", "transport/journal.json");
    ensure(entry.offsetUs >= previousOffsetUs && entry.offsetUs <= durationUs && entry.datagrams >= previousDatagrams && entry.bytes >= previousBytes, "SEMANTIC_MISMATCH", "Journal offsets and counters must be monotonic and remain within the declared session duration.", "transport/journal.json");
    ensure(entry.datagrams <= journal.datagrams && entry.bytes <= journal.bytes, "SEMANTIC_MISMATCH", "Journal entry counters exceed terminal counters.", "transport/journal.json");
    const errorEntry = entry.type === "bridge-error" || entry.type === "subscriber-backpressure";
    ensure(!errorEntry || (entry.code !== undefined && entry.message !== undefined && entry.fatal !== undefined), "SEMANTIC_MISMATCH", "Journal error entries require code, message, and fatal evidence.", "transport/journal.json");
    ensure(!errorEntry || journal.state === "incomplete", "SEMANTIC_MISMATCH", "Journal error entries require incomplete state.", "transport/journal.json");
    previousSequence = entry.sequence;
    previousOffsetUs = entry.offsetUs;
    previousDatagrams = entry.datagrams;
    previousBytes = entry.bytes;
  }
  const first = journal.entries[0];
  ensure(
    first?.type === "capture-started"
      && first.sequence === 0
      && first.at === journal.startedAt
      && first.offsetUs === 0
      && first.datagrams === 0
      && first.bytes === 0,
    "SEMANTIC_MISMATCH",
    "Journal must begin with an exact capture-started entry.",
    "transport/journal.json",
  );
  const last = journal.entries.at(-1);
  if (journal.endedAt !== null) {
    ensure(
      last?.type === "capture-stopped"
        && last.at === journal.endedAt
        && last.datagrams === journal.datagrams
        && last.bytes === journal.bytes
        && (receipt.stopOffsetUs === null || last.offsetUs <= receipt.stopOffsetUs),
      "SEMANTIC_MISMATCH",
      "Terminal journal evidence does not match its summary or capture stop.",
      "transport/journal.json",
    );
  }
}

function verifyTransportEvidence(
  manifest: EvidenceBundleManifest,
  provenanceDocument: EvidenceTransportProvenanceDocument,
  journalDocument: EvidenceTransportJournalDocument,
  receipt: CaptureIntegrityReceipt,
  events: readonly TransportEvent[],
  rawRecords: readonly SourceRecord[],
  warnings: string[],
): void {
  ensure(isDeepStrictEqual(receipt, manifest.session.captureIntegrity), "SEMANTIC_MISMATCH", "Integrity receipt artifact does not match manifest.json.", "transport/integrity-receipt.json");
  ensure(provenanceDocument.sessionFormatVersion === manifest.session.formatVersion && journalDocument.sessionFormatVersion === manifest.session.formatVersion, "SEMANTIC_MISMATCH", "Transport document session versions do not match manifest.json.");
  ensure(provenanceDocument.sourceId === manifest.session.sourceId && journalDocument.sourceId === manifest.session.sourceId, "SEMANTIC_MISMATCH", "Transport document source IDs do not match manifest.json.");
  ensure(provenanceDocument.transport === manifest.provenance.transport && journalDocument.transport === manifest.provenance.transport, "SEMANTIC_MISMATCH", "Transport document kinds do not match manifest.json.");

  if (provenanceDocument.availability === "unavailable") {
    const expectedReason = manifest.session.formatVersion === 1 ? "legacy-v1" : "pre-provenance-v2";
    ensure(provenanceDocument.reason === expectedReason && journalDocument.availability === "unavailable" && journalDocument.reason === expectedReason, "SEMANTIC_MISMATCH", "Unavailable provenance does not disclose the expected compatibility boundary.");
    ensure(isDeepStrictEqual(manifest.provenance, {
      availability: "unavailable",
      status: "unknown",
      sourceId: manifest.session.sourceId,
      transport: provenanceDocument.transport,
      issueCodes: [],
      captureId: null,
      endpointAttribution: null,
      journal: { availability: "unavailable", reason: expectedReason, state: null, entriesComplete: null, entryCount: 0, omittedEntries: 0 },
    }), "SEMANTIC_MISMATCH", "Manifest provenance summary does not match unavailable transport evidence.");
    ensure(!receipt.issueCodes.includes("transport-provenance-incomplete"), "SEMANTIC_MISMATCH", "Unavailable compatibility provenance must not be presented as a partially recorded provenance document.", "transport/integrity-receipt.json");
    warnings.push(`Transport provenance is unknown because this is a ${expectedReason} session.`);
    return;
  }

  ensure(manifest.session.formatVersion === 2 && provenanceDocument.provenance.sourceId === manifest.session.sourceId && provenanceDocument.provenance.transport === provenanceDocument.transport, "SEMANTIC_MISMATCH", "Available provenance identity does not match manifest.json.");
  const provenance = provenanceDocument.provenance;
  ensure(new Set(provenance.issueCodes).size === provenance.issueCodes.length, "SEMANTIC_MISMATCH", "Transport provenance issue codes must be unique.", "transport/provenance.json");
  ensure(manifest.provenance.availability === "available" && manifest.provenance.status === provenance.status && isDeepStrictEqual(manifest.provenance.issueCodes, provenance.issueCodes), "SEMANTIC_MISMATCH", "Manifest provenance status does not match the provenance artifact.");
  ensure(
    receipt.issueCodes.includes("transport-provenance-incomplete") === (provenance.status === "incomplete"),
    "SEMANTIC_MISMATCH",
    "Capture-integrity and transport-provenance completeness disagree.",
    "transport/integrity-receipt.json",
  );
  if (provenance.status === "incomplete") warnings.push(`Transport provenance is incomplete: ${provenance.issueCodes.join(", ") || "unspecified"}.`);

  if (provenance.transport === "serial") {
    const identifiersUnavailable = provenance.device.usbVendorId === null
      && provenance.device.usbProductId === null
      && provenance.device.bluetoothServiceClassId === null;
    ensure(
      provenance.status === "verified"
      && sameStringSet(provenance.issueCodes, identifiersUnavailable ? ["serial-device-identifiers-unavailable"] : []),
      "SEMANTIC_MISMATCH",
      "Serial provenance status or identifier disclosure is inconsistent.",
      "transport/provenance.json",
    );
    ensure(journalDocument.availability === "unavailable" && journalDocument.reason === "not-applicable", "SEMANTIC_MISMATCH", "Serial evidence must disclose the UDP journal as not applicable.");
    ensure(isDeepStrictEqual(manifest.provenance, {
      availability: "available",
      status: provenance.status,
      sourceId: provenance.sourceId,
      transport: "serial",
      issueCodes: [...provenance.issueCodes],
      captureId: null,
      endpointAttribution: null,
      journal: { availability: "unavailable", reason: "not-applicable", state: null, entriesComplete: null, entryCount: 0, omittedEntries: 0 },
    }), "SEMANTIC_MISMATCH", "Serial provenance summary does not match its artifact.");
    return;
  }

  const attribution = provenance.endpointAttribution;
  ensure(attribution.attributedRecords + attribution.unattributedRecords === attribution.totalRecords && attribution.totalRecords === receipt.retained.records, "SEMANTIC_MISMATCH", "UDP endpoint totals do not match retained records.");
  const endpointKeys = attribution.distinctEndpoints.map(udpEndpointKey);
  ensure(new Set(endpointKeys).size === endpointKeys.length, "SEMANTIC_MISMATCH", "UDP endpoint attribution contains duplicate endpoints.");
  ensure(isDeepStrictEqual(manifest.provenance.endpointAttribution, {
    totalRecords: attribution.totalRecords,
    attributedRecords: attribution.attributedRecords,
    unattributedRecords: attribution.unattributedRecords,
    distinctEndpointCount: attribution.distinctEndpoints.length,
  }), "SEMANTIC_MISMATCH", "Manifest endpoint attribution does not match provenance.json.");
  const knownEndpoints = new Set(endpointKeys);
  let rangeAttributed = 0;
  let rangeUnattributed = 0;
  for (const record of rawRecords) {
    if (record.transport.kind !== "udp") continue;
    if (record.transport.remoteEndpoint) {
      ensure(knownEndpoints.has(udpEndpointKey(record.transport.remoteEndpoint)), "SEMANTIC_MISMATCH", `Raw record ${record.id} uses an undeclared UDP endpoint.`);
      rangeAttributed += 1;
    } else {
      rangeUnattributed += 1;
      ensure(attribution.unattributedRecords > 0, "SEMANTIC_MISMATCH", `Raw record ${record.id} lacks endpoint attribution despite a zero whole-session unattributed count.`);
    }
  }
  if (manifest.inclusions.rawRecords && rawRecords.length === receipt.retained.records && manifest.selection.startUs === 0) {
    ensure(rangeAttributed === attribution.attributedRecords && rangeUnattributed === attribution.unattributedRecords, "SEMANTIC_MISMATCH", "Full-session raw endpoint attribution does not match provenance totals.");
  } else if (manifest.inclusions.rawRecords) {
    ensure(
      rangeAttributed <= attribution.attributedRecords && rangeUnattributed <= attribution.unattributedRecords,
      "SEMANTIC_MISMATCH",
      "Selected raw endpoint attribution exceeds whole-session provenance totals.",
    );
    warnings.push("Raw records cover only the selected range; whole-session endpoint totals cannot be reconstructed from this artifact alone.");
  }

  const journal = provenance.journal;
  const journalUnavailable = journal === null;
  const journalIncomplete = journal !== null
    && (journal.state !== "clean" || !journal.entriesComplete || journal.omittedEntries > 0);
  const journalCounterMismatch = journal !== null
    && (journal.datagrams !== receipt.retained.records
      || journal.bytes !== receipt.retained.bytes
      || journal.datagrams !== receipt.input.transportReportedUnits
      || journal.bytes !== receipt.input.transportReportedBytes);
  const expectedIssueCodes = [
    ...(journalUnavailable ? ["udp-bridge-journal-unavailable"] : []),
    ...(journalIncomplete ? ["udp-bridge-journal-incomplete"] : []),
    ...(journalCounterMismatch ? ["udp-bridge-journal-counter-mismatch"] : []),
    ...(attribution.unattributedRecords > 0 ? ["udp-endpoint-attribution-incomplete"] : []),
    ...(journal !== null && journal.kernelDroppedDatagrams === null ? ["udp-kernel-drop-counter-unavailable"] : []),
  ];
  ensure(
    sameStringSet(provenance.issueCodes, expectedIssueCodes)
    && (provenance.status === "incomplete") === (journalUnavailable || journalIncomplete || journalCounterMismatch || attribution.unattributedRecords > 0),
    "SEMANTIC_MISMATCH",
    "UDP provenance status or issue-code disclosure is inconsistent.",
    "transport/provenance.json",
  );
  if (!journal) {
    ensure(journalDocument.availability === "unavailable" && journalDocument.reason === "journal-unavailable", "SEMANTIC_MISMATCH", "Missing UDP journal is not disclosed consistently.");
    ensure(isDeepStrictEqual(manifest.provenance.journal, { availability: "unavailable", reason: "journal-unavailable", state: null, entriesComplete: null, entryCount: 0, omittedEntries: 0 }) && manifest.provenance.captureId === null, "SEMANTIC_MISMATCH", "Manifest journal summary does not match unavailable journal evidence.");
    return;
  }

  if (provenance.schemaVersion === 2) {
    const accounting = provenance.byteAccounting;
    ensure(accounting !== null, "SEMANTIC_MISMATCH", "Version 2 UDP provenance requires byte accounting when its journal is available.", "transport/provenance.json");
    const expectedUdpBytes = journal.bytes + (journal.datagrams * 8);
    const expectedIpHeaderBytes = journal.bind.family === "IPv4" ? 20 : 40;
    ensure(
      accounting.datagrams === journal.datagrams
        && accounting.payload.bytes === journal.bytes
        && accounting.udp.bytes === expectedUdpBytes
        && accounting.ip.bytes === expectedUdpBytes + (journal.datagrams * expectedIpHeaderBytes)
        && accounting.ip.family === journal.bind.family
        && accounting.ip.headerBytesPerDatagram === expectedIpHeaderBytes,
      "SEMANTIC_MISMATCH",
      "UDP byte accounting does not reconcile with the bridge journal.",
      "transport/provenance.json",
    );
  }

  const kernelDrops = journal.kernelDroppedDatagrams ?? 0;
  const dropEvents = events.filter((event) => event.type === "udp-kernel-drops-observed");
  ensure(
    receipt.issueCodes.includes("udp-kernel-drops-observed") === (kernelDrops > 0)
      && dropEvents.length <= 1
      && (kernelDrops > 0
        ? (!receipt.eventLogComplete || dropEvents.length === 1)
        : dropEvents.length === 0)
      && dropEvents.every((event) => (
        event.kernelDroppedDatagrams === kernelDrops
        && event.counterSource === journal.kernelDroppedDatagramsSource
      )),
    "SEMANTIC_MISMATCH",
    "UDP kernel-drop evidence does not reconcile across the journal, event log, and receipt.",
    "transport/provenance.json",
  );

  ensure(journalDocument.availability === "available" && journalDocument.captureId === journal.captureId && isDeepStrictEqual(journalDocument.journal, journal), "SEMANTIC_MISMATCH", "Journal artifact does not match provenance.json.");
  verifyUdpJournal(journal, receipt, manifest.session.startedAt, manifest.session.durationUs);
  ensure(manifest.provenance.captureId === journal.captureId && isDeepStrictEqual(manifest.provenance.journal, {
    availability: "available",
    reason: null,
    state: journal.state,
    entriesComplete: journal.entriesComplete,
    entryCount: journal.entries.length,
    omittedEntries: journal.omittedEntries,
  }), "SEMANTIC_MISMATCH", "Manifest journal summary does not match journal.json.");
}

function manifestDecoderDescriptor(manifest: EvidenceBundleManifest): DecoderDescriptor {
  const descriptor: DecoderDescriptor = {
    id: manifest.session.decoderId,
    revision: manifest.session.decoderRevision,
    schemaHash: manifest.session.schemaHash,
  };
  if (
    manifest.session.packHash != null
    && manifest.session.runtimeId != null
    && manifest.session.runtimeRevision != null
  ) {
    descriptor.packHash = manifest.session.packHash;
    descriptor.runtimeId = manifest.session.runtimeId;
    descriptor.runtimeRevision = manifest.session.runtimeRevision;
  }
  return descriptor;
}

function resolveVerifiedDecoderPack(
  manifest: EvidenceBundleManifest,
  embeddedPack: DecoderPackDocument | undefined,
  path: string,
): DecoderPackDocument {
  try {
    const pack = resolveDecoderPack(manifestDecoderDescriptor(manifest), embeddedPack);
    verifyDecoderPackConformance(pack);
    return pack;
  } catch (error) {
    fail(
      "SEMANTIC_MISMATCH",
      `${path} does not provide a compatible, conformant decoder pack for the declared identity.`,
      path,
      error,
    );
  }
}

function verifySchemaArtifact(
  entries: Map<string, Uint8Array>,
  manifest: EvidenceBundleManifest,
  warnings: string[],
): DecoderPackDocument | null {
  if (!manifest.inclusions.schema) {
    warnings.push("The decoder schema artifact was excluded, so decoder identity cannot be independently re-hashed from this bundle.");
    try {
      return resolveVerifiedDecoderPack(manifest, undefined, "manifest.json");
    } catch (error) {
      if (error instanceof EvidenceVerificationError) {
        warnings.push("The exact decoder pack is unavailable, so decoded packet rows cannot be replay-checked.");
        return null;
      }
      throw error;
    }
  }
  const path = "schema/schema.json";
  const document = parseCanonicalJson(entries, path, schemaArtifactSchema);
  ensure(recordCount(manifest, path) === 1, "SEMANTIC_MISMATCH", `${path} must declare one schema record.`, path);
  ensure(document.schema.id === manifest.session.decoderId && document.schema.revision === manifest.session.decoderRevision && document.schema.declaredSha256 === manifest.session.schemaHash, "SEMANTIC_MISMATCH", `${path} decoder descriptor does not match manifest.json.`, path);
  ensure(document.sessionFormat.version === manifest.session.formatVersion && document.timing.displayTimeZone === manifest.session.displayTimeZone && document.timing.sessionStartedAt === manifest.session.startedAt, "SEMANTIC_MISMATCH", `${path} session identity does not match manifest.json.`, path);
  const decoderHash = sha256(TEXT_ENCODER.encode(JSON.stringify(canonicalize(document.decoder))));
  ensure(decoderHash === manifest.session.schemaHash, "SEMANTIC_MISMATCH", `${path} embedded decoder bytes do not match the declared schema SHA-256.`, path);
  const hasPackIdentity = manifest.session.packHash != null;
  ensure(
    (document.decoderPack != null) === hasPackIdentity,
    "SEMANTIC_MISMATCH",
    `${path} embedded decoder-pack availability does not match manifest.json.`,
    path,
  );
  ensure(
    document.schema.packSha256 === manifest.session.packHash
      && document.schema.runtimeId === manifest.session.runtimeId
      && document.schema.runtimeRevision === manifest.session.runtimeRevision,
    "SEMANTIC_MISMATCH",
    `${path} decoder pack identity does not match manifest.json.`,
    path,
  );
  return resolveVerifiedDecoderPack(manifest, document.decoderPack, path);
}

function verifyArtifactContract(entries: Map<string, Uint8Array>, manifest: EvidenceBundleManifest): void {
  ensure(manifest.selection.endUs > manifest.selection.startUs, "SEMANTIC_MISMATCH", "Manifest selection must be a non-empty half-open range.", "manifest.json");
  ensure(manifest.selection.endUs <= manifest.session.durationUs, "SEMANTIC_MISMATCH", "Manifest selection exceeds the declared session duration.", "manifest.json");
  const artifactPaths = manifest.artifacts.map((artifact) => artifact.path);
  ensure(isDeepStrictEqual(artifactPaths, sortedUnique(artifactPaths)), "ARTIFACT_CONTRACT_MISMATCH", "Manifest artifact paths must be unique and sorted.", "manifest.json");
  const expectedPaths = new Set<EvidenceArtifactPath>(MANDATORY_EVIDENCE_ARTIFACT_PATHS);
  for (const [inclusion, paths] of Object.entries(OPTIONAL_EVIDENCE_ARTIFACT_GROUPS) as Array<[keyof typeof OPTIONAL_EVIDENCE_ARTIFACT_GROUPS, readonly EvidenceArtifactPath[]]>) {
    if (manifest.inclusions[inclusion]) for (const path of paths) expectedPaths.add(path);
  }
  const expectedArtifactPaths = [...expectedPaths].sort(compareText);
  ensure(isDeepStrictEqual(artifactPaths, expectedArtifactPaths), "ARTIFACT_CONTRACT_MISMATCH", "Manifest artifacts do not exactly match its inclusion flags.", "manifest.json");
  const expectedCoveredPaths = ["manifest.json", ...expectedArtifactPaths].sort(compareText);
  ensure(isDeepStrictEqual(manifest.checksums.covers, expectedCoveredPaths), "ARTIFACT_CONTRACT_MISMATCH", "Manifest checksum coverage is incomplete or unsorted.", "manifest.json");
  const archivePaths = [...entries.keys()].sort(compareText);
  ensure(isDeepStrictEqual(archivePaths, ["SHA256SUMS", ...expectedCoveredPaths].sort(compareText)), "ARTIFACT_CONTRACT_MISMATCH", "Archive contains missing, extra, or unlisted paths.");

  for (const artifact of manifest.artifacts) {
    const bytes = entries.get(artifact.path);
    ensure(bytes, "ARTIFACT_CONTRACT_MISMATCH", `Archive is missing ${artifact.path}.`, artifact.path);
    ensure(artifact.mediaType === EVIDENCE_ARTIFACT_MEDIA_TYPES[artifact.path], "ARTIFACT_CONTRACT_MISMATCH", `Manifest media type is wrong for ${artifact.path}.`, artifact.path);
    ensure(artifact.bytes === bytes.byteLength, "ARTIFACT_CONTRACT_MISMATCH", `Manifest byte count is wrong for ${artifact.path}.`, artifact.path);
    ensure(artifact.sha256 === sha256(bytes), "CHECKSUM_MISMATCH", `Manifest SHA-256 is wrong for ${artifact.path}.`, artifact.path);
  }

  const checksumPath = "SHA256SUMS";
  const checksumText = decodeText(entries, checksumPath, 16 * 1024);
  ensure(checksumText.endsWith("\n"), "CONTENT_INVALID", "SHA256SUMS must end with LF.", checksumPath);
  const lines = checksumText.slice(0, -1).split("\n");
  ensure(lines.length === expectedCoveredPaths.length, "ARTIFACT_CONTRACT_MISMATCH", "SHA256SUMS has the wrong number of lines.", checksumPath);
  const paths: string[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$/.exec(line);
    ensure(match, "CONTENT_INVALID", `SHA256SUMS line ${index + 1} is invalid.`, checksumPath);
    const hash = match[1];
    const path = match[2];
    ensure(hash && path && !paths.includes(path), "ARTIFACT_CONTRACT_MISMATCH", `SHA256SUMS repeats path ${path}.`, checksumPath);
    const bytes = entries.get(path);
    ensure(bytes && sha256(bytes) === hash, "CHECKSUM_MISMATCH", `SHA256SUMS mismatch for ${path}.`, path);
    paths.push(path);
  }
  ensure(isDeepStrictEqual(paths, expectedCoveredPaths), "ARTIFACT_CONTRACT_MISMATCH", "SHA256SUMS paths must exactly match manifest coverage in sorted order.", checksumPath);
}

function evidenceVerdict(capture: CaptureIntegrityReceipt["status"], provenance: EvidenceBundleManifest["provenance"]["status"]): "verified" | "incomplete" | "unknown" {
  if (capture === "unknown" || provenance === "unknown") return "unknown";
  if (capture === "verified" && provenance === "verified") return "verified";
  return "incomplete";
}

export function verifyEvidenceBundleBytes(archiveBytes: Uint8Array): VerifiedEvidenceBundle {
  ensure(archiveBytes.byteLength > 0, "ARCHIVE_STRUCTURE_INVALID", "Evidence bundle is empty.");
  let entries: Map<string, Uint8Array>;
  try {
    entries = readEvidenceZip(archiveBytes);
  } catch (error) {
    if (error instanceof EvidenceZipError) {
      const limitCodes = new Set(["archive-too-large", "entry-count-exceeded", "entry-too-large", "total-size-exceeded"]);
      const unsafeCodes = new Set([
        "filename-invalid",
        "unsafe-path",
        "unknown-path",
        "directory-entry",
        "duplicate-path",
        "encrypted-entry",
        "data-descriptor-unsupported",
        "unsupported-flags",
        "unsupported-compression",
      ]);
      const code: EvidenceVerificationErrorCode = limitCodes.has(error.code)
        ? "ARCHIVE_LIMIT_EXCEEDED"
        : unsafeCodes.has(error.code)
          ? "ARCHIVE_UNSAFE"
          : "ARCHIVE_STRUCTURE_INVALID";
      fail(code, error.message, error.entryPath, error);
    }
    throw error;
  }

  const manifestText = decodeText(entries, "manifest.json", EVIDENCE_ARCHIVE_LIMITS.jsonBytes);
  assertJsonNesting(manifestText, "manifest.json");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestText);
  } catch (error) {
    fail("CONTENT_INVALID", "manifest.json is not valid JSON.", "manifest.json", error);
  }
  if (
    manifestValue
    && typeof manifestValue === "object"
    && "formatVersion" in manifestValue
    && !SUPPORTED_EVIDENCE_BUNDLE_FORMAT_VERSIONS.includes(
      (manifestValue as { formatVersion?: unknown }).formatVersion as 3 | 4,
    )
  ) {
    fail("UNSUPPORTED_BUNDLE_VERSION", `Unsupported ReplayCase evidence bundle version ${String((manifestValue as { formatVersion?: unknown }).formatVersion)}.`, "manifest.json");
  }
  ensure(manifestText === canonicalJson(manifestValue, true), "CONTENT_INVALID", "manifest.json is not canonical ReplayCase JSON.", "manifest.json");
  const parsedManifest = evidenceBundleManifestSchema.safeParse(manifestValue);
  if (!parsedManifest.success) fail("CONTENT_INVALID", "manifest.json does not match the supported v3/v4 evidence schema.", "manifest.json", parsedManifest.error);
  const manifest = parsedManifest.data;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: manifest.session.displayTimeZone }).format(0);
  } catch (error) {
    fail("CONTENT_INVALID", "manifest.json declares an invalid IANA display time zone.", "manifest.json", error);
  }
  verifyArtifactContract(entries, manifest);

  const transportEventsDocument = parseCanonicalJson(entries, "transport/events.json", evidenceTransportEventsDocumentSchema);
  assertSelectionRange(transportEventsDocument.range, manifest, "transport/events.json");
  ensure(transportEventsDocument.events.length === recordCount(manifest, "transport/events.json"), "SEMANTIC_MISMATCH", "Transport event recordCount does not match its content.", "transport/events.json");
  const eventIds = new Set<string>();
  let previousEventIndex = -1;
  let previousTimedStartUs = -1;
  for (const event of transportEventsDocument.events) {
    if (event.scope.kind === "interval") {
      ensure(event.scope.endUs > event.scope.startUs && event.scope.endUs <= manifest.session.durationUs, "SEMANTIC_MISMATCH", `Transport event ${event.id} has an empty interval or exceeds the declared session duration.`, "transport/events.json");
    } else if (event.scope.kind === "point") {
      ensure(event.scope.offsetUs < manifest.session.durationUs, "SEMANTIC_MISMATCH", `Transport event ${event.id} exceeds the declared session duration.`, "transport/events.json");
    }
    const timedStartUs = event.scope.kind === "point"
      ? event.scope.offsetUs
      : event.scope.kind === "interval"
        ? event.scope.startUs
        : null;
    if (timedStartUs !== null) {
      ensure(timedStartUs >= previousTimedStartUs, "SEMANTIC_MISMATCH", `Transport event ${event.id} reorders the event clock.`, "transport/events.json");
      previousTimedStartUs = timedStartUs;
    }
    if (event.type === "udp-event-sequence-discontinuity") {
      ensure(event.expectedSequence !== event.observedSequence, "SEMANTIC_MISMATCH", `Transport event ${event.id} does not describe a sequence discontinuity.`, "transport/events.json");
    }
    if (event.type === "udp-counter-mismatch") {
      const countersReconcile = event.bridgeDatagrams === event.browserDatagrams
        && event.bridgeBytes === event.browserBytes
        && event.browserDatagrams === event.retainedRecords
        && event.browserBytes === event.retainedBytes;
      ensure(!countersReconcile, "SEMANTIC_MISMATCH", `Transport event ${event.id} labels matching UDP counters as a mismatch.`, "transport/events.json");
    }
    if (event.type === "serial-counter-mismatch") {
      ensure(event.observedBytes !== event.retainedBytes, "SEMANTIC_MISMATCH", `Transport event ${event.id} labels matching serial bytes as a mismatch.`, "transport/events.json");
    }
    if ((event.type === "capture-backpressure" || event.type === "capture-limit") && event.component === "udp-prestatus-buffer") {
      ensure(event.transport === "udp", "SEMANTIC_MISMATCH", `Transport event ${event.id} assigns the UDP pre-status buffer to another transport.`, "transport/events.json");
    }
    ensure(!eventIds.has(event.id) && event.index > previousEventIndex && intersectsSelection(event, manifest), "SEMANTIC_MISMATCH", `Transport event ${event.id} is duplicated, reordered, or outside the selected range.`, "transport/events.json");
    eventIds.add(event.id);
    previousEventIndex = event.index;
  }

  const receipt = parseCanonicalJson(entries, "transport/integrity-receipt.json", captureIntegrityReceiptSchema);
  ensure(recordCount(manifest, "transport/integrity-receipt.json") === 1, "SEMANTIC_MISMATCH", "Integrity receipt artifact must declare one record.", "transport/integrity-receipt.json");
  const provenanceParsed = parseCanonicalJson(entries, "transport/provenance.json", evidenceTransportProvenanceDocumentSchema);
  const journalParsed = parseCanonicalJson(entries, "transport/journal.json", evidenceTransportJournalDocumentSchema);
  const provenance = provenanceParsed as EvidenceTransportProvenanceDocument;
  const journal = journalParsed as EvidenceTransportJournalDocument;
  ensure(recordCount(manifest, "transport/provenance.json") === 1, "SEMANTIC_MISMATCH", "Provenance artifact must declare one record.", "transport/provenance.json");
  ensure(recordCount(manifest, "transport/journal.json") === (journal.availability === "available" ? journal.journal.entries.length : 0), "SEMANTIC_MISMATCH", "Journal recordCount does not match its entries.", "transport/journal.json");

  const warnings: string[] = [];
  const decoderPack = verifySchemaArtifact(entries, manifest, warnings);
  const rawRecords = parseRawRecords(entries, manifest);
  verifyCaptureReceipt(manifest, receipt, transportEventsDocument.events, rawRecords);
  const decoded = verifyDecodedCsv(entries, manifest, rawRecords, decoderPack, warnings);
  const diagnostics = verifyDiagnostics(entries, manifest, decoded.frameIds);
  const markers = verifyMarkers(entries, manifest);
  const notes = verifyNotes(entries, manifest);
  verifyTransportEvidence(manifest, provenance, journal, receipt, transportEventsDocument.events, rawRecords, warnings);
  if (!manifest.inclusions.rawRecords) warnings.push("Raw source records were excluded from this bundle.");
  if (receipt.status === "incomplete") warnings.push(`Capture integrity is incomplete: ${receipt.issueCodes.join(", ") || "unspecified"}.`);
  if (receipt.status === "unknown") warnings.push("Capture integrity is unknown for this session format or source.");
  warnings.push("Authenticity is not established: v3/v4 evidence bundles are checksummed but unsigned.");

  const artifactPaths = manifest.artifacts.map((artifact) => artifact.path);
  const report: EvidenceVerificationReport = {
    format: "narrowslink/bundle-verification-report",
    formatVersion: 1,
    integrity: "internally-consistent",
    evidence: evidenceVerdict(receipt.status, manifest.provenance.status),
    captureEvidence: receipt.status,
    provenanceEvidence: manifest.provenance.status,
    authenticity: "not-established",
    bundle: { bytes: archiveBytes.byteLength, sha256: sha256(archiveBytes) },
    selection: manifest.selection,
    session: {
      id: manifest.session.id,
      title: manifest.session.title,
      formatVersion: manifest.session.formatVersion,
      sourceId: manifest.session.sourceId,
      decoderId: manifest.session.decoderId,
      decoderRevision: manifest.session.decoderRevision,
      schemaHash: manifest.session.schemaHash,
      packHash: manifest.session.packHash ?? null,
      runtimeId: manifest.session.runtimeId ?? null,
      runtimeRevision: manifest.session.runtimeRevision ?? null,
    },
    artifacts: { count: artifactPaths.length, paths: artifactPaths },
    warnings,
  };
  return {
    paths: [...entries.keys()].sort((left, right) => left.localeCompare(right)),
    manifest,
    rawRecords,
    decodedPackets: decoded.packets,
    decodedRecordCount: decoded.recordCount,
    diagnostics,
    markers,
    notes,
    transportEvents: transportEventsDocument.events,
    integrityReceipt: receipt,
    transportProvenance: provenance,
    transportJournal: journal,
    decoderPack,
    report,
  };
}
