import { readFile, writeFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

import { NMEA0183_DECODER_PACK } from "../../src/domain/decoder";
import { sealDecoderPack } from "../../src/domain/decoder-pack";
import { verifyEvidenceBundle } from "./support/archive";
import {
  startLoopbackBridge,
  type BridgeCaptureJournal,
  type LoopbackBridge,
} from "./support/bridge";

interface CapturedUdpEndpoint {
  address: string;
  port: number;
  family: "IPv4" | "IPv6";
}

interface CapturedRecord {
  id: string;
  offsetUs: number;
  dataHex: string;
  captureBytes: number;
  transport: {
    kind: "udp";
    remoteEndpoint?: CapturedUdpEndpoint;
  };
}

interface CapturedSessionDocument {
  id: string;
  title: string;
  formatVersion: number;
  durationUs: number;
  source: {
    id: string;
    kind: "udp";
  };
  records: CapturedRecord[];
  captureIntegrity: {
    status: string;
    assessmentBasis: string;
    issueCodes: string[];
  };
  transportProvenance: {
    schemaVersion: number;
    sourceId: string;
    transport: "udp";
    status: "verified" | "incomplete";
    issueCodes: string[];
    journal: BridgeCaptureJournal | null;
    endpointAttribution: {
      totalRecords: number;
      attributedRecords: number;
      unattributedRecords: number;
      distinctEndpoints: CapturedUdpEndpoint[];
    };
    byteAccounting: unknown;
  };
}

interface TransportProvenanceArchiveDocument {
  format: "narrowslink/transport-provenance";
  formatVersion: number;
  availability: "available";
  sessionFormatVersion: number;
  sourceId: string;
  transport: "udp";
  provenance: CapturedSessionDocument["transportProvenance"];
}

interface TransportJournalArchiveDocument {
  format: "narrowslink/transport-journal";
  formatVersion: number;
  availability: "available";
  sessionFormatVersion: number;
  sourceId: string;
  transport: "udp";
  captureId: string;
  journal: BridgeCaptureJournal;
}

const CAPTURE_TITLE = "Release gate UDP capture";
const RANGE_TITLE = "Exact UDP evidence range";
const MARKER_TITLE = "Operator observed transition";
const OPERATOR_NOTE = "Release gate note retained with the exact authored range.";
const EXPECTED_ARCHIVE_PATHS = [
  "SHA256SUMS",
  "decoded/packets.csv",
  "diagnostics/diagnostics.csv",
  "diagnostics/diagnostics.json",
  "manifest.json",
  "markers/markers.json",
  "notes/notes.json",
  "raw/source-records.ndjson",
  "schema/schema.json",
  "transport/events.json",
  "transport/integrity-receipt.json",
  "transport/journal.json",
  "transport/provenance.json",
].sort((left, right) => left.localeCompare(right));

function formatOffsetUsInput(offsetUs: number): string {
  const hours = Math.floor(offsetUs / 3_600_000_000);
  const minutes = Math.floor((offsetUs % 3_600_000_000) / 60_000_000);
  const seconds = Math.floor((offsetUs % 60_000_000) / 1_000_000);
  const microseconds = offsetUs % 1_000_000;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${microseconds.toString().padStart(6, "0")}`;
}

async function expectFocusInside(page: Page, selector: "dialog" | "main"): Promise<void> {
  await expect.poll(() => page.evaluate((target) => {
    const active = document.activeElement;
    const container = document.querySelector(target === "dialog" ? "[role='dialog']" : "main");
    return active !== null
      && active !== document.body
      && active !== document.documentElement
      && container?.contains(active) === true;
  }, selector)).toBe(true);
}

function jsonArchiveEntry<T>(entries: Record<string, Uint8Array>, path: string): T {
  const bytes = entries[path];
  if (!bytes) throw new Error(`Archive is missing ${path}.`);
  return JSON.parse(strFromU8(bytes)) as T;
}

async function openEvidenceBundle(
  page: Page,
  bundlePath: string,
  expectedTitle: string,
): Promise<ReturnType<Page["getByRole"]>> {
  await page.getByLabel("Choose a ReplayCase evidence bundle").setInputFiles(bundlePath);
  const workspace = page.getByRole("main", { name: "Received incident evidence workspace" });
  await expect(workspace).toBeVisible({ timeout: 30_000 });
  await expect(workspace.getByRole("heading", { name: expectedTitle, level: 1 })).toBeVisible();
  await expect(workspace.getByRole("region", { name: "Evidence verification claims" }))
    .toContainText("Internally Consistent");
  return workspace;
}

let bridge: LoopbackBridge | undefined;

test.afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

test("captures real NMEA UDP traffic and hands off the exact decoder interpretation", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const title = "NMEA decoder portability proof";
  const nmeaHex = NMEA0183_DECODER_PACK.fixtures.flatMap((fixture) =>
    fixture.records.map((record) => record.dataHex));
  const { integrity: _integrity, ...portableDraft } = structuredClone(NMEA0183_DECODER_PACK);
  portableDraft.id = "NMEA-0183-GIG-HARBOR";
  portableDraft.revision = "harbor-reference-v1";
  portableDraft.displayName = "Gig Harbor NMEA reference";
  portableDraft.description = "Local NMEA 0183 decoder pack used to prove protocol portability.";
  const portablePack = sealDecoderPack(portableDraft);
  bridge = await startLoopbackBridge();
  await page.goto("/");
  await page.getByRole("button", { name: /Live capture UDP or serial/ }).click();
  const captureDialog = page.getByRole("dialog", { name: "Record live telemetry" });
  await captureDialog.getByLabel("Session title", { exact: true }).fill(title);
  await captureDialog.getByLabel(/Display timezone/).fill("UTC");
  const packPath = testInfo.outputPath("gig-harbor-nmea-reference.nldecoder");
  await writeFile(packPath, `${JSON.stringify(portablePack, null, 2)}\n`);
  await captureDialog.locator("input[type='file'][accept*='.nldecoder']").setInputFiles(packPath);
  await expect(captureDialog).toContainText("Loaded Gig Harbor NMEA reference harbor-reference-v1; 4 fixtures passed.");
  await expect(captureDialog).toContainText(portablePack.integrity.canonicalSha256.slice(0, 12));
  await expect(captureDialog).toContainText("local");
  await captureDialog.getByLabel(/Bridge URL/).fill(bridge.controlUrl);
  await captureDialog.getByLabel("Bridge token", { exact: true }).fill(bridge.token);
  await captureDialog.getByLabel("UDP bind host", { exact: true }).fill("127.0.0.1");
  await captureDialog.getByLabel(/UDP port/).fill("0");

  await captureDialog.getByRole("button", { name: "Save setup" }).click();
  await captureDialog.getByLabel("Profile name").fill("Gig Harbor NMEA UDP");
  await captureDialog.getByRole("button", { name: "Save profile" }).click();
  await expect(captureDialog).toContainText(
    "Gig Harbor NMEA UDP was saved locally without bridge credentials, device permissions, or telemetry payloads.",
  );

  await captureDialog.getByRole("button", { name: "Run UDP preflight" }).click();
  await expect(captureDialog.getByRole("region", { name: "Preflight waiting for traffic" })).toBeVisible();
  await bridge.waitForStatus((status) => status.state === "capturing" && (status.udp?.port ?? 0) > 0);
  await bridge.sendDatagrams([nmeaHex[0]!]);
  await expect(captureDialog.getByRole("region", { name: "Preflight ready" })).toBeVisible();
  await expect(captureDialog).toContainText("Traffic and decoder fit are confirmed.");
  await captureDialog.getByRole("button", { name: "Start recording" }).click();
  await expect(captureDialog.getByRole("region", { name: "Recording" })).toBeVisible();

  const sent = await bridge.sendDatagrams(nmeaHex, { intervalMs: 15 });
  const sentBytes = sent.reduce((total, datagram) => total + datagram.byteLength, 0);
  await bridge.waitForStatus((status) => status.capture?.datagrams === sent.length);
  await expect(captureDialog.getByText("Records retained", { exact: true }).locator("..")).toContainText(String(sent.length));

  const sessionDownloadPromise = page.waitForEvent("download");
  await captureDialog.getByRole("button", { name: "Stop, save & replay" }).click();
  const sessionDownload = await sessionDownloadPromise;
  const sessionPath = testInfo.outputPath("nmea-captured-session.nlsession");
  await sessionDownload.saveAs(sessionPath);
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();

  const document = JSON.parse(await readFile(sessionPath, "utf8")) as CapturedSessionDocument & {
    decoder: {
      id: string;
      revision: string;
      schemaHash: string;
      packHash: string;
      runtimeId: string;
      runtimeRevision: string;
    };
    decoderPack: {
      integrity: { canonicalSha256: string };
      runtime: { id: string; revision: string };
    };
  };
  expect(document.records.map((record) => record.dataHex.toLowerCase())).toEqual(
    sent.map((datagram) => datagram.dataHex),
  );
  expect(document.captureIntegrity).toMatchObject({
    status: "verified",
    assessmentBasis: "udp-bridge-reconciled",
    issueCodes: [],
  });
  expect(document.decoder).toMatchObject({
    id: "NMEA-0183-GIG-HARBOR",
    revision: "harbor-reference-v1",
    packHash: portablePack.integrity.canonicalSha256,
    runtimeId: "nmea0183-line-v1",
    runtimeRevision: "1",
  });
  expect(document.decoderPack).toMatchObject({
    integrity: { canonicalSha256: portablePack.integrity.canonicalSha256 },
    runtime: { id: "nmea0183-line-v1", revision: "1" },
  });

  await page.getByRole("button", { name: /Live capture UDP or serial/ }).click();
  const reopenedCaptureDialog = page.getByRole("dialog", { name: "Record live telemetry" });
  await reopenedCaptureDialog.getByRole("combobox", { name: "Capture profile", exact: true })
    .selectOption({ label: "Gig Harbor NMEA UDP · UDP" });
  await expect(reopenedCaptureDialog.getByRole("combobox", { name: "Decoder pack", exact: true })).toHaveValue(
    portablePack.integrity.canonicalSha256,
  );
  await expect(reopenedCaptureDialog.getByLabel("UDP bind host", { exact: true })).toHaveValue("127.0.0.1");
  await expect(reopenedCaptureDialog.getByLabel(/UDP port/)).toHaveValue("0");
  await expect(reopenedCaptureDialog.getByLabel("Bridge token", { exact: true })).toHaveValue("");
  await reopenedCaptureDialog.getByRole("button", { name: "Cancel" }).click();

  const bundlePanel = page.getByRole("region", { name: "Incident bundle preview" });
  await bundlePanel.getByRole("button", { name: "Create incident bundle" }).click();
  const bundleDialog = page.getByRole("dialog", { name: "Package this incident for handoff?" });
  const bundleDownloadPromise = page.waitForEvent("download");
  await bundleDialog.getByRole("button", { name: "Build and download" }).click();
  const bundleDownload = await bundleDownloadPromise;
  const bundlePath = testInfo.outputPath("nmea-evidence.nlb");
  await bundleDownload.saveAs(bundlePath);

  const verified = await verifyEvidenceBundle(bundlePath);
  expect(verified.manifest.session).toMatchObject({
    decoderId: "NMEA-0183-GIG-HARBOR",
    decoderRevision: "harbor-reference-v1",
    packHash: portablePack.integrity.canonicalSha256,
    runtimeId: "nmea0183-line-v1",
    runtimeRevision: "1",
  });
  expect(verified.rawRecords.map((record) => record.dataHex.toLowerCase())).toEqual(
    sent.map((datagram) => datagram.dataHex),
  );
  expect(verified.decodedRecordCount).toBe(sent.length);
  expect(verified.report.warnings).not.toContain(
    "Decoded packet rows could not be replay-checked because this receiver does not implement the declared decoder.",
  );
  const entries = unzipSync(new Uint8Array(await readFile(bundlePath)));
  const schema = jsonArchiveEntry<{
    schema: { packSha256: string; runtimeId: string; runtimeRevision: string };
    decoderPack: { integrity: { canonicalSha256: string } };
  }>(entries, "schema/schema.json");
  expect(schema).toMatchObject({
    schema: {
      packSha256: portablePack.integrity.canonicalSha256,
      runtimeId: "nmea0183-line-v1",
      runtimeRevision: "1",
    },
    decoderPack: {
      integrity: { canonicalSha256: portablePack.integrity.canonicalSha256 },
    },
  });

  await page.getByRole("dialog", { name: "Handoff archive is ready" })
    .getByRole("button", { name: "Return to session" })
    .click();
  const receiverTitle = verified.manifest.selection.title ?? title;
  const receiver = await openEvidenceBundle(page, bundlePath, receiverTitle);
  const claims = receiver.getByRole("region", { name: "Evidence verification claims" });
  await expect(claims).toContainText("Evidence completeness");
  await expect(claims).toContainText("Verified");
  await expect(claims).toContainText("Source authenticity");
  await expect(claims).toContainText("Not Established");
  await expect(receiver.getByText("NMEA GGA · Global Positioning System Fix Data", { exact: true }).first())
    .toBeVisible();
  await receiver.getByRole("tab", { name: "provenance" }).click();
  await expect(receiver.getByRole("tabpanel", { name: "provenance" }))
    .toContainText("NMEA-0183-GIG-HARBOR");

  const receiverFinding = "Receiver independently reproduced the NMEA interpretation.";
  await receiver.getByRole("tab", { name: "notes" }).click();
  await receiver.getByLabel("Receiver finding for this evidence bundle").fill(receiverFinding);
  await expect(receiver.getByText("Stored separately", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 })).toBeVisible();
  const reopenedReceiver = await openEvidenceBundle(page, bundlePath, receiverTitle);
  await reopenedReceiver.getByRole("tab", { name: "notes" }).click();
  await expect(reopenedReceiver.getByLabel("Receiver finding for this evidence bundle"))
    .toHaveValue(receiverFinding);

  const malformedBundlePath = testInfo.outputPath("malformed-evidence.nlb");
  await writeFile(malformedBundlePath, "This is not a ReplayCase evidence archive.");
  await page.getByLabel("Choose a ReplayCase evidence bundle").setInputFiles(malformedBundlePath);
  const rejectedDialog = page.getByRole("dialog", { name: "malformed-evidence.nlb was not opened" });
  await expect(rejectedDialog).toBeVisible();
  await expect(rejectedDialog).toContainText("Evidence bundle rejected");
  await expect(rejectedDialog).toContainText("The previously open workspace remains unchanged.");
  await rejectedDialog.getByRole("button", { name: "Return to workspace" }).click();
  await expect(reopenedReceiver.getByRole("heading", { name: receiverTitle, level: 1 })).toBeVisible();
  await expect(reopenedReceiver.getByLabel("Receiver finding for this evidence bundle"))
    .toHaveValue(receiverFinding);

  expect(sentBytes).toBeGreaterThan(0);
  expect(browserErrors).toEqual([]);
});

test("diagnoses a decoder mismatch before recording and discards the probe cleanly", async ({ page }) => {
  bridge = await startLoopbackBridge();
  await page.goto("/");
  await page.getByRole("button", { name: /Live capture UDP or serial/ }).click();
  const captureDialog = page.getByRole("dialog", { name: "Record live telemetry" });
  await captureDialog.getByRole("combobox", { name: "Decoder pack", exact: true })
    .selectOption(NMEA0183_DECODER_PACK.integrity.canonicalSha256);
  await captureDialog.getByLabel(/Bridge URL/).fill(bridge.controlUrl);
  await captureDialog.getByLabel("Bridge token", { exact: true }).fill(bridge.token);
  await captureDialog.getByLabel("UDP bind host", { exact: true }).fill("127.0.0.1");
  await captureDialog.getByLabel(/UDP port/).fill("0");
  await captureDialog.getByRole("button", { name: "Run UDP preflight" }).click();
  await bridge.waitForStatus((status) => status.state === "capturing" && (status.udp?.port ?? 0) > 0);
  await bridge.sendFixtureDatagrams({ count: 3, intervalMs: 10 });

  await expect(captureDialog.getByRole("region", { name: "Preflight needs attention" })).toBeVisible();
  await expect(captureDialog).toContainText(
    "Traffic is arriving, but the selected decoder has not produced a valid frame.",
  );
  await expect(captureDialog.getByRole("button", { name: "Record with warning" })).toBeEnabled();
  await expect(captureDialog).toContainText(
    "Preflight samples are not retained. Starting recording stops this probe and opens a new owned capture ID.",
  );

  await captureDialog.getByRole("button", { name: "Stop preflight" }).click();
  const readyStatus = captureDialog.getByRole("region", { name: "Ready" });
  await expect(readyStatus).toBeVisible();
  await expect(readyStatus.getByText("0s", { exact: true })).toBeVisible();
  await expect(captureDialog).toContainText("Its sampled bytes were not added to a session.");
  await bridge.waitForStatus((status) => status.state === "stopped");
});

test("records UDP, replays and investigates it, then exports independently verifiable evidence", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  bridge = await startLoopbackBridge();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: /Live capture UDP or serial/ }).click();
  const captureDialog = page.getByRole("dialog", { name: "Record live telemetry" });
  await expect(captureDialog).toBeVisible();
  await captureDialog.getByLabel("Session title", { exact: true }).fill(CAPTURE_TITLE);
  await captureDialog.getByLabel(/Display timezone/).fill("UTC");
  await captureDialog.getByLabel(/Bridge URL/).fill(bridge.controlUrl);
  await captureDialog.getByLabel("Bridge token", { exact: true }).fill(bridge.token);
  await captureDialog.getByLabel("UDP bind host", { exact: true }).fill("127.0.0.1");
  await captureDialog.getByLabel(/UDP port/).fill("0");
  await captureDialog.getByRole("button", { name: "Run UDP preflight" }).click();
  await expect(captureDialog.getByRole("region", { name: "Preflight waiting for traffic" })).toBeVisible();
  await bridge.waitForStatus((status) => status.state === "capturing" && (status.udp?.port ?? 0) > 0);
  await bridge.sendFixtureDatagrams({ count: 2, intervalMs: 10 });
  await expect(captureDialog.getByRole("region", { name: "Preflight ready" })).toBeVisible();
  await captureDialog.getByRole("button", { name: "Start recording" }).click();
  await expect(captureDialog.getByRole("region", { name: "Recording" })).toBeVisible();
  await expectFocusInside(page, "dialog");

  await bridge.waitForStatus((status) => status.state === "capturing" && (status.udp?.port ?? 0) > 0);
  const sent = await bridge.sendFixtureDatagrams({ count: 12, intervalMs: 10 });
  const sentBytes = sent.reduce((total, datagram) => total + datagram.byteLength, 0);
  await bridge.waitForStatus((status) => status.capture?.datagrams === sent.length && status.capture.bytes === sentBytes);
  await expect(captureDialog.getByText("Datagrams received", { exact: true }).locator("..")).toContainText(String(sent.length));
  await expect(captureDialog.getByText("Input bytes", { exact: true }).locator("..")).toContainText(`${sentBytes} B`);
  await expect(captureDialog.getByText("Records retained", { exact: true }).locator("..")).toContainText(String(sent.length));
  await bridge.waitForStatus((status) => (status.capture?.durationUs ?? 0) >= 1_500_000);

  const sessionDownloadPromise = page.waitForEvent("download");
  await captureDialog.getByRole("button", { name: "Stop, save & replay" }).click();
  const sessionDownload = await sessionDownloadPromise;
  expect(sessionDownload.suggestedFilename()).toMatch(/^replaycase-release-gate-udp-capture-.*\.nlsession$/);
  const sessionPath = testInfo.outputPath("captured-session.nlsession");
  await sessionDownload.saveAs(sessionPath);

  const captureHeading = page.getByRole("heading", { name: CAPTURE_TITLE, level: 1 });
  await expect(captureHeading).toBeVisible();
  await expect(captureHeading).toBeFocused();
  await expectFocusInside(page, "main");
  const terminalBridgeStatus = await bridge.waitForStatus((status) => (
    status.state === "stopped" && status.captureJournal?.state === "clean"
  ));
  const terminalJournal = terminalBridgeStatus.captureJournal;
  expect(terminalJournal).not.toBeNull();
  if (!terminalJournal) throw new Error("Bridge did not preserve its terminal capture journal.");
  expect(terminalJournal).toMatchObject({
    captureId: terminalBridgeStatus.capture?.id,
    startedAt: terminalBridgeStatus.capture?.startedAt,
    endedAt: terminalBridgeStatus.capture?.endedAt,
    state: "clean",
    bind: {
      requestedHost: "127.0.0.1",
      requestedPort: 0,
      host: "127.0.0.1",
      port: terminalBridgeStatus.udp?.port,
      family: "IPv4",
    },
    multicast: null,
    datagrams: sent.length,
    bytes: sentBytes,
    entriesComplete: true,
    omittedEntries: 0,
  });
  if (terminalJournal.kernelDroppedDatagrams === null) {
    expect(terminalJournal.kernelDroppedDatagramsSource).toMatch(/^unavailable(?:-|$)/);
  } else {
    expect(terminalJournal.kernelDroppedDatagramsSource).toBe("linux-proc-net-udp-socket");
    expect(terminalJournal.kernelDroppedDatagrams).toBeGreaterThanOrEqual(0);
  }
  expect(terminalJournal.entries.map((entry) => entry.type)).toEqual(["capture-started", "capture-stopped"]);
  expect(terminalJournal.entries.at(-1)).toMatchObject({
    datagrams: sent.length,
    bytes: sentBytes,
  });
  const savedSessionButton = page.getByRole("button", {
    name: new RegExp(`^(?:Reopen current|Open) saved session ${CAPTURE_TITLE},`),
  });
  await expect(savedSessionButton).toHaveCount(1);
  await expect(savedSessionButton).toContainText("Verified");

  const document = JSON.parse(await readFile(sessionPath, "utf8")) as CapturedSessionDocument;
  expect(document).toMatchObject({ title: CAPTURE_TITLE, formatVersion: 2 });
  expect(document.records).toHaveLength(sent.length);
  expect(document.records.map((record) => record.dataHex.toLowerCase())).toEqual(
    sent.map((datagram) => datagram.dataHex),
  );
  expect(document.captureIntegrity).toMatchObject({
    status: "verified",
    assessmentBasis: "udp-bridge-reconciled",
    issueCodes: [],
  });
  const endpoints = document.records.map((record) => record.transport.remoteEndpoint);
  expect(endpoints.every((endpoint) => endpoint !== undefined)).toBe(true);
  const remoteEndpoint = endpoints[0];
  if (!remoteEndpoint) throw new Error("Captured UDP records are missing their remote endpoint.");
  expect(remoteEndpoint).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
  expect(remoteEndpoint.port).toBeGreaterThan(0);
  expect(endpoints).toEqual(Array.from({ length: sent.length }, () => remoteEndpoint));
  const kernelCounterUnavailable = terminalJournal.kernelDroppedDatagrams === null;
  const expectedProvenanceIssueCodes = kernelCounterUnavailable
    ? ["udp-kernel-drop-counter-unavailable"]
    : [];
  const expectedByteAccounting = {
    schemaVersion: 1,
    scope: "whole-session",
    datagrams: sent.length,
    payload: {
      bytes: sentBytes,
      basis: "observed",
      source: "udp-bridge-payload-counter",
      confidence: "exact",
    },
    udp: {
      bytes: sentBytes + (sent.length * 8),
      basis: "estimated",
      source: "payload-plus-fixed-udp-header",
      confidence: "deterministic",
      headerBytesPerDatagram: 8,
    },
    ip: {
      bytes: sentBytes + (sent.length * 28),
      basis: "minimum-estimate",
      source: "payload-plus-fixed-udp-and-ip-headers",
      confidence: "bounded-assumption",
      family: "IPv4",
      headerBytesPerDatagram: 20,
      assumptions: ["no-ip-options-or-extension-headers", "no-fragmentation"],
    },
    linkLayer: { bytes: null, basis: "unavailable", reason: "not-observed-at-udp-socket" },
    radioLayer: { bytes: null, basis: "unavailable", reason: "not-observed-at-udp-socket" },
  };
  expect(document.transportProvenance).toEqual({
    schemaVersion: 2,
    sourceId: document.source.id,
    transport: "udp",
    status: "verified",
    issueCodes: expectedProvenanceIssueCodes,
    journal: terminalJournal,
    endpointAttribution: {
      totalRecords: sent.length,
      attributedRecords: sent.length,
      unattributedRecords: 0,
      distinctEndpoints: [remoteEndpoint],
    },
    byteAccounting: expectedByteAccounting,
  });

  const startRecord = document.records[2];
  const endRecord = document.records[8];
  expect(startRecord).toBeDefined();
  expect(endRecord).toBeDefined();
  if (!startRecord || !endRecord) throw new Error("Capture did not retain enough records for an exact range.");
  expect(endRecord.offsetUs).toBeGreaterThan(startRecord.offsetUs);
  const expectedRangeRecords = document.records.filter(
    (record) => record.offsetUs >= startRecord.offsetUs && record.offsetUs < endRecord.offsetUs,
  );
  expect(expectedRangeRecords[0]?.id).toBe(startRecord.id);
  expect(expectedRangeRecords.some((record) => record.id === endRecord.id)).toBe(false);

  await page.getByLabel("Choose a local ReplayCase replay").setInputFiles(sessionPath);
  await expect(captureHeading).toBeVisible();
  await expect(savedSessionButton).toHaveCount(1);
  await expect(page.getByRole("button", { name: `Remove saved session ${CAPTURE_TITLE}` })).toHaveCount(1);

  const replaySpeed = page.getByLabel("Replay speed");
  await replaySpeed.selectOption("2");
  await expect(replaySpeed).toHaveValue("2");
  const replayPosition = page.getByRole("slider", { name: "Replay position" });
  const replaySeekOffsetUs = 1_000_000;
  expect(document.durationUs).toBeGreaterThan(replaySeekOffsetUs);
  await replayPosition.fill(String(replaySeekOffsetUs));
  await expect(replayPosition).toHaveValue(String(replaySeekOffsetUs));
  await page.getByRole("button", { name: "Play replay" }).click();
  await expect(page.getByRole("button", { name: "Replay again" })).toBeVisible();

  await page.getByRole("button", { name: "New range" }).click();
  const rangeDialog = page.getByRole("dialog", { name: "Define an incident range" });
  await rangeDialog.getByLabel("Title", { exact: true }).fill(RANGE_TITLE);
  await rangeDialog.getByLabel(/^Start · included/).fill(formatOffsetUsInput(startRecord.offsetUs));
  await rangeDialog.getByLabel(/^End · excluded/).fill(formatOffsetUsInput(endRecord.offsetUs));
  await rangeDialog.getByRole("combobox", { name: "Severity" }).selectOption("critical");
  await rangeDialog.getByRole("button", { name: "Create range" }).click();
  await expect(page.getByRole("heading", { name: RANGE_TITLE, level: 2 })).toBeVisible();
  await expect(page.getByLabel("Selected incident")).toHaveValue(/^operator-/);

  await page.getByRole("tab", { name: /^provenance$/i }).click();
  const provenancePanel = page.getByRole("tabpanel", { name: /^provenance$/i });
  await expect(provenancePanel.getByRole("heading", { name: "UDP provenance" })).toBeVisible();
  await expect(provenancePanel.getByText("verified", { exact: true })).toBeVisible();
  await expect(provenancePanel).toContainText(terminalJournal.captureId);
  await expect(provenancePanel).toContainText(`${sent.length} / ${sent.length} records · 1 endpoint`);
  await expect(provenancePanel).toContainText(`${sent.length} datagrams`);
  await expect(provenancePanel).toContainText(kernelCounterUnavailable ? "Unavailable" : `${terminalJournal.kernelDroppedDatagrams} datagrams`);
  await expect(provenancePanel).toContainText("payload + 8 B/datagram");
  await expect(provenancePanel).toContainText("not observed at UDP socket");
  await expect(provenancePanel).toContainText("clean · 2 entries");
  const endpointEvidence = provenancePanel.getByRole("region", { name: "Remote endpoints in selected incident" });
  await expect(endpointEvidence).toContainText(`127.0.0.1:${remoteEndpoint.port}`);
  await expect(endpointEvidence).toContainText(`${expectedRangeRecords.length} records`);
  await expect(provenancePanel.getByRole("region", { name: "Bridge journal entries in selected incident" }))
    .toContainText("Whole-session state: clean");
  await expect(provenancePanel.getByRole("region", { name: "UDP provenance boundaries" }))
    .toContainText(kernelCounterUnavailable ? "udp-kernel-drop-counter-unavailable" : "No provenance reconciliation issues.");

  const markerOffsetUs = Math.floor(((startRecord.offsetUs + endRecord.offsetUs) / 2) / 1_000) * 1_000;
  expect(markerOffsetUs).toBeGreaterThan(startRecord.offsetUs);
  expect(markerOffsetUs).toBeLessThan(endRecord.offsetUs);
  await page.getByRole("button", { name: "Add marker" }).click();
  const markerDialog = page.getByRole("dialog", { name: "Add an operator marker" });
  await markerDialog.getByLabel(/^Offset from session start/).fill((markerOffsetUs / 1_000_000).toFixed(3));
  await markerDialog.getByLabel("Title", { exact: true }).fill(MARKER_TITLE);
  await markerDialog.getByRole("combobox", { name: "Category" }).selectOption("observation");
  await markerDialog.getByLabel("Note", { exact: true }).fill("Marker falls inside the selected half-open range.");
  await markerDialog.getByRole("button", { name: "Add marker" }).click();
  await expect(page.getByRole("region", { name: "Session overview" })).toContainText("1 operator marker");

  const sessionNote = page.getByLabel("Session-wide operator note");
  await sessionNote.fill(OPERATOR_NOTE);
  await expect(sessionNote).toHaveValue(OPERATOR_NOTE);

  const bundlePanel = page.getByRole("region", { name: "Incident bundle preview" });
  await bundlePanel.getByRole("button", { name: "Create incident bundle" }).click();
  const bundleDialog = page.getByRole("dialog", { name: "Package this incident for handoff?" });
  const bundleDownloadPromise = page.waitForEvent("download");
  await bundleDialog.getByRole("button", { name: "Build and download" }).click();
  const bundleDownload = await bundleDownloadPromise;
  expect(bundleDownload.suggestedFilename()).toMatch(/\.nlb$/);
  const bundlePath = testInfo.outputPath("exact-range-evidence.nlb");
  await bundleDownload.saveAs(bundlePath);
  const readyBundleDialog = page.getByRole("dialog", { name: "Handoff archive is ready" });
  await expect(readyBundleDialog).toBeVisible();

  const archive = await verifyEvidenceBundle(bundlePath);
  const archiveEntries = unzipSync(new Uint8Array(await readFile(bundlePath)));
  const provenanceDocument = jsonArchiveEntry<TransportProvenanceArchiveDocument>(
    archiveEntries,
    "transport/provenance.json",
  );
  const journalDocument = jsonArchiveEntry<TransportJournalArchiveDocument>(
    archiveEntries,
    "transport/journal.json",
  );
  const manifest = archive.manifest as typeof archive.manifest & {
    provenance: {
      availability: string;
      status: string;
      sourceId: string;
      transport: string;
      issueCodes: string[];
      captureId: string | null;
      endpointAttribution: {
        totalRecords: number;
        attributedRecords: number;
        unattributedRecords: number;
        distinctEndpointCount: number;
      } | null;
      journal: {
        availability: string;
        reason: string | null;
        state: string | null;
        entriesComplete: boolean | null;
        entryCount: number;
        omittedEntries: number;
      };
    };
  };
  expect(archive.paths).toEqual(EXPECTED_ARCHIVE_PATHS);
  expect(manifest).toMatchObject({
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
      transport: "udp",
      issueCodes: expectedProvenanceIssueCodes,
      captureId: terminalJournal.captureId,
      endpointAttribution: {
        totalRecords: sent.length,
        attributedRecords: sent.length,
        unattributedRecords: 0,
        distinctEndpointCount: 1,
      },
      journal: {
        availability: "available",
        reason: null,
        state: "clean",
        entriesComplete: true,
        entryCount: 2,
        omittedEntries: 0,
      },
    },
    selection: {
      id: expect.stringMatching(/^operator-/),
      title: RANGE_TITLE,
      severity: "critical",
      startUs: startRecord.offsetUs,
      endUs: endRecord.offsetUs,
      rangeSemantics: "half-open [startUs, endUs)",
    },
    inclusions: {
      rawRecords: true,
      decodedPackets: true,
      diagnostics: true,
      markers: true,
      notes: true,
      schema: true,
      transportEvidence: true,
    },
  });
  expect(provenanceDocument).toEqual({
    format: "narrowslink/transport-provenance",
    formatVersion: 2,
    availability: "available",
    sessionFormatVersion: 2,
    sourceId: document.source.id,
    transport: "udp",
    provenance: document.transportProvenance,
  });
  expect(journalDocument).toEqual({
    format: "narrowslink/transport-journal",
    formatVersion: 1,
    availability: "available",
    sessionFormatVersion: 2,
    sourceId: document.source.id,
    transport: "udp",
    captureId: terminalJournal.captureId,
    journal: terminalJournal,
  });
  expect(archive.rawRecords.map((record) => record.id)).toEqual(expectedRangeRecords.map((record) => record.id));
  expect(archive.rawRecords.map((record) => record.dataHex)).toEqual(expectedRangeRecords.map((record) => record.dataHex));
  expect((archive.rawRecords as CapturedRecord[]).map((record) => record.transport.remoteEndpoint))
    .toEqual(expectedRangeRecords.map((record) => record.transport.remoteEndpoint));
  expect(archive.rawRecords.every(
    (record) => record.offsetUs >= startRecord.offsetUs && record.offsetUs < endRecord.offsetUs,
  )).toBe(true);
  expect(archive.rawRecords.some((record) => record.id === startRecord.id)).toBe(true);
  expect(archive.rawRecords.some((record) => record.id === endRecord.id)).toBe(false);
  expect(archive.decodedRecordCount).toBe(expectedRangeRecords.length);
  expect(archive.markers).toEqual([
    expect.objectContaining({ title: MARKER_TITLE, offsetUs: markerOffsetUs, category: "observation" }),
  ]);
  expect(archive.notes).toEqual([
    expect.objectContaining({ id: "operator-note", title: "Operator note", body: OPERATOR_NOTE }),
  ]);
  expect(archive.integrityReceipt).toEqual(document.captureIntegrity);
  expect(archive.transportEvents).toEqual([]);

  const artifactCounts = new Map(archive.manifest.artifacts.map((artifact) => [artifact.path, artifact.recordCount]));
  expect(artifactCounts.get("raw/source-records.ndjson")).toBe(expectedRangeRecords.length);
  expect(artifactCounts.get("decoded/packets.csv")).toBe(expectedRangeRecords.length);
  expect(artifactCounts.get("diagnostics/diagnostics.json")).toBe(archive.diagnostics.length);
  expect(artifactCounts.get("diagnostics/diagnostics.csv")).toBe(archive.diagnostics.length);
  expect(artifactCounts.get("markers/markers.json")).toBe(1);
  expect(artifactCounts.get("notes/notes.json")).toBe(1);
  expect(artifactCounts.get("transport/events.json")).toBe(0);
  expect(artifactCounts.get("transport/integrity-receipt.json")).toBe(1);
  expect(artifactCounts.get("transport/provenance.json")).toBe(1);
  expect(artifactCounts.get("transport/journal.json")).toBe(terminalJournal.entries.length);

  await readyBundleDialog.getByRole("button", { name: "Return to session" }).click();
  const receiver = await openEvidenceBundle(page, bundlePath, RANGE_TITLE);
  await expect(receiver.getByRole("region", { name: "Evidence verification claims" })).toContainText("Verified");
  await expect(receiver.getByText(`${expectedRangeRecords.length} packet rows`, { exact: true })).toBeVisible();
  await expect(receiver.locator(`.receiver-mark.annotation[title="${MARKER_TITLE}"]`)).toBeVisible();
  await receiver.getByRole("tab", { name: "notes" }).click();
  await expect(receiver.getByRole("tabpanel", { name: "notes" })).toContainText(OPERATOR_NOTE);
  await receiver.getByRole("tab", { name: "provenance" }).click();
  await expect(receiver.getByRole("tabpanel", { name: "provenance" }))
    .toContainText(archive.manifest.session.decoderId);
  await receiver.getByRole("button", { name: "Return to demo session" }).click();
  await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 })).toBeVisible();
  const reopenButton = page.getByRole("button", {
    name: new RegExp(`^Open saved session ${CAPTURE_TITLE},`),
  });
  await expect(reopenButton).toBeVisible();
  await reopenButton.click();
  await expect(captureHeading).toBeVisible();
  await page.getByLabel("Selected incident").selectOption({ label: RANGE_TITLE });
  await expect(page.getByRole("heading", { name: RANGE_TITLE, level: 2 })).toBeVisible();
  await expect(page.getByLabel("Session-wide operator note")).toHaveValue(OPERATOR_NOTE);
  await expect(page.getByRole("region", { name: "Session overview" })).toContainText("1 operator marker");
  await page.getByRole("tab", { name: /^provenance$/i }).click();
  await expect(provenancePanel).toContainText(terminalJournal.captureId);
  await expect(provenancePanel).toContainText("clean · 2 entries");
  await expect(provenancePanel.getByRole("region", { name: "Remote endpoints in selected incident" }))
    .toContainText(`127.0.0.1:${remoteEndpoint.port}`);

  await page.getByRole("button", { name: `Remove saved session ${CAPTURE_TITLE}` }).click();
  const removal = page.getByRole("group", { name: `Confirm removal of ${CAPTURE_TITLE}` });
  await expect(removal).toBeVisible();
  await removal.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("No saved sessions yet.", { exact: true })).toBeVisible();
  await expect(captureHeading).toBeVisible();
  await expect(page.getByLabel("Session-wide operator note")).toHaveValue(OPERATOR_NOTE);
  await expect(page.getByText(/Removed from browser storage; save this replay again/)).toBeVisible();
  expect(await page.evaluate((note) => Object.keys(localStorage).some(
    (key) => localStorage.getItem(key)?.includes(note) === true,
  ), OPERATOR_NOTE)).toBe(false);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`saved session ${CAPTURE_TITLE},`, "i") })).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});
