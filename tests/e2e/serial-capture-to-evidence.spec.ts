import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { bytesToHex, encodeFrame } from "../../src/domain/decoder";
import { parseSession } from "../../src/domain/session";
import { verifyEvidenceBundle } from "./support/archive";
import { installMockWebSerial } from "./support/web-serial";

interface CapturedSerialRecord {
  id: string;
  offsetUs: number;
  dataHex: string;
  captureBytes: number;
  transport: { kind: "serial" };
}

interface CapturedSerialSession {
  id: string;
  title: string;
  formatVersion: 2;
  durationUs: number;
  source: { id: string; kind: "serial" };
  records: CapturedSerialRecord[];
  captureIntegrity: {
    schemaVersion: number;
    status: "verified" | "incomplete";
    assessmentBasis: string;
    stopDisposition: string;
    stopOffsetUs: number | null;
    eventLogComplete: boolean;
    input: {
      unit: string;
      observedUnits: number | null;
      observedBytes: number | null;
      transportReportedUnits: number | null;
      transportReportedBytes: number | null;
    };
    retained: { records: number; bytes: number };
    issueCodes: string[];
  };
  transportEvents: unknown[];
  transportProvenance: {
    schemaVersion: number;
    sourceId: string;
    transport: "serial";
    status: "verified" | "incomplete";
    issueCodes: string[];
    device: {
      usbVendorId: number | null;
      usbProductId: number | null;
      bluetoothServiceClassId: string | null;
    };
    settings: {
      baudRate: number;
      dataBits: number;
      stopBits: number;
      parity: string;
      bufferSize: number;
      flowControl: string;
    };
  };
}

const CAPTURE_TITLE = "Release gate serial capture";
const RANGE_TITLE = "Exact serial evidence range";

