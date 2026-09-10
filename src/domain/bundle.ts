import { zipSync, type Zippable } from "fflate";

import {
  EVIDENCE_ARCHIVE_LIMITS,
  EVIDENCE_BUNDLE_FORMAT_VERSION,
  EVIDENCE_BUNDLE_MEDIA_TYPE,
  evidenceBundleManifestSchema,
  evidenceDiagnosticsDocumentSchema,
  evidenceMarkersDocumentSchema,
  evidenceNotesDocumentSchema,
  type EvidenceArtifactPath,
  type EvidenceBundleArtifact,
  type EvidenceBundleInclusions,
  type EvidenceBundleManifest,
  type EvidenceBundleProvenanceSummary,
  type EvidenceTransportJournalDocument,
  type EvidenceTransportProvenanceDocument,
} from "./evidence-contract";
import type {
  DecodedField,
  DecodedFrame,
  DiagnosticEvent,
  IncidentProjection,
  Marker,
  ParsedSession,
  SourceRecord,
  TransportEvent,
} from "./types";

export {
  EVIDENCE_BUNDLE_MEDIA_TYPE,
  type EvidenceBundleArtifact,
  type EvidenceBundleInclusions,
  type EvidenceBundleManifest,
  type EvidenceBundleProvenanceSummary,
  type EvidenceTransportJournalDocument,
  type EvidenceTransportProvenanceDocument,
  type EvidenceTransportUnavailableReason,
} from "./evidence-contract";

export interface EvidenceRange {
  id?: string;
  title?: string;
  severity?: "info" | "warning" | "critical";
  startUs: number;
  endUs: number;
}

export interface EvidenceNote {
  id: string;
  offsetUs?: number;
  title?: string;
  body: string;
  createdAt?: string;
}

export interface BuildEvidenceBundleOptions {
  session: ParsedSession;
  range: EvidenceRange | IncidentProjection;
  markers?: readonly Marker[];
  notes?: readonly EvidenceNote[];
  include?: Partial<EvidenceBundleInclusions>;
  /** Injectable to support reproducible builds and tests. Defaults to the current instant. */
  generatedAt?: string;
}

const DEFAULT_INCLUSIONS: EvidenceBundleInclusions = {
  rawRecords: true,
  decodedPackets: true,
  diagnostics: true,
  markers: true,
  notes: true,
  schema: true,
  transportEvidence: true,
};

const TEXT_ENCODER = new TextEncoder();

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOffsetAndId(
  left: { offsetUs: number; id: string },
  right: { offsetUs: number; id: string },
): number {
  return left.offsetUs - right.offsetUs || compareText(left.id, right.id);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown, pretty = false): string {
  return `${JSON.stringify(canonicalize(value), null, pretty ? 2 : undefined)}\n`;
}

