import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { strFromU8, unzipSync, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";

import { isCliEntry, renderVerificationReport, runCli } from "../scripts/replaycase";
import { buildEvidenceBundle, type EvidenceBundleManifest } from "../src/domain/bundle";
import {
  bytesToHex,
  encodeFrame,
  NMEA0183_DECODER_PACK,
  SUPPORTED_DECODER,
} from "../src/domain/decoder";
import { decoderDescriptorForPack } from "../src/domain/decoder-pack";
import { EVIDENCE_ARCHIVE_LIMITS } from "../src/domain/evidence-contract";
import { parseSession } from "../src/domain/session";
import type { SessionDocumentV1, SessionDocumentV2, SourceRecord } from "../src/domain/types";
import { EvidenceVerificationError, verifyEvidenceBundleBytes } from "./evidence-verifier";
import { verifyEvidenceBundleFile } from "./evidence-verifier-file";

const generatedAt = "2026-07-18T18:00:00.000Z";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(canonicalize(value), null, 2)}\n`);
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(id: string, index: number, offsetUs: number, kind: "udp" | "serial" | "file"): SourceRecord {
  const bytes = encodeFrame({
    familyId: 0x02,
    sequence: index,
    deviceTimeMs: Math.floor(offsetUs / 1_000),
    payload: new Uint8Array(8),
  });
  return {
    id,
    index,
    sourceId: `${kind}-source`,
    offsetUs,
    dataHex: bytesToHex(bytes),
    captureBytes: bytes.byteLength,
    wireBytes: bytes.byteLength,
    transport: {
      kind,
      ...(kind === "udp"
        ? { kernelDropCounter: null, remoteEndpoint: { address: "192.0.2.40", port: 9_104, family: "IPv4" as const } }
        : {}),
    },
  };
}

function makeUdpSession() {
  const records = [record("udp-0", 0, 100, "udp"), record("udp-1", 1, 200, "udp")];
  const bytes = records.reduce((total, item) => total + item.captureBytes, 0);
  const document: SessionDocumentV2 = {
    format: "narrowslink/session",
    formatVersion: 2,
    id: "receiver-udp",
    title: "Receiver UDP evidence",
    startedAt: "2026-07-18T17:59:00.000Z",
    displayTimeZone: "America/Los_Angeles",
    durationUs: 300,
    source: { id: "udp-source", kind: "udp", label: "UDP source", address: "127.0.0.1", port: 9_120 },
    decoder: { ...SUPPORTED_DECODER },
    records,
    incidents: [],
    transportEvents: [],
    captureIntegrity: {
      schemaVersion: 1,
      status: "verified",
      assessmentBasis: "udp-bridge-reconciled",
      stopDisposition: "confirmed",
      stopOffsetUs: 300,
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
    },
    transportProvenance: {
      schemaVersion: 1,
      sourceId: "udp-source",
      status: "verified",
      issueCodes: ["udp-kernel-drop-counter-unavailable"],
      transport: "udp",
      journal: {
        captureId: "capture-receiver-udp",
        startedAt: "2026-07-18T17:59:00.000Z",
        endedAt: "2026-07-18T17:59:00.000300Z",
        state: "clean",
        bind: {
          requestedHost: "127.0.0.1",
          requestedPort: 9_120,
          host: "127.0.0.1",
          port: 9_120,
          family: "IPv4",
        },
        multicast: null,
        datagrams: records.length,
        bytes,
        kernelDroppedDatagrams: null,
        kernelDroppedDatagramsSource: "unavailable",
        entriesComplete: true,
        omittedEntries: 0,
        entries: [
          {
            sequence: 0,
            type: "capture-started",
            at: "2026-07-18T17:59:00.000Z",
            offsetUs: 0,
            datagrams: 0,
            bytes: 0,
          },
          {
            sequence: 1,
            type: "capture-stopped",
            at: "2026-07-18T17:59:00.000300Z",
            offsetUs: 300,
            datagrams: records.length,
            bytes,
          },
        ],
      },
      endpointAttribution: {
        totalRecords: records.length,
        attributedRecords: records.length,
        unattributedRecords: 0,
        distinctEndpoints: [{ address: "192.0.2.40", port: 9_104, family: "IPv4" }],
      },
    },
  };
  return parseSession(document);
}

function makeSerialSession(includeProvenance = true) {
  const records = [record("serial-0", 0, 100, "serial"), record("serial-1", 1, 200, "serial")];
  const bytes = records.reduce((total, item) => total + item.captureBytes, 0);
  const document: SessionDocumentV2 = {
    format: "narrowslink/session",
    formatVersion: 2,
    id: includeProvenance ? "receiver-serial" : "receiver-pre-provenance",
    title: includeProvenance ? "Receiver serial evidence" : "Receiver pre-provenance evidence",
    startedAt: "2026-07-18T17:59:00.000Z",
    displayTimeZone: "America/Los_Angeles",
    durationUs: 300,
    source: { id: "serial-source", kind: "serial", label: "Serial source" },
    decoder: { ...SUPPORTED_DECODER },
    records,
    incidents: [],
    transportEvents: [],
    captureIntegrity: {
      schemaVersion: 1,
      status: "verified",
      assessmentBasis: "web-serial-observed",
      stopDisposition: "confirmed",
      stopOffsetUs: 300,
      eventLogComplete: true,
      input: {
        unit: "serial-read",
        observedUnits: records.length,
        observedBytes: bytes,
        transportReportedUnits: null,
        transportReportedBytes: null,
      },
      retained: { records: records.length, bytes },
      issueCodes: [],
    },
    ...(includeProvenance
      ? {
          transportProvenance: {
            schemaVersion: 1 as const,
            sourceId: "serial-source",
            status: "verified" as const,
            issueCodes: ["serial-device-identifiers-unavailable" as const],
            transport: "serial" as const,
            device: { usbVendorId: null, usbProductId: null, bluetoothServiceClassId: null },
            settings: {
              baudRate: 115_200,
              dataBits: 8 as const,
              stopBits: 1 as const,
              parity: "none" as const,
              bufferSize: 255,
              flowControl: "none" as const,
            },
          },
        }
      : {}),
  };
  return parseSession(document);
}

function makeNmeaFileSession() {
  const records: SourceRecord[] = NMEA0183_DECODER_PACK.fixtures.flatMap((fixture) =>
    fixture.records.map((item, index) => ({
      id: `${fixture.id}-${index}`,
      index: 0,
      sourceId: "nmea-file-source",
      offsetUs: item.offsetUs,
      dataHex: item.dataHex,
      captureBytes: item.dataHex.length / 2,
      wireBytes: item.dataHex.length / 2,
      transport: { kind: "file" as const },
    })));
  records.sort((left, right) => left.offsetUs - right.offsetUs);
  records.forEach((item, index) => { item.index = index; });
  const bytes = records.reduce((total, item) => total + item.captureBytes, 0);
  const document: SessionDocumentV2 = {
    format: "narrowslink/session",
    formatVersion: 2,
    id: "receiver-nmea",
    title: "Receiver NMEA evidence",
    startedAt: "2026-07-18T17:59:00.000Z",
    displayTimeZone: "America/Los_Angeles",
    durationUs: Math.max(...records.map((item) => item.offsetUs)) + 1,
    source: { id: "nmea-file-source", kind: "file", label: "NMEA conformance source" },
    decoder: decoderDescriptorForPack(NMEA0183_DECODER_PACK),
    decoderPack: NMEA0183_DECODER_PACK,
    records,
    incidents: [],
    transportEvents: [],
    captureIntegrity: {
      schemaVersion: 1,
      status: "unknown",
      assessmentBasis: "file-source-unassessed",
      stopDisposition: "not-observed",
      stopOffsetUs: null,
      eventLogComplete: false,
      input: {
        unit: "unknown",
        observedUnits: null,
        observedBytes: null,
        transportReportedUnits: null,
        transportReportedBytes: null,
      },
      retained: { records: records.length, bytes },
      issueCodes: ["file-source-unassessed"],
    },
  };
  return parseSession(document);
}

function makeIncompleteUdpSession() {
  const document = structuredClone(makeUdpSession().document) as SessionDocumentV2;
  document.transportEvents = [{
    id: "receiver-shutdown-unconfirmed",
    index: 0,
    type: "shutdown-unconfirmed",
    transport: "udp",
    scope: { kind: "session" },
    severity: "critical",
    message: "Bridge stop evidence was not observed.",
    code: "bridge-stop-unconfirmed",
  }];
  document.captureIntegrity.status = "incomplete";
  document.captureIntegrity.assessmentBasis = "udp-browser-observed";
  document.captureIntegrity.stopDisposition = "unconfirmed";
  document.captureIntegrity.input.transportReportedUnits = null;
  document.captureIntegrity.input.transportReportedBytes = null;
  document.captureIntegrity.issueCodes = ["shutdown-unconfirmed", "transport-provenance-incomplete"];
  if (!document.transportProvenance || document.transportProvenance.transport !== "udp") {
    throw new Error("Expected UDP provenance.");
  }
  document.transportProvenance.status = "incomplete";
  document.transportProvenance.issueCodes = ["udp-bridge-journal-unavailable"];
  document.transportProvenance.journal = null;
  return parseSession(document);
}

function makeMeasuredDropUdpSession() {
  const document = structuredClone(makeUdpSession().document) as SessionDocumentV2;
  if (!document.transportProvenance || document.transportProvenance.transport !== "udp" || !document.transportProvenance.journal) {
    throw new Error("Expected UDP journal.");
  }
  const journal = document.transportProvenance.journal;
  journal.kernelDroppedDatagrams = 3;
  journal.kernelDroppedDatagramsSource = "linux-proc-net-udp-socket";
  const udpBytes = journal.bytes + (journal.datagrams * 8);
  document.transportProvenance = {
    ...document.transportProvenance,
    schemaVersion: 2,
    issueCodes: [],
    byteAccounting: {
      schemaVersion: 1,
      scope: "whole-session",
      datagrams: journal.datagrams,
      payload: { bytes: journal.bytes, basis: "observed", source: "udp-bridge-payload-counter", confidence: "exact" },
      udp: { bytes: udpBytes, basis: "estimated", source: "payload-plus-fixed-udp-header", confidence: "deterministic", headerBytesPerDatagram: 8 },
      ip: {
        bytes: udpBytes + (journal.datagrams * 20),
        basis: "minimum-estimate",
        source: "payload-plus-fixed-udp-and-ip-headers",
        confidence: "bounded-assumption",
        family: "IPv4",
        headerBytesPerDatagram: 20,
        assumptions: ["no-ip-options-or-extension-headers", "no-fragmentation"],
      },
      linkLayer: { bytes: null, basis: "unavailable", reason: "not-observed-at-udp-socket" },
      radioLayer: { bytes: null, basis: "unavailable", reason: "not-observed-at-udp-socket" },
    },
  };
  document.transportEvents = [{
    id: "receiver-kernel-drops",
    index: 0,
    type: "udp-kernel-drops-observed",
    transport: "udp",
    scope: { kind: "session" },
    severity: "critical",
    message: "The capture socket reported three dropped datagrams.",
    kernelDroppedDatagrams: 3,
    counterSource: "linux-proc-net-udp-socket",
  }];
  document.captureIntegrity.status = "incomplete";
  document.captureIntegrity.issueCodes = ["udp-kernel-drops-observed"];
  return parseSession(document);
}

function makeJournalCounterMismatchUdpSession() {
  const document = structuredClone(makeUdpSession().document) as SessionDocumentV2;
  if (!document.transportProvenance || document.transportProvenance.transport !== "udp" || !document.transportProvenance.journal) {
    throw new Error("Expected UDP journal.");
  }
  const journal = document.transportProvenance.journal;
  const terminal = journal.entries.at(-1);
  if (!terminal || terminal.type !== "capture-stopped") throw new Error("Expected terminal journal entry.");
  journal.datagrams += 1;
  journal.bytes += 1;
  journal.entries = [
    ...journal.entries.slice(0, -1),
    { ...terminal, datagrams: journal.datagrams, bytes: journal.bytes },
  ];
  document.transportProvenance.status = "incomplete";
  document.transportProvenance.issueCodes = [
    "udp-bridge-journal-counter-mismatch",
    "udp-kernel-drop-counter-unavailable",
  ];
  document.captureIntegrity.status = "incomplete";
  document.captureIntegrity.issueCodes = ["transport-provenance-incomplete"];
  return parseSession(document);
}

function makePartialJournalWithoutTerminalCountersUdpSession() {
  const document = structuredClone(makeIncompleteUdpSession().document) as SessionDocumentV2;
  const original = makeUdpSession().document as SessionDocumentV2;
  if (
    !document.transportProvenance
    || document.transportProvenance.transport !== "udp"
    || !original.transportProvenance
    || original.transportProvenance.transport !== "udp"
    || !original.transportProvenance.journal
  ) {
    throw new Error("Expected UDP provenance.");
  }
  const journal = structuredClone(original.transportProvenance.journal);
  journal.endedAt = null;
  journal.state = "incomplete";
  journal.entriesComplete = false;
  journal.omittedEntries = 1;
  journal.entries = journal.entries.slice(0, 1);
  document.transportProvenance.journal = journal;
  document.transportProvenance.issueCodes = [
    "udp-bridge-journal-incomplete",
    "udp-bridge-journal-counter-mismatch",
    "udp-kernel-drop-counter-unavailable",
  ];
  return parseSession(document);
}

function makeLegacySession() {
  const records = [record("file-0", 0, 100, "file"), record("file-1", 1, 200, "file")];
  const document: SessionDocumentV1 = {
    format: "narrowslink/session",
    formatVersion: 1,
    id: "receiver-legacy",
    title: "Receiver legacy evidence",
    startedAt: "2026-07-18T17:59:00.000Z",
    displayTimeZone: "America/Los_Angeles",
    durationUs: 300,
    source: { id: "file-source", kind: "file", label: "Legacy file" },
    decoder: { ...SUPPORTED_DECODER },
    records,
    incidents: [],
  };
  return parseSession(document);
}

async function bundleFor(session = makeUdpSession(), minimal = false): Promise<Uint8Array> {
  return buildEvidenceBundle({
    session,
    range: { id: "receiver-range", title: "Receiver range", severity: "warning", startUs: 0, endUs: 300 },
    include: minimal
      ? { rawRecords: false, decodedPackets: false, diagnostics: false, markers: false, notes: false, schema: false }
      : undefined,
    generatedAt,
  });
}

function rewriteBundle(
  bytes: Uint8Array,
  mutate: (entries: Record<string, Uint8Array>, manifest: EvidenceBundleManifest) => void,
): Uint8Array {
  const entries: Record<string, Uint8Array> = { ...unzipSync(bytes) };
  const manifest = JSON.parse(strFromU8(entries["manifest.json"] ?? new Uint8Array())) as EvidenceBundleManifest;
  mutate(entries, manifest);
  for (const artifact of manifest.artifacts) {
    const artifactBytes = entries[artifact.path];
    if (!artifactBytes) continue;
    artifact.bytes = artifactBytes.byteLength;
    artifact.sha256 = hash(artifactBytes);
  }
  const manifestBytes = canonicalJson(manifest);
  entries["manifest.json"] = manifestBytes;
  entries.SHA256SUMS = new TextEncoder().encode(
    `${manifest.checksums.covers.map((path) => `${hash(entries[path] ?? new Uint8Array())}  ${path}`).join("\n")}\n`,
  );
  return zipSync(entries as Zippable, { level: 6, mtime: new Date(1980, 0, 1) });
}

function expectVerificationCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected evidence verification to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(EvidenceVerificationError);
    expect((error as EvidenceVerificationError).code).toBe(code);
  }
}

describe("production evidence receiver verifier", () => {
  it("verifies full and minimal v4 bundles while keeping evidence and authenticity separate", async () => {
    const full = verifyEvidenceBundleBytes(await bundleFor());
    expect(full.report).toMatchObject({
      integrity: "internally-consistent",
      evidence: "verified",
      captureEvidence: "verified",
      provenanceEvidence: "verified",
      authenticity: "not-established",
    });
    expect(full.manifest.session.durationUs).toBe(300);
    expect(full.rawRecords).toHaveLength(2);

    const minimal = verifyEvidenceBundleBytes(await bundleFor(makeUdpSession(), true));
    expect(minimal.paths).toEqual([
      "manifest.json",
      "SHA256SUMS",
      "transport/events.json",
      "transport/integrity-receipt.json",
      "transport/journal.json",
      "transport/provenance.json",
    ]);
    expect(minimal.rawRecords).toEqual([]);
    expect(minimal.report.integrity).toBe("internally-consistent");
    expect(minimal.report.warnings).toContain("Raw source records were excluded from this bundle.");
  });

  it("retains read compatibility for a canonical version 3 bundle", async () => {
    const legacy = rewriteBundle(await bundleFor(), (_entries, manifest) => {
      (manifest as { formatVersion: 3 | 4 }).formatVersion = 3;
    });
    const verified = verifyEvidenceBundleBytes(legacy);
    expect(verified.manifest.formatVersion).toBe(3);
    expect(verified.report.integrity).toBe("internally-consistent");
  });

  it("verifies measured kernel drops and rejects recomputed byte-accounting tampering", async () => {
    const source = await bundleFor(makeMeasuredDropUdpSession());
    const verified = verifyEvidenceBundleBytes(source);
    expect(verified.report).toMatchObject({
      integrity: "internally-consistent",
      captureEvidence: "incomplete",
      provenanceEvidence: "verified",
    });
    expect(verified.transportEvents).toContainEqual(expect.objectContaining({
      type: "udp-kernel-drops-observed",
      kernelDroppedDatagrams: 3,
    }));

    const tampered = rewriteBundle(source, (entries) => {
      const provenance = JSON.parse(strFromU8(entries["transport/provenance.json"] ?? new Uint8Array())) as {
        provenance: { byteAccounting: { ip: { bytes: number } } };
      };
      provenance.provenance.byteAccounting.ip.bytes += 1;
      entries["transport/provenance.json"] = canonicalJson(provenance);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(tampered), "SEMANTIC_MISMATCH");
  });

  it("replays NMEA evidence through the exact embedded decoder pack", async () => {
    const session = makeNmeaFileSession();
    const verified = verifyEvidenceBundleBytes(await buildEvidenceBundle({
      session,
      range: { startUs: 0, endUs: session.document.durationUs },
      generatedAt,
    }));

    expect(verified.manifest.session).toMatchObject({
      decoderId: "NMEA-0183",
      decoderRevision: "reference-v1",
      packHash: NMEA0183_DECODER_PACK.integrity.canonicalSha256,
      runtimeId: "nmea0183-line-v1",
      runtimeRevision: "1",
    });
    expect(verified.decodedRecordCount).toBe(
      NMEA0183_DECODER_PACK.fixtures.reduce((total, fixture) => total + fixture.records.length, 0),
    );
    expect(verified.report.warnings).not.toContain(
      "Decoded packet rows could not be replay-checked because this receiver does not implement the declared decoder.",
    );
  });

  it("returns success for an internally consistent bundle that truthfully discloses incomplete evidence", async () => {
    const verified = verifyEvidenceBundleBytes(await bundleFor(makeIncompleteUdpSession()));
    expect(verified.report).toMatchObject({
      integrity: "internally-consistent",
      evidence: "incomplete",
      captureEvidence: "incomplete",
      provenanceEvidence: "incomplete",
      authenticity: "not-established",
    });
  });

  it("accepts disclosed UDP journal disagreements and partial journals without terminal counters", async () => {
    const counterMismatch = verifyEvidenceBundleBytes(await bundleFor(makeJournalCounterMismatchUdpSession()));
    expect(counterMismatch.report).toMatchObject({ evidence: "incomplete", provenanceEvidence: "incomplete" });
    expect(counterMismatch.transportProvenance).toMatchObject({
      availability: "available",
      provenance: { issueCodes: expect.arrayContaining(["udp-bridge-journal-counter-mismatch"]) },
    });

    const partial = verifyEvidenceBundleBytes(await bundleFor(makePartialJournalWithoutTerminalCountersUdpSession()));
    expect(partial.report).toMatchObject({ evidence: "incomplete", captureEvidence: "incomplete", provenanceEvidence: "incomplete" });
    expect(partial.integrityReceipt.input).toMatchObject({ transportReportedUnits: null, transportReportedBytes: null });
    expect(partial.transportJournal).toMatchObject({
      availability: "available",
      journal: { state: "incomplete", entriesComplete: false, omittedEntries: 1 },
    });
  });

  it("accepts serial, legacy-v1, and pre-provenance-v2 compatibility states honestly", async () => {
    const serial = verifyEvidenceBundleBytes(await bundleFor(makeSerialSession()));
    expect(serial.report).toMatchObject({ evidence: "verified", provenanceEvidence: "verified" });
    expect(serial.transportJournal).toMatchObject({ availability: "unavailable", reason: "not-applicable" });

    const legacy = verifyEvidenceBundleBytes(await bundleFor(makeLegacySession()));
    expect(legacy.report).toMatchObject({ evidence: "unknown", captureEvidence: "unknown", provenanceEvidence: "unknown" });
    expect(legacy.transportProvenance).toMatchObject({ availability: "unavailable", reason: "legacy-v1" });

    const preProvenance = verifyEvidenceBundleBytes(await bundleFor(makeSerialSession(false)));
    expect(preProvenance.report).toMatchObject({ evidence: "unknown", captureEvidence: "verified", provenanceEvidence: "unknown" });
    expect(preProvenance.transportProvenance).toMatchObject({ availability: "unavailable", reason: "pre-provenance-v2" });
  });

  it("normalizes a valid mixed-case decoder digest into the lowercase evidence wire contract", async () => {
    const source = structuredClone(makeSerialSession().document) as SessionDocumentV2;
    source.decoder.schemaHash = source.decoder.schemaHash.toUpperCase();
    const verified = verifyEvidenceBundleBytes(await bundleFor(parseSession(source)));
    expect(verified.manifest.session.schemaHash).toBe(SUPPORTED_DECODER.schemaHash);
    expect(verified.report.integrity).toBe("internally-consistent");
  });

  it("keeps spreadsheet neutralization injective for formula-like and apostrophe-leading record IDs", async () => {
    const source = structuredClone(makeSerialSession().document) as SessionDocumentV2;
    const first = source.records[0];
    const second = source.records[1];
    if (!first || !second) throw new Error("Expected two receiver records.");
    first.id = "=formula-like";
    second.id = "'=operator-apostrophe";
    const verified = verifyEvidenceBundleBytes(await bundleFor(parseSession(source)));
    expect(verified.rawRecords.map((item) => item.id)).toEqual(["=formula-like", "'=operator-apostrophe"]);
    expect(verified.decodedRecordCount).toBe(2);
  });

  it("rejects an inclusion/path mismatch even after checksums are recomputed", async () => {
    const rewritten = rewriteBundle(await bundleFor(), (_entries, manifest) => {
      manifest.inclusions.rawRecords = false;
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(rewritten), "ARTIFACT_CONTRACT_MISMATCH");
  });

  it("rejects receipt/provenance semantic tampering even after all hashes are recomputed", async () => {
    const rewritten = rewriteBundle(await bundleFor(), (entries, manifest) => {
      const receipt = structuredClone(manifest.session.captureIntegrity);
      receipt.retained.records += 1;
      manifest.session.captureIntegrity = receipt;
      entries["transport/integrity-receipt.json"] = canonicalJson(receipt);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(rewritten), "SEMANTIC_MISMATCH");
  });

  it("rejects selected endpoint counts that exceed whole-session provenance totals", async () => {
    const source = await buildEvidenceBundle({
      session: makeUdpSession(),
      range: { startUs: 0, endUs: 150 },
      generatedAt,
    });
    const rewritten = rewriteBundle(source, (entries, manifest) => {
      const provenanceDocument = JSON.parse(strFromU8(entries["transport/provenance.json"] ?? new Uint8Array())) as {
        provenance: {
          status: string;
          issueCodes: string[];
          endpointAttribution: { totalRecords: number; attributedRecords: number; unattributedRecords: number };
        };
      };
      provenanceDocument.provenance.status = "incomplete";
      provenanceDocument.provenance.issueCodes = [
        "udp-endpoint-attribution-incomplete",
        "udp-kernel-drop-counter-unavailable",
      ];
      provenanceDocument.provenance.endpointAttribution.attributedRecords = 0;
      provenanceDocument.provenance.endpointAttribution.unattributedRecords = 2;
      entries["transport/provenance.json"] = canonicalJson(provenanceDocument);

      manifest.provenance.status = "incomplete";
      manifest.provenance.issueCodes = [...provenanceDocument.provenance.issueCodes] as typeof manifest.provenance.issueCodes;
      if (!manifest.provenance.endpointAttribution) throw new Error("Expected endpoint attribution summary.");
      manifest.provenance.endpointAttribution.attributedRecords = 0;
      manifest.provenance.endpointAttribution.unattributedRecords = 2;

      const receipt = structuredClone(manifest.session.captureIntegrity);
      receipt.status = "incomplete";
      receipt.issueCodes = ["transport-provenance-incomplete"];
      manifest.session.captureIntegrity = receipt;
      entries["transport/integrity-receipt.json"] = canonicalJson(receipt);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(rewritten), "SEMANTIC_MISMATCH");
  });

  it("rejects a cross-transport receipt after all hashes are recomputed", async () => {
    const rewritten = rewriteBundle(await bundleFor(makeSerialSession()), (entries, manifest) => {
      const receipt = structuredClone(manifest.session.captureIntegrity);
      receipt.assessmentBasis = "udp-bridge-reconciled";
      receipt.input.unit = "datagram";
      receipt.input.transportReportedUnits = receipt.input.observedUnits;
      receipt.input.transportReportedBytes = receipt.input.observedBytes;
      manifest.session.captureIntegrity = receipt;
      entries["transport/integrity-receipt.json"] = canonicalJson(receipt);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(rewritten), "SEMANTIC_MISMATCH");
  });

  it("rejects cross-transport issue codes and inconsistent stop offsets", async () => {
    const wrongIssue = rewriteBundle(await bundleFor(makeIncompleteUdpSession()), (entries, manifest) => {
      const receipt = structuredClone(manifest.session.captureIntegrity);
      receipt.eventLogComplete = false;
      receipt.issueCodes.push("event-log-incomplete", "serial-read-error");
      manifest.session.captureIntegrity = receipt;
      entries["transport/integrity-receipt.json"] = canonicalJson(receipt);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(wrongIssue), "SEMANTIC_MISMATCH");

    const missingStopOffset = rewriteBundle(await bundleFor(), (entries, manifest) => {
      const receipt = structuredClone(manifest.session.captureIntegrity);
      receipt.stopOffsetUs = null;
      manifest.session.captureIntegrity = receipt;
      entries["transport/integrity-receipt.json"] = canonicalJson(receipt);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(missingStopOffset), "SEMANTIC_MISMATCH");
  });

  it("rejects duplicate terminal events and inconsistent duration-limit evidence", async () => {
    const duplicateShutdown = rewriteBundle(await bundleFor(makeIncompleteUdpSession()), (entries, manifest) => {
      const events = JSON.parse(strFromU8(entries["transport/events.json"] ?? new Uint8Array())) as {
        events: Array<Record<string, unknown>>;
      };
      events.events.push({ ...events.events[0], id: "receiver-shutdown-unconfirmed-duplicate", index: 1 });
      entries["transport/events.json"] = canonicalJson(events);
      const eventArtifact = manifest.artifacts.find((artifact) => artifact.path === "transport/events.json");
      if (eventArtifact) eventArtifact.recordCount = events.events.length;
      const receipt = structuredClone(manifest.session.captureIntegrity);
      receipt.eventLogComplete = false;
      receipt.issueCodes.push("event-log-incomplete");
      manifest.session.captureIntegrity = receipt;
      entries["transport/integrity-receipt.json"] = canonicalJson(receipt);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(duplicateShutdown), "SEMANTIC_MISMATCH");

    const missingDurationCode = rewriteBundle(await bundleFor(), (entries, manifest) => {
      const events = JSON.parse(strFromU8(entries["transport/events.json"] ?? new Uint8Array())) as {
        events: Array<Record<string, unknown>>;
      };
      events.events.push({
        id: "receiver-duration-limit",
        index: 0,
        type: "capture-limit",
        transport: "udp",
        scope: { kind: "point", offsetUs: 299 },
        severity: "critical",
        message: "Capture duration reached.",
        component: "recorder",
        limit: "duration",
        limitValue: 300,
        observedValue: 301,
      });
      entries["transport/events.json"] = canonicalJson(events);
      const eventArtifact = manifest.artifacts.find((artifact) => artifact.path === "transport/events.json");
      if (eventArtifact) eventArtifact.recordCount = events.events.length;
      const receipt = structuredClone(manifest.session.captureIntegrity);
      receipt.status = "incomplete";
      receipt.issueCodes = ["capture-limit"];
      manifest.session.captureIntegrity = receipt;
      entries["transport/integrity-receipt.json"] = canonicalJson(receipt);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(missingDurationCode), "SEMANTIC_MISMATCH");

    const duplicateDuration = rewriteBundle(await bundleFor(), (entries, manifest) => {
      const events = JSON.parse(strFromU8(entries["transport/events.json"] ?? new Uint8Array())) as {
        events: Array<Record<string, unknown>>;
      };
      const durationEvent = {
        id: "receiver-duration-limit-1",
        index: 0,
        type: "capture-limit",
        transport: "udp",
        scope: { kind: "point", offsetUs: 298 },
        severity: "critical",
        message: "Capture duration reached.",
        component: "recorder",
        limit: "duration",
        limitValue: 300,
        observedValue: 301,
      };
      events.events.push(durationEvent, { ...durationEvent, id: "receiver-duration-limit-2", index: 1, scope: { kind: "point", offsetUs: 299 } });
      entries["transport/events.json"] = canonicalJson(events);
      const eventArtifact = manifest.artifacts.find((artifact) => artifact.path === "transport/events.json");
      if (eventArtifact) eventArtifact.recordCount = events.events.length;
      const receipt = structuredClone(manifest.session.captureIntegrity);
      receipt.status = "incomplete";
      receipt.eventLogComplete = false;
      receipt.issueCodes = ["capture-limit", "duration-capped", "event-log-incomplete"];
      manifest.session.captureIntegrity = receipt;
      entries["transport/integrity-receipt.json"] = canonicalJson(receipt);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(duplicateDuration), "SEMANTIC_MISMATCH");
  });

  it("rejects an impossible clean journal lifecycle after all hashes are recomputed", async () => {
    const rewritten = rewriteBundle(await bundleFor(), (entries, manifest) => {
      const provenance = JSON.parse(strFromU8(entries["transport/provenance.json"] ?? new Uint8Array())) as {
        provenance: { journal: { endedAt: string | null; entries: unknown[] } };
      };
      provenance.provenance.journal.endedAt = null;
      provenance.provenance.journal.entries = provenance.provenance.journal.entries.slice(0, 1);
      const journal = JSON.parse(strFromU8(entries["transport/journal.json"] ?? new Uint8Array())) as {
        journal: { endedAt: string | null; entries: unknown[] };
      };
      journal.journal.endedAt = null;
      journal.journal.entries = journal.journal.entries.slice(0, 1);
      entries["transport/provenance.json"] = canonicalJson(provenance);
      entries["transport/journal.json"] = canonicalJson(journal);
      manifest.provenance.journal.entryCount = 1;
      const journalArtifact = manifest.artifacts.find((artifact) => artifact.path === "transport/journal.json");
      if (journalArtifact) journalArtifact.recordCount = 1;
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(rewritten), "SEMANTIC_MISMATCH");
  });

  it("rejects a substituted decoder schema even after archive hashes are recomputed", async () => {
    const rewritten = rewriteBundle(await bundleFor(), (entries) => {
      const schema = JSON.parse(strFromU8(entries["schema/schema.json"] ?? new Uint8Array())) as {
        decoder: Record<string, unknown>;
      };
      schema.decoder.checksum = "attacker-defined";
      entries["schema/schema.json"] = canonicalJson(schema);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(rewritten), "SEMANTIC_MISMATCH");
  });

  it("rejects decoded status contradictions when raw records are excluded", async () => {
    const source = await buildEvidenceBundle({
      session: makeUdpSession(),
      range: { startUs: 0, endUs: 300 },
      include: { rawRecords: false },
      generatedAt,
    });
    const rewritten = rewriteBundle(source, (entries) => {
      const csv = strFromU8(entries["decoded/packets.csv"] ?? new Uint8Array()).replace(",valid,", ",crc-failed,");
      entries["decoded/packets.csv"] = new TextEncoder().encode(csv);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(rewritten), "SEMANTIC_MISMATCH");
  });

  it("binds selections and whole-session evidence offsets to the declared session duration", async () => {
    const selectionBeyondDuration = rewriteBundle(await bundleFor(), (_entries, manifest) => {
      manifest.session.durationUs = 299;
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(selectionBeyondDuration), "SEMANTIC_MISMATCH");

    const receiptBeyondDuration = rewriteBundle(await bundleFor(), (entries, manifest) => {
      const receipt = structuredClone(manifest.session.captureIntegrity);
      receipt.stopOffsetUs = manifest.session.durationUs + 1;
      manifest.session.captureIntegrity = receipt;
      entries["transport/integrity-receipt.json"] = canonicalJson(receipt);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(receiptBeyondDuration), "SEMANTIC_MISMATCH");

    const diagnosticBeyondDuration = rewriteBundle(await bundleFor(makeIncompleteUdpSession()), (entries, manifest) => {
      const document = JSON.parse(strFromU8(entries["diagnostics/diagnostics.json"] ?? new Uint8Array())) as {
        diagnostics: Array<{ endUs?: number }>;
      };
      const diagnostic = document.diagnostics[0];
      if (!diagnostic) throw new Error("Expected a capture-path diagnostic.");
      diagnostic.endUs = manifest.session.durationUs + 1;
      entries["diagnostics/diagnostics.json"] = canonicalJson(document);
      entries["diagnostics/diagnostics.csv"] = new TextEncoder().encode(
        strFromU8(entries["diagnostics/diagnostics.csv"] ?? new Uint8Array()).replace(
          `,0,${manifest.session.durationUs},`,
          `,0,${manifest.session.durationUs + 1},`,
        ),
      );
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(diagnosticBeyondDuration), "SEMANTIC_MISMATCH");

    const eventSession = structuredClone(makeUdpSession().document) as SessionDocumentV2;
    eventSession.transportEvents = [{
      id: "receiver-interval-limit",
      index: 0,
      type: "capture-limit",
      transport: "udp",
      scope: { kind: "interval", startUs: 299, endUs: 300 },
      severity: "critical",
      message: "The recorder reached its record limit.",
      component: "recorder",
      limit: "records",
      limitValue: 2,
      observedValue: 3,
    }];
    eventSession.captureIntegrity.status = "incomplete";
    eventSession.captureIntegrity.issueCodes = ["capture-limit"];
    const eventBeyondDuration = rewriteBundle(await bundleFor(parseSession(eventSession)), (entries, manifest) => {
      const document = JSON.parse(strFromU8(entries["transport/events.json"] ?? new Uint8Array())) as {
        events: Array<{ scope: { kind: string; endUs?: number } }>;
      };
      const event = document.events[0];
      if (!event || event.scope.kind !== "interval") throw new Error("Expected an interval event.");
      event.scope.endUs = manifest.session.durationUs + 1;
      entries["transport/events.json"] = canonicalJson(document);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(eventBeyondDuration), "SEMANTIC_MISMATCH");

    const journalBeyondDuration = rewriteBundle(
      await bundleFor(makePartialJournalWithoutTerminalCountersUdpSession()),
      (entries, manifest) => {
        const provenanceDocument = JSON.parse(strFromU8(entries["transport/provenance.json"] ?? new Uint8Array())) as {
          provenance: { journal: { datagrams: number; bytes: number; entries: Array<Record<string, unknown>> } };
        };
        const journalDocument = JSON.parse(strFromU8(entries["transport/journal.json"] ?? new Uint8Array())) as {
          journal: { datagrams: number; bytes: number; entries: Array<Record<string, unknown>> };
        };
        const terminal = {
          sequence: 2,
          type: "bridge-error",
          at: "2026-07-18T17:59:00.000301Z",
          offsetUs: manifest.session.durationUs + 1,
          datagrams: journalDocument.journal.datagrams,
          bytes: journalDocument.journal.bytes,
          code: "late-journal-entry",
          message: "This journal entry exceeds the declared session duration.",
          fatal: false,
        };
        provenanceDocument.provenance.journal.entries.push(terminal);
        journalDocument.journal.entries.push(terminal);
        entries["transport/provenance.json"] = canonicalJson(provenanceDocument);
        entries["transport/journal.json"] = canonicalJson(journalDocument);
        manifest.provenance.journal.entryCount = journalDocument.journal.entries.length;
        const journalArtifact = manifest.artifacts.find((artifact) => artifact.path === "transport/journal.json");
        if (journalArtifact) journalArtifact.recordCount = journalDocument.journal.entries.length;
      },
    );
    expectVerificationCode(() => verifyEvidenceBundleBytes(journalBeyondDuration), "SEMANTIC_MISMATCH");
  });

  it("rejects non-canonical diagnostic CSV integer spellings", async () => {
    const rewritten = rewriteBundle(await bundleFor(makeIncompleteUdpSession()), (entries) => {
      const csv = strFromU8(entries["diagnostics/diagnostics.csv"] ?? new Uint8Array()).replace(",0,300,", ",0e0,300,");
      entries["diagnostics/diagnostics.csv"] = new TextEncoder().encode(csv);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(rewritten), "CONTENT_INVALID");
  });

  it("requires unique, bounded source record IDs even when decoded rows have no raw artifact", async () => {
    const source = await buildEvidenceBundle({
      session: makeUdpSession(),
      range: { startUs: 0, endUs: 300 },
      include: { rawRecords: false },
      generatedAt,
    });
    const replaceSourceRecordId = (line: string, value: string): string => {
      const commas: number[] = [];
      for (let index = 0; index < line.length && commas.length < 4; index += 1) {
        if (line[index] === ",") commas.push(index);
      }
      const start = (commas[2] ?? -1) + 1;
      const end = commas[3] ?? start;
      return `${line.slice(0, start)}${value}${line.slice(end)}`;
    };

    const blank = rewriteBundle(source, (entries) => {
      const lines = strFromU8(entries["decoded/packets.csv"] ?? new Uint8Array()).trimEnd().split("\n");
      lines[1] = replaceSourceRecordId(lines[1] ?? "", "");
      entries["decoded/packets.csv"] = new TextEncoder().encode(`${lines.join("\n")}\n`);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(blank), "SEMANTIC_MISMATCH");

    const duplicate = rewriteBundle(source, (entries) => {
      const lines = strFromU8(entries["decoded/packets.csv"] ?? new Uint8Array()).trimEnd().split("\n");
      lines[1] = replaceSourceRecordId(lines[1] ?? "", "duplicate-source");
      lines[2] = replaceSourceRecordId(lines[2] ?? "", "duplicate-source");
      entries["decoded/packets.csv"] = new TextEncoder().encode(`${lines.join("\n")}\n`);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(duplicate), "SEMANTIC_MISMATCH");

    const unjustifiedExpansion = rewriteBundle(source, (entries) => {
      const lines = strFromU8(entries["decoded/packets.csv"] ?? new Uint8Array()).trimEnd().split("\n");
      lines[1] = replaceSourceRecordId(lines[1] ?? "", `'${"x".repeat(128)}`);
      entries["decoded/packets.csv"] = new TextEncoder().encode(`${lines.join("\n")}\n`);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(unjustifiedExpansion), "SEMANTIC_MISMATCH");
  });

  it("accepts producer-derived IDs at the session contract maxima", async () => {
    const longRecordDocument = structuredClone(makeUdpSession().document) as SessionDocumentV2;
    const longRecord = longRecordDocument.records[0];
    if (!longRecord) throw new Error("Expected a source record.");
    longRecord.id = "r".repeat(128);
    const checksumByte = longRecord.dataHex.slice(-2).toLowerCase();
    longRecord.dataHex = `${longRecord.dataHex.slice(0, -2)}${checksumByte === "ff" ? "00" : "ff"}`;
    const longRecordBundle = verifyEvidenceBundleBytes(await bundleFor(parseSession(longRecordDocument)));
    expect(longRecordBundle.decodedRecordCount).toBe(2);
    expect(longRecordBundle.diagnostics.some((diagnostic) => String(diagnostic.id).length > 128)).toBe(true);

    const longEventDocument = structuredClone(makeIncompleteUdpSession().document) as SessionDocumentV2;
    const longEvent = longEventDocument.transportEvents[0];
    if (!longEvent) throw new Error("Expected a transport event.");
    longEvent.id = "e".repeat(128);
    const longEventBundle = verifyEvidenceBundleBytes(await bundleFor(parseSession(longEventDocument)));
    expect(longEventBundle.diagnostics).toContainEqual(expect.objectContaining({ id: `transport-${"e".repeat(128)}` }));
  });

  it("enforces the quoted CSV cell limit before semantic parsing", async () => {
    const source = await buildEvidenceBundle({
      session: makeUdpSession(),
      range: { startUs: 0, endUs: 300 },
      include: { rawRecords: false },
      generatedAt,
    });
    const rewritten = rewriteBundle(source, (entries) => {
      const lines = strFromU8(entries["decoded/packets.csv"] ?? new Uint8Array()).trimEnd().split("\n");
      const firstRow = lines[1] ?? "";
      const lastCellStart = firstRow.lastIndexOf(',"[');
      lines[1] = `${firstRow.slice(0, lastCellStart + 1)}"${"x".repeat(1_000_001)}"`;
      entries["decoded/packets.csv"] = new TextEncoder().encode(`${lines.join("\n")}\n`);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(rewritten), "ARCHIVE_LIMIT_EXCEEDED");
  });

  it("applies the v1 source-record schema to legacy raw evidence", async () => {
    const rewritten = rewriteBundle(await bundleFor(makeLegacySession()), (entries) => {
      const lines = strFromU8(entries["raw/source-records.ndjson"] ?? new Uint8Array()).trimEnd().split("\n");
      const first = JSON.parse(lines[0] ?? "{}") as SourceRecord;
      first.transport.kernelDropCounter = null;
      lines[0] = JSON.stringify(canonicalize(first));
      entries["raw/source-records.ndjson"] = new TextEncoder().encode(`${lines.join("\n")}\n`);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(rewritten), "CONTENT_INVALID");
  });

  it("offers deterministic human and JSON CLI receiver output and exit codes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replaycase-verifier-"));
    const bundlePath = join(directory, "receiver.nlb");
    try {
      await writeFile(bundlePath, await bundleFor());
      const human = { stdout: "", stderr: "" };
      const humanCode = await runCli(["verify", bundlePath], {
        stdout: (text) => { human.stdout += text; },
        stderr: (text) => { human.stderr += text; },
      });
      expect(humanCode).toBe(0);
      expect(human.stdout).toContain("ReplayCase evidence verification: PASS");
      expect(human.stdout).toContain("Authenticity: not-established");
      expect(human.stderr).toBe("");

      const json = { stdout: "", stderr: "" };
      const jsonCode = await runCli(["verify", bundlePath, "--json"], {
        stdout: (text) => { json.stdout += text; },
        stderr: (text) => { json.stderr += text; },
      });
      expect(jsonCode).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({ integrity: "internally-consistent", authenticity: "not-established" });

      const controlDocument = structuredClone(makeUdpSession().document) as SessionDocumentV2;
      controlDocument.title = "Receiver \u0085\u009b control safety";
      const controlPath = join(directory, "receiver-controls.nlb");
      await writeFile(controlPath, await bundleFor(parseSession(controlDocument)));
      const controlJson = { stdout: "", stderr: "" };
      expect(await runCli(["verify", controlPath, "--json"], {
        stdout: (text) => { controlJson.stdout += text; },
        stderr: (text) => { controlJson.stderr += text; },
      })).toBe(0);
      expect(controlJson.stdout).not.toContain("\u0085");
      expect(controlJson.stdout).not.toContain("\u009b");
      expect(JSON.parse(controlJson.stdout)).toMatchObject({ session: { title: controlDocument.title } });
      expect(controlJson.stderr).toBe("");

      expect(await runCli(["verify", join(directory, "missing.nlb")], { stdout: () => {}, stderr: () => {} })).toBe(2);
      expect(await runCli([], { stdout: () => {}, stderr: () => {} })).toBe(2);
      const usageJson = { stdout: "", stderr: "" };
      expect(await runCli(["--json"], {
        stdout: (text) => { usageJson.stdout += text; },
        stderr: (text) => { usageJson.stderr += text; },
      })).toBe(2);
      expect(JSON.parse(usageJson.stdout)).toMatchObject({ integrity: "failed", error: { code: "USAGE_ERROR" } });
      expect(usageJson.stderr).toBe("");

      const sourcePath = fileURLToPath(new URL("../scripts/replaycase.ts", import.meta.url));
      const symlinkPath = join(directory, "replaycase-link.ts");
      await symlink(sourcePath, symlinkPath);
      expect(isCliEntry(pathToFileURL(sourcePath).href, symlinkPath)).toBe(true);

      const spoofed = verifyEvidenceBundleBytes(await bundleFor()).report;
      spoofed.session.title = "Receiver \u202ePASS";
      expect(renderVerificationReport(spoofed)).not.toContain("\u202e");
      expect(renderVerificationReport(spoofed)).toContain("\\u202e");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects producer timestamps that cannot satisfy the receiver wire contract", async () => {
    await expect(buildEvidenceBundle({
      session: makeUdpSession(),
      range: { startUs: 0, endUs: 300 },
      generatedAt: "2026-07-18",
    })).rejects.toThrow("receiver contract");
  });

  it("rejects optional marker and note documents before the producer can emit a receiver-incompatible archive", async () => {
    await expect(buildEvidenceBundle({
      session: makeUdpSession(),
      range: { startUs: 0, endUs: 300 },
      markers: [{
        id: "invalid-marker",
        offsetUs: 100,
        title: "Invalid timestamp",
        note: "Date-only timestamps are not receiver-canonical.",
        category: "observation",
        createdAt: "2026-07-18",
      }],
      generatedAt,
    })).rejects.toThrow("markers artifact violates the current receiver contract");

    await expect(buildEvidenceBundle({
      session: makeUdpSession(),
      range: { startUs: 0, endUs: 300 },
      notes: [{ id: "invalid-note", title: "", body: "Empty present titles are not receiver-canonical." }],
      generatedAt,
    })).rejects.toThrow("notes artifact violates the current receiver contract");
  });

  it("preflights NDJSON and CSV record and column bombs before unbounded container growth", async () => {
    const source = await bundleFor();
    const ndjsonBomb = rewriteBundle(source, (entries) => {
      entries["raw/source-records.ndjson"] = new TextEncoder().encode("\n".repeat(EVIDENCE_ARCHIVE_LIMITS.ndjsonRecords + 1));
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(ndjsonBomb), "ARCHIVE_LIMIT_EXCEEDED");

    const csvRowBomb = rewriteBundle(source, (entries) => {
      entries["decoded/packets.csv"] = new TextEncoder().encode("x\n".repeat(EVIDENCE_ARCHIVE_LIMITS.csvRecords + 2));
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(csvRowBomb), "ARCHIVE_LIMIT_EXCEEDED");

    const csvColumnBomb = rewriteBundle(source, (entries) => {
      const header = strFromU8(entries["decoded/packets.csv"] ?? new Uint8Array()).split("\n")[0] ?? "";
      entries["decoded/packets.csv"] = new TextEncoder().encode(`${header}\n${",".repeat(14)}\n`);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(csvColumnBomb), "ARCHIVE_LIMIT_EXCEEDED");
  });

  it("rejects an oversized file input before reading its contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replaycase-verifier-limit-"));
    const bundlePath = join(directory, "oversized.nlb");
    try {
      await writeFile(bundlePath, new Uint8Array());
      await truncate(bundlePath, EVIDENCE_ARCHIVE_LIMITS.archiveBytes + 1);
      await expect(verifyEvidenceBundleFile(bundlePath)).rejects.toMatchObject({ code: "ARCHIVE_LIMIT_EXCEEDED" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed NDJSON, CSV, JSON, and unsupported manifest versions with stable codes", async () => {
    const source = await bundleFor();
    const malformedNdjson = rewriteBundle(source, (entries) => {
      const raw = entries["raw/source-records.ndjson"];
      if (raw) entries["raw/source-records.ndjson"] = raw.subarray(0, raw.byteLength - 1);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(malformedNdjson), "CONTENT_INVALID");

    const malformedCsv = rewriteBundle(source, (entries) => {
      const decoded = strFromU8(entries["decoded/packets.csv"] ?? new Uint8Array()).replace("frame_id", "wrong_id");
      entries["decoded/packets.csv"] = new TextEncoder().encode(decoded);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(malformedCsv), "CONTENT_INVALID");

    const noncanonicalJson = rewriteBundle(source, (entries) => {
      const receipt = strFromU8(entries["transport/integrity-receipt.json"] ?? new Uint8Array()).replace("{\n", "{ \n");
      entries["transport/integrity-receipt.json"] = new TextEncoder().encode(receipt);
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(noncanonicalJson), "CONTENT_INVALID");

    const unsupported = rewriteBundle(source, (_entries, manifest) => {
      (manifest as unknown as { formatVersion: number }).formatVersion = 5;
    });
    expectVerificationCode(() => verifyEvidenceBundleBytes(unsupported), "UNSUPPORTED_BUNDLE_VERSION");
  });
});