function heartbeatFrame(sequence: number): Uint8Array {
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  view.setUint32(0, sequence, true);
  payload[4] = 2;
  payload[5] = sequence & 0xff;
  view.setUint16(6, 0x0137, true);
  return encodeFrame({
    familyId: 0x02,
    sequence,
    deviceTimeMs: sequence * 20,
    payload,
  });
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function formatOffsetUsInput(offsetUs: number): string {
  const hours = Math.floor(offsetUs / 3_600_000_000);
  const minutes = Math.floor((offsetUs % 3_600_000_000) / 60_000_000);
  const seconds = Math.floor((offsetUs % 60_000_000) / 1_000_000);
  const microseconds = offsetUs % 1_000_000;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${microseconds.toString().padStart(6, "0")}`;
}

test("records fragmented serial input and carries it through durable verified evidence", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const serial = await installMockWebSerial(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: /Live capture UDP or serial/ }).click();
  const captureDialog = page.getByRole("dialog", { name: "Record live telemetry" });
  await captureDialog.getByRole("tab", { name: "Serial port" }).click();
  await captureDialog.getByLabel("Session title", { exact: true }).fill(CAPTURE_TITLE);
  await captureDialog.getByLabel(/Display timezone/).fill("UTC");
  await captureDialog.getByRole("button", { name: "Select port & preflight" }).click();
  await expect(captureDialog.getByRole("region", { name: "Preflight waiting for traffic" })).toBeVisible();
  await expect(captureDialog.getByText(/Serial state:/)).toContainText("open");

  const frames = [501, 502, 503, 504, 505].map(heartbeatFrame);
  await serial.emit(heartbeatFrame(500));
  await expect(captureDialog.getByRole("region", { name: "Preflight ready" })).toBeVisible();
  await captureDialog.getByRole("button", { name: "Start recording" }).click();
  await expect(captureDialog.getByRole("region", { name: "Recording" })).toBeVisible();
  const reads = [
    frames[0]!.slice(0, 5),
    concat(frames[0]!.slice(5), frames[1]!),
    frames[2]!.slice(0, 11),
    concat(frames[2]!.slice(11), frames[3]!, frames[4]!.slice(0, 9)),
  ];
  for (const bytes of reads) {
    await serial.emit(bytes);
    await page.waitForTimeout(250);
  }
  const observedBytes = reads.reduce((total, bytes) => total + bytes.byteLength, 0);
  await expect(captureDialog.getByText("Serial reads received", { exact: true }).locator("..")).toContainText("4");
  await expect(captureDialog.getByText("Input bytes", { exact: true }).locator("..")).toContainText(`${observedBytes} B`);
  await expect(captureDialog.getByText("Records retained", { exact: true }).locator("..")).toContainText("4");

  expect(await serial.snapshot()).toMatchObject({
    requestedPorts: 1,
    openedWith: [{
      baudRate: 115_200,
      bufferSize: 65_536,
      dataBits: 8,
      flowControl: "none",
      parity: "none",
      stopBits: 1,
    }],
    emittedReads: 5,
    emittedBytes: observedBytes + heartbeatFrame(500).byteLength,
    readerCancellations: 0,
    portCloses: 0,
  });

  const sessionDownloadPromise = page.waitForEvent("download");
  await captureDialog.getByRole("button", { name: "Stop, save & replay" }).click();
  const sessionDownload = await sessionDownloadPromise;
  expect(sessionDownload.suggestedFilename()).toMatch(/^replaycase-release-gate-serial-capture-.*\.nlsession$/);
  const sessionPath = testInfo.outputPath("captured-serial-session.nlsession");
  await sessionDownload.saveAs(sessionPath);

  const captureHeading = page.getByRole("heading", { name: CAPTURE_TITLE, level: 1 });
  await expect(captureHeading).toBeVisible();
  await expect.poll(async () => serial.snapshot()).toMatchObject({ readerCancellations: 1, portCloses: 1 });

  const document = JSON.parse(await readFile(sessionPath, "utf8")) as CapturedSerialSession;
  const expectedInput = concat(...reads);
  expect(document).toMatchObject({ title: CAPTURE_TITLE, formatVersion: 2, source: { kind: "serial" } });
  expect(document.records).toHaveLength(5);
  expect(document.records.map((record) => record.transport.kind)).toEqual(["serial", "serial", "serial", "serial", "serial"]);
  expect(document.records.map((record) => record.captureBytes)).toEqual([
    frames[0]!.byteLength,
    frames[1]!.byteLength,
    frames[2]!.byteLength,
    frames[3]!.byteLength,
    9,
  ]);
  expect(document.records.map((record) => record.dataHex).join("")).toBe(bytesToHex(expectedInput));
  const parsedSession = parseSession(document);
  expect(parsedSession.frames.map((frame) => frame.status)).toEqual([
    "complete",
    "complete",
    "complete",
    "complete",
    "partial",
  ]);
  expect(parsedSession.diagnostics.filter((diagnostic) => diagnostic.type === "partial-frame")).toHaveLength(1);
  expect(document.captureIntegrity).toMatchObject({
    status: "verified",
    assessmentBasis: "web-serial-observed",
    stopDisposition: "confirmed",
    eventLogComplete: true,
    input: {
      unit: "serial-read",
      observedUnits: 4,
      observedBytes,
      transportReportedUnits: null,
      transportReportedBytes: null,
    },
    retained: { records: 5, bytes: observedBytes },
    issueCodes: [],
  });
  expect(document.transportEvents).toEqual([]);
  expect(document.transportProvenance).toEqual({
    schemaVersion: 1,
    sourceId: document.source.id,
    transport: "serial",
    status: "verified",
    issueCodes: [],
    device: {
      usbVendorId: 0x1209,
      usbProductId: 0x0001,
      bluetoothServiceClassId: null,
    },
    settings: {
      baudRate: 115_200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      bufferSize: 65_536,
      flowControl: "none",
    },
  });

  const savedSessionButton = page.getByRole("button", {
    name: new RegExp(`^(?:Reopen current|Open) saved session ${CAPTURE_TITLE},`),
  });
  await expect(savedSessionButton).toHaveCount(1);
  await expect(savedSessionButton).toContainText("Verified");
  await page.getByLabel("Choose a local ReplayCase replay").setInputFiles(sessionPath);
  await expect(page.getByText(
    "captured-serial-session.nlsession saved to the local session library",
    { exact: true },
  )).toBeVisible();
  await expect(savedSessionButton).toHaveCount(1);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 })).toBeVisible();
  const reopenButton = page.getByRole("button", {
    name: new RegExp(`^Open saved session ${CAPTURE_TITLE},`),
  });
  await expect(reopenButton).toBeVisible();
  await reopenButton.click();
  await expect(captureHeading).toBeVisible();

  const replayPosition = page.getByRole("slider", { name: "Replay position" });
  const replaySeekOffsetUs = 1_000_000;
  expect(document.durationUs).toBeGreaterThan(replaySeekOffsetUs);
  await replayPosition.fill(String(replaySeekOffsetUs));
  await expect(replayPosition).toHaveValue(String(replaySeekOffsetUs));
  await page.getByRole("button", { name: "Play replay" }).click();
  await expect(page.getByRole("button", { name: "Replay again" })).toBeVisible();

  const startRecord = document.records[0]!;
  const endRecord = document.records[2]!;
  expect(startRecord.offsetUs).toBeLessThan(document.records[1]!.offsetUs);
  expect(document.records[1]!.offsetUs).toBeLessThan(endRecord.offsetUs);
  const expectedRangeRecords = document.records.filter(
    (record) => record.offsetUs >= startRecord.offsetUs && record.offsetUs < endRecord.offsetUs,
  );
  expect(expectedRangeRecords.map((record) => record.id)).toEqual([
    document.records[0]!.id,
    document.records[1]!.id,
  ]);

  await page.getByRole("button", { name: "New range" }).click();
  const rangeDialog = page.getByRole("dialog", { name: "Define an incident range" });
  await rangeDialog.getByLabel("Title", { exact: true }).fill(RANGE_TITLE);
  await rangeDialog.getByLabel(/^Start · included/).fill(formatOffsetUsInput(startRecord.offsetUs));
  await rangeDialog.getByLabel(/^End · excluded/).fill(formatOffsetUsInput(endRecord.offsetUs));
  await rangeDialog.getByRole("combobox", { name: "Severity" }).selectOption("critical");
  await rangeDialog.getByRole("button", { name: "Create range" }).click();
  await expect(page.getByRole("heading", { name: RANGE_TITLE, level: 2 })).toBeVisible();

  await page.getByRole("tab", { name: /^provenance$/i }).click();
  const provenancePanel = page.getByRole("tabpanel", { name: /^provenance$/i });
  await expect(provenancePanel.getByRole("heading", { name: "Serial provenance" })).toBeVisible();
  await expect(provenancePanel.getByText("verified", { exact: true })).toBeVisible();
  await expect(provenancePanel).toContainText("0x1209");
  await expect(provenancePanel).toContainText("0x0001");
  await expect(provenancePanel).toContainText("115,200 baud · 8N1");
  await expect(provenancePanel.getByRole("region", { name: "Serial provenance boundaries" }))
    .toContainText("No provenance reconciliation issues.");

  const bundlePanel = page.getByRole("region", { name: "Incident bundle preview" });
  await bundlePanel.getByRole("button", { name: "Create incident bundle" }).click();
  const bundleDialog = page.getByRole("dialog", { name: "Package this incident for handoff?" });
  const bundleDownloadPromise = page.waitForEvent("download");
  await bundleDialog.getByRole("button", { name: "Build and download" }).click();
  const bundleDownload = await bundleDownloadPromise;
  const bundlePath = testInfo.outputPath("exact-serial-range-evidence.nlb");
  await bundleDownload.saveAs(bundlePath);
  await expect(page.getByRole("dialog", { name: "Handoff archive is ready" })).toBeVisible();

  const archive = await verifyEvidenceBundle(bundlePath);
  expect(archive.report).toMatchObject({
    integrity: "internally-consistent",
    evidence: "verified",
    captureEvidence: "verified",
    provenanceEvidence: "verified",
    authenticity: "not-established",
  });
  expect(archive.manifest).toMatchObject({
    format: "narrowslink/evidence-bundle",
    formatVersion: 4,
    session: {
      id: document.id,
      title: CAPTURE_TITLE,
      captureIntegrity: document.captureIntegrity,
    },
    provenance: {
      availability: "available",
      status: "verified",
      sourceId: document.source.id,
      transport: "serial",
      issueCodes: [],
      captureId: null,
      endpointAttribution: null,
      journal: { availability: "unavailable", reason: "not-applicable", entryCount: 0 },
    },
    selection: {
      title: RANGE_TITLE,
      severity: "critical",
      startUs: startRecord.offsetUs,
      endUs: endRecord.offsetUs,
      rangeSemantics: "half-open [startUs, endUs)",
    },
  });
  expect(archive.rawRecords.map((record) => record.id)).toEqual(expectedRangeRecords.map((record) => record.id));
  expect(archive.rawRecords.map((record) => record.dataHex)).toEqual(expectedRangeRecords.map((record) => record.dataHex));
  expect(archive.decodedRecordCount).toBe(expectedRangeRecords.length);
  expect(archive.integrityReceipt).toEqual(document.captureIntegrity);
  expect(archive.transportEvents).toEqual([]);
  expect(archive.transportProvenance).toEqual({
    format: "narrowslink/transport-provenance",
    formatVersion: 1,
    availability: "available",
    sessionFormatVersion: 2,
    sourceId: document.source.id,
    transport: "serial",
    provenance: document.transportProvenance,
  });
  expect(archive.transportJournal).toEqual({
    format: "narrowslink/transport-journal",
    formatVersion: 1,
    availability: "unavailable",
    reason: "not-applicable",
    sessionFormatVersion: 2,
    sourceId: document.source.id,
    transport: "serial",
    captureId: null,
    journal: null,
  });
  expect(browserErrors).toEqual([]);
});