function csvCell(value: unknown): string {
  const rawText = value == null ? "" : String(value);
  const text = typeof value === "string" && (rawText.startsWith("'") || /^[\t\r ]*[=+\-@]/.test(rawText))
    ? `'${rawText}`
    : rawText;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows: readonly (readonly unknown[])[]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function integrityLabel(frame: DecodedFrame): string {
  return frame.integrity.status;
}

function fieldsJson(fields: DecodedField[]): string {
  return JSON.stringify(canonicalize(fields));
}

function makeDecodedCsv(frames: readonly DecodedFrame[]): string {
  const rows: unknown[][] = [
    [
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
    ],
  ];
  for (const frame of frames) {
    rows.push([
      frame.id,
      frame.ordinal,
      frame.offsetUs,
      frame.sourceRecord.id,
      frame.status,
      integrityLabel(frame),
      frame.protocolVersion,
      frame.familyId,
      frame.familyName,
      frame.sequence,
      frame.deviceTimeMs,
      frame.payloadLength,
      JSON.stringify(canonicalize(frame.integrity)),
      fieldsJson(frame.fields),
    ]);
  }
  return csv(rows);
}

function makeDiagnosticsCsv(events: readonly DiagnosticEvent[]): string {
  const rows: unknown[][] = [
    ["diagnostic_id", "type", "domain", "severity", "start_us", "end_us", "title", "description", "frame_ids"],
  ];
  for (const event of events) {
    rows.push([
      event.id,
      event.type,
      event.domain,
      event.severity,
      event.startUs,
      event.endUs,
      event.title,
      event.description,
      event.frameIds.join("|"),
    ]);
  }
  return csv(rows);
}

function inHalfOpenRange(offsetUs: number, range: EvidenceRange): boolean {
  return offsetUs >= range.startUs && offsetUs < range.endUs;
}

function recordsForRange(records: readonly SourceRecord[], range: EvidenceRange): SourceRecord[] {
  return records
    .filter((record) => inHalfOpenRange(record.offsetUs, range))
    .sort((left, right) => left.offsetUs - right.offsetUs || left.index - right.index);
}

function framesForRange(frames: readonly DecodedFrame[], range: EvidenceRange): DecodedFrame[] {
  return frames
    .filter((frame) => inHalfOpenRange(frame.offsetUs, range))
    .sort((left, right) => left.offsetUs - right.offsetUs || left.ordinal - right.ordinal || compareText(left.id, right.id));
}

function diagnosticsForRange(events: readonly DiagnosticEvent[], range: EvidenceRange): DiagnosticEvent[] {
  return events
    .filter((event) => event.endUs == null
      ? inHalfOpenRange(event.startUs, range)
      : event.startUs < range.endUs && event.endUs > range.startUs)
    .sort((left, right) => left.startUs - right.startUs || compareText(left.id, right.id));
}

function transportEventIntersectsRange(event: TransportEvent, range: EvidenceRange): boolean {
  if (event.scope.kind === "session") return true;
  if (event.scope.kind === "point") return inHalfOpenRange(event.scope.offsetUs, range);
  return event.scope.startUs < range.endUs && event.scope.endUs > range.startUs;
}

function transportEventsForRange(events: readonly TransportEvent[], range: EvidenceRange): TransportEvent[] {
  return events
    .filter((event) => transportEventIntersectsRange(event, range))
    .sort((left, right) => left.index - right.index || compareText(left.id, right.id));
}

function markersForRange(markers: readonly Marker[], range: EvidenceRange): Marker[] {
  return markers.filter((marker) => inHalfOpenRange(marker.offsetUs, range)).sort(compareOffsetAndId);
}

function notesForRange(notes: readonly EvidenceNote[], range: EvidenceRange): EvidenceNote[] {
  return notes
    .filter((note) => note.offsetUs == null || inHalfOpenRange(note.offsetUs, range))
    .sort(
      (left, right) =>
        (left.offsetUs ?? Number.NEGATIVE_INFINITY) - (right.offsetUs ?? Number.NEGATIVE_INFINITY) ||
        compareText(left.id, right.id),
    );
}

function assertRange(session: ParsedSession, range: EvidenceRange): void {
  if (!Number.isSafeInteger(range.startUs) || !Number.isSafeInteger(range.endUs)) {
    throw new RangeError("Evidence range offsets must be safe integer microseconds.");
  }
  if (range.startUs < 0 || range.endUs <= range.startUs) {
    throw new RangeError("Evidence range must be a non-empty half-open interval.");
  }
  if (range.endUs > session.document.durationUs) {
    throw new RangeError("Evidence range cannot extend beyond the session duration.");
  }
}

function assertGeneratedAt(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError("generatedAt must be an ISO-compatible timestamp.");
}

function textBytes(value: string): Uint8Array {
  return TEXT_ENCODER.encode(value);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto SHA-256 is required to build a verifiable evidence bundle.");
  }
  const stableBytes = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", stableBytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface PendingArtifact {
  path: EvidenceArtifactPath;
  mediaType: string;
  bytes: Uint8Array;
  recordCount?: number;
}

function addTextArtifact(
  artifacts: PendingArtifact[],
  path: EvidenceArtifactPath,
  mediaType: string,
  contents: string,
  recordCount?: number,
): void {
  artifacts.push({ path, mediaType, bytes: textBytes(contents), ...(recordCount == null ? {} : { recordCount }) });
}

function transportEvidenceDocuments(session: ParsedSession): {
  provenanceDocument: EvidenceTransportProvenanceDocument;
  journalDocument: EvidenceTransportJournalDocument;
  summary: EvidenceBundleProvenanceSummary;
} {
  const { document } = session;
  const provenance = document.formatVersion === 2 ? document.transportProvenance : undefined;
  if (!provenance) {
    const unavailableReason = document.formatVersion === 1 ? "legacy-v1" : "pre-provenance-v2";
    const provenanceDocument: EvidenceTransportProvenanceDocument = {
      format: "narrowslink/transport-provenance",
      formatVersion: 1,
      availability: "unavailable",
      reason: unavailableReason,
      sessionFormatVersion: document.formatVersion,
      sourceId: document.source.id,
      transport: document.source.kind,
      provenance: null,
    };
    const journalDocument: EvidenceTransportJournalDocument = {
      format: "narrowslink/transport-journal",
      formatVersion: 1,
      availability: "unavailable",
      reason: unavailableReason,
      sessionFormatVersion: document.formatVersion,
      sourceId: document.source.id,
      transport: document.source.kind,
      captureId: null,
      journal: null,
    };
    return {
      provenanceDocument,
      journalDocument,
      summary: {
        availability: "unavailable",
        status: "unknown",
        sourceId: document.source.id,
        transport: document.source.kind,
        issueCodes: [],
        captureId: null,
        endpointAttribution: null,
        journal: {
          availability: "unavailable",
          reason: unavailableReason,
          state: null,
          entriesComplete: null,
          entryCount: 0,
          omittedEntries: 0,
        },
      },
    };
  }

  const provenanceDocument: EvidenceTransportProvenanceDocument = {
    format: "narrowslink/transport-provenance",
    formatVersion: provenance.transport === "udp" && provenance.schemaVersion === 2 ? 2 : 1,
    availability: "available",
    sessionFormatVersion: 2,
    sourceId: provenance.sourceId,
    transport: provenance.transport,
    provenance,
  };
  if (provenance.transport === "udp") {
    const journal = provenance.journal;
    const journalDocument: EvidenceTransportJournalDocument = journal
      ? {
          format: "narrowslink/transport-journal",
          formatVersion: 1,
          availability: "available",
          sessionFormatVersion: 2,
          sourceId: provenance.sourceId,
          transport: "udp",
          captureId: journal.captureId,
          journal,
        }
      : {
          format: "narrowslink/transport-journal",
          formatVersion: 1,
          availability: "unavailable",
          reason: "journal-unavailable",
          sessionFormatVersion: 2,
          sourceId: provenance.sourceId,
          transport: "udp",
          captureId: null,
          journal: null,
        };
    return {
      provenanceDocument,
      journalDocument,
      summary: {
        availability: "available",
        status: provenance.status,
        sourceId: provenance.sourceId,
        transport: provenance.transport,
        issueCodes: [...provenance.issueCodes],
        captureId: journal?.captureId ?? null,
        endpointAttribution: {
          totalRecords: provenance.endpointAttribution.totalRecords,
          attributedRecords: provenance.endpointAttribution.attributedRecords,
          unattributedRecords: provenance.endpointAttribution.unattributedRecords,
          distinctEndpointCount: provenance.endpointAttribution.distinctEndpoints.length,
        },
        journal: {
          availability: journal ? "available" : "unavailable",
          reason: journal ? null : "journal-unavailable",
          state: journal?.state ?? null,
          entriesComplete: journal?.entriesComplete ?? null,
          entryCount: journal?.entries.length ?? 0,
          omittedEntries: journal?.omittedEntries ?? 0,
        },
      },
    };
  }

  const journalDocument: EvidenceTransportJournalDocument = {
    format: "narrowslink/transport-journal",
    formatVersion: 1,
    availability: "unavailable",
    reason: "not-applicable",
    sessionFormatVersion: 2,
    sourceId: provenance.sourceId,
    transport: "serial",
    captureId: null,
    journal: null,
  };
  return {
    provenanceDocument,
    journalDocument,
    summary: {
      availability: "available",
      status: provenance.status,
      sourceId: provenance.sourceId,
      transport: provenance.transport,
      issueCodes: [...provenance.issueCodes],
      captureId: null,
      endpointAttribution: null,
      journal: {
        availability: "unavailable",
        reason: "not-applicable",
        state: null,
        entriesComplete: null,
        entryCount: 0,
        omittedEntries: 0,
      },
    },
  };
}

function schemaArtifact(session: ParsedSession): object {
  const descriptor = session.document.decoder;
  const hasPackIdentity = descriptor.packHash != null
    && descriptor.runtimeId != null
    && descriptor.runtimeRevision != null;
  return {
    schema: {
      id: descriptor.id,
      revision: descriptor.revision,
      declaredSha256: descriptor.schemaHash.toLowerCase(),
      ...(hasPackIdentity ? {
        packSha256: descriptor.packHash?.toLowerCase(),
        runtimeId: descriptor.runtimeId,
        runtimeRevision: descriptor.runtimeRevision,
      } : {}),
      artifactIntegrity: "The evidence manifest independently hashes this exported schema artifact.",
    },
    sessionFormat: {
      id: session.document.format,
      version: session.document.formatVersion,
    },
    timing: {
      displayTimeZone: session.document.displayTimeZone,
      offsetUnit: "integer microseconds from session.startedAt",
      rangeSemantics: "half-open [startUs, endUs)",
      sessionStartedAt: session.document.startedAt,
    },
    transportEvidence: {
      eventRangeSemantics: "point events at start are included; point events at end are excluded; interval events use half-open overlap",
      sessionScopeEvents: "included in every selected range",
      integrityReceiptScope: "whole session",
      provenanceScope: "whole session",
      bridgeJournalScope: "whole session when available; explicit unavailability otherwise",
    },
    decoder: session.decoderPack.schema,
    ...(hasPackIdentity ? { decoderPack: session.decoderPack } : {}),
  };
}

/**
 * Builds a verifiable ReplayCase evidence archive entirely in memory.
 * Every time-bearing artifact is filtered with exact [startUs, endUs) semantics.
 */
export async function buildEvidenceBundle(options: BuildEvidenceBundleOptions): Promise<Uint8Array> {
  const { session } = options;
  const range: EvidenceRange = options.range;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const inclusions: EvidenceBundleInclusions = { ...DEFAULT_INCLUSIONS, ...options.include, transportEvidence: true };
  assertRange(session, range);
  assertGeneratedAt(generatedAt);

  const records = recordsForRange(session.document.records, range);
  const frames = framesForRange(session.frames, range);
  const selectedFrameIds = new Set(frames.map((frame) => frame.id));
  const diagnostics = diagnosticsForRange(session.diagnostics, range).map((event) => ({
    ...event,
    frameIds: event.frameIds.filter((frameId) => selectedFrameIds.has(frameId)),
  }));
  const transportEvents = transportEventsForRange(session.transportEvents, range);
  const markers = markersForRange(options.markers ?? [], range);
  const notes = notesForRange(options.notes ?? [], range);
  const transportEvidence = transportEvidenceDocuments(session);
  const pendingArtifacts: PendingArtifact[] = [];

  addTextArtifact(
    pendingArtifacts,
    "transport/events.json",
    "application/json",
    canonicalJson({
      range: {
        startUs: range.startUs,
        endUs: range.endUs,
        rangeSemantics: "half-open [startUs, endUs)",
      },
      events: transportEvents,
    }, true),
    transportEvents.length,
  );
  addTextArtifact(
    pendingArtifacts,
    "transport/integrity-receipt.json",
    "application/json",
    canonicalJson(session.captureIntegrity, true),
    1,
  );
  addTextArtifact(
    pendingArtifacts,
    "transport/provenance.json",
    "application/json",
    canonicalJson(transportEvidence.provenanceDocument, true),
    1,
  );
  addTextArtifact(
    pendingArtifacts,
    "transport/journal.json",
    "application/json",
    canonicalJson(transportEvidence.journalDocument, true),
    transportEvidence.journalDocument.journal?.entries.length ?? 0,
  );

  if (inclusions.rawRecords) {
    addTextArtifact(
      pendingArtifacts,
      "raw/source-records.ndjson",
      "application/x-ndjson",
      records.map((record) => JSON.stringify(canonicalize(record))).join("\n") + (records.length > 0 ? "\n" : ""),
      records.length,
    );
  }
  if (inclusions.decodedPackets) {
    addTextArtifact(
      pendingArtifacts,
      "decoded/packets.csv",
      "text/csv; charset=utf-8",
      makeDecodedCsv(frames),
      frames.length,
    );
  }
  if (inclusions.diagnostics) {
    const diagnosticsDocument = { range: { startUs: range.startUs, endUs: range.endUs }, diagnostics };
    const diagnosticsValidation = evidenceDiagnosticsDocumentSchema.safeParse(diagnosticsDocument);
    if (!diagnosticsValidation.success) {
      throw new TypeError(`Evidence diagnostics artifact violates the current receiver contract: ${diagnosticsValidation.error.issues[0]?.message ?? "invalid diagnostics"}.`);
    }
    addTextArtifact(
      pendingArtifacts,
      "diagnostics/diagnostics.json",
      "application/json",
      canonicalJson(diagnosticsValidation.data, true),
      diagnostics.length,
    );
    addTextArtifact(
      pendingArtifacts,
      "diagnostics/diagnostics.csv",
      "text/csv; charset=utf-8",
      makeDiagnosticsCsv(diagnostics),
      diagnostics.length,
    );
  }
  if (inclusions.markers) {
    const markerDocument = { range: { startUs: range.startUs, endUs: range.endUs }, markers };
    const markerValidation = evidenceMarkersDocumentSchema.safeParse(markerDocument);
    if (!markerValidation.success) {
      throw new TypeError(`Evidence markers artifact violates the current receiver contract: ${markerValidation.error.issues[0]?.message ?? "invalid markers"}.`);
    }
    addTextArtifact(
      pendingArtifacts,
      "markers/markers.json",
      "application/json",
      canonicalJson(markerValidation.data, true),
      markers.length,
    );
  }
  if (inclusions.notes) {
    const noteDocument = { range: { startUs: range.startUs, endUs: range.endUs }, notes };
    const noteValidation = evidenceNotesDocumentSchema.safeParse(noteDocument);
    if (!noteValidation.success) {
      throw new TypeError(`Evidence notes artifact violates the current receiver contract: ${noteValidation.error.issues[0]?.message ?? "invalid notes"}.`);
    }
    addTextArtifact(
      pendingArtifacts,
      "notes/notes.json",
      "application/json",
      canonicalJson(noteValidation.data, true),
      notes.length,
    );
  }
  if (inclusions.schema) {
    addTextArtifact(
      pendingArtifacts,
      "schema/schema.json",
      "application/json",
      canonicalJson(schemaArtifact(session), true),
      1,
    );
  }

  pendingArtifacts.sort((left, right) => compareText(left.path, right.path));
  const artifacts: EvidenceBundleArtifact[] = [];
  for (const artifact of pendingArtifacts) {
    artifacts.push({
      path: artifact.path,
      mediaType: artifact.mediaType,
      bytes: artifact.bytes.byteLength,
      sha256: await sha256(artifact.bytes),
      ...(artifact.recordCount == null ? {} : { recordCount: artifact.recordCount }),
    });
  }

  const coveredPaths = ([
    "manifest.json",
    ...pendingArtifacts.map((artifact) => artifact.path),
  ] as Array<"manifest.json" | EvidenceArtifactPath>).sort((left, right) => compareText(left, right));
  const manifest: EvidenceBundleManifest = {
    format: "narrowslink/evidence-bundle",
    formatVersion: EVIDENCE_BUNDLE_FORMAT_VERSION,
    generatedAt,
    session: {
      id: session.document.id,
      title: session.document.title,
      formatVersion: session.document.formatVersion,
      durationUs: session.document.durationUs,
      startedAt: session.document.startedAt,
      displayTimeZone: session.document.displayTimeZone,
      sourceId: session.document.source.id,
      decoderId: session.document.decoder.id,
      decoderRevision: session.document.decoder.revision,
      schemaHash: session.document.decoder.schemaHash.toLowerCase(),
      ...(session.document.decoder.packHash == null ? {} : {
        packHash: session.document.decoder.packHash.toLowerCase(),
        runtimeId: session.document.decoder.runtimeId,
        runtimeRevision: session.document.decoder.runtimeRevision,
      }),
      captureIntegrity: session.captureIntegrity,
    },
    provenance: transportEvidence.summary,
    selection: {
      id: range.id ?? null,
      title: range.title ?? null,
      severity: range.severity ?? null,
      startUs: range.startUs,
      endUs: range.endUs,
      rangeSemantics: "half-open [startUs, endUs)",
    },
    inclusions,
    artifacts,
    checksums: {
      algorithm: "SHA-256",
      path: "SHA256SUMS",
      covers: coveredPaths,
    },
  };
  const manifestValidation = evidenceBundleManifestSchema.safeParse(manifest);
  if (!manifestValidation.success) {
    throw new TypeError(`Evidence manifest violates the version ${EVIDENCE_BUNDLE_FORMAT_VERSION} receiver contract: ${manifestValidation.error.issues[0]?.message ?? "invalid manifest"}.`);
  }
  const manifestBytes = textBytes(canonicalJson(manifest, true));
  const checksumsByPath = new Map<string, string>(artifacts.map((artifact) => [artifact.path, artifact.sha256]));
  checksumsByPath.set("manifest.json", await sha256(manifestBytes));
  const checksumBytes = textBytes(
    `${coveredPaths.map((path) => `${checksumsByPath.get(path)}  ${path}`).join("\n")}\n`,
  );

  const entries = new Map<string, Uint8Array>([
    ["manifest.json", manifestBytes],
    ...pendingArtifacts.map((artifact): [string, Uint8Array] => [artifact.path, artifact.bytes]),
    ["SHA256SUMS", checksumBytes],
  ]);
  const zippable: Zippable = {};
  let totalUncompressedBytes = 0;
  for (const path of [...entries.keys()].sort((left, right) => compareText(left, right))) {
    const bytes = entries.get(path);
    if (!bytes) continue;
    if (bytes.byteLength > EVIDENCE_ARCHIVE_LIMITS.entryBytes) {
      throw new RangeError(`Evidence artifact ${path} exceeds the ${EVIDENCE_ARCHIVE_LIMITS.entryBytes}-byte limit.`);
    }
    totalUncompressedBytes += bytes.byteLength;
    zippable[path] = bytes;
  }
  if (entries.size > EVIDENCE_ARCHIVE_LIMITS.entries) {
    throw new RangeError(`Evidence bundle exceeds the ${EVIDENCE_ARCHIVE_LIMITS.entries}-entry limit.`);
  }
  if (totalUncompressedBytes > EVIDENCE_ARCHIVE_LIMITS.totalUncompressedBytes) {
    throw new RangeError(
      `Evidence bundle expands beyond the ${EVIDENCE_ARCHIVE_LIMITS.totalUncompressedBytes}-byte receiver limit.`,
    );
  }

  // A fixed local DOS timestamp keeps byte-for-byte output stable when content is stable.
  const archive = zipSync(zippable, { level: 6, mtime: new Date(1980, 0, 1, 0, 0, 0) });
  if (archive.byteLength > EVIDENCE_ARCHIVE_LIMITS.archiveBytes) {
    throw new RangeError(`Evidence bundle exceeds the ${EVIDENCE_ARCHIVE_LIMITS.archiveBytes}-byte archive limit.`);
  }
  return archive;
}

function safeFilenamePart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 72);
}

export function suggestEvidenceBundleFilename(session: ParsedSession, range: EvidenceRange): string {
  const sessionPart = safeFilenamePart(session.document.id || session.document.title) || "session";
  const rangePart = safeFilenamePart(range.id || range.title || `${range.startUs}-${range.endUs}`) || "selection";
  return `${sessionPart}-${rangePart}.nlb`;
}

/** Starts a local browser download without uploading or otherwise transmitting the archive. */
export function downloadEvidenceBundle(bytes: Uint8Array, filename: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("Evidence bundle downloads require a browser document.");
  }
  const stableBytes = Uint8Array.from(bytes);
  const url = URL.createObjectURL(new Blob([stableBytes], { type: EVIDENCE_BUNDLE_MEDIA_TYPE }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.endsWith(".nlb") ? filename : `${filename}.nlb`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
