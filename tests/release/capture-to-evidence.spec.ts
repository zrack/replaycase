import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import {
  validateComparisonFinding,
  type ComparisonFinding,
} from "../../src/domain/comparison";
import {
  configuredReleaseArchive,
  startRelease,
  unpackRelease,
  verifyBundleWithRelease,
  type ReleaseInstallation,
  type RunningRelease,
} from "./support/release";
import {
  releaseFixtureDatagrams,
  sendReleaseDatagrams,
} from "./support/udp";

interface CapturedRecord {
  readonly id: string;
  readonly offsetUs: number;
  readonly dataHex: string;
  readonly captureBytes: number;
  readonly transport: {
    readonly kind: "udp";
    readonly remoteEndpoint?: {
      readonly address: string;
      readonly port: number;
      readonly family: "IPv4" | "IPv6";
    };
  };
}

interface CapturedSession {
  readonly id: string;
  readonly title: string;
  readonly formatVersion: 2;
  readonly durationUs: number;
  readonly records: readonly CapturedRecord[];
  readonly captureIntegrity: {
    readonly status: string;
    readonly assessmentBasis: string;
    readonly issueCodes: readonly string[];
  };
  readonly transportProvenance: {
    readonly status: string;
    readonly transport: string;
    readonly issueCodes: readonly string[];
  };
}

const CAPTURE_TITLE = "Artifact release UDP capture";
const RANGE_TITLE = "Artifact exact UDP evidence range";
const MARKER_TITLE = "Artifact operator transition";
const OPERATOR_NOTE = "Artifact release gate retained this exact operator-authored range.";
const RECEIVER_NOTE = "Receiver reproduced the packaged release evidence after independent verification.";
const COMPARISON_CONCLUSION = "The packaged release reproduced the received incident against the original replay using the exact authored-range start as a shared anchor.";
const DATAGRAM_COUNT = 12;

function formatOffsetUsInput(offsetUs: number): string {
  const hours = Math.floor(offsetUs / 3_600_000_000);
  const minutes = Math.floor((offsetUs % 3_600_000_000) / 60_000_000);
  const seconds = Math.floor((offsetUs % 60_000_000) / 1_000_000);
  const microseconds = offsetUs % 1_000_000;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${microseconds.toString().padStart(6, "0")}`;
}

async function boundUdpPort(captureDialog: ReturnType<Page["getByRole"]>): Promise<number> {
  const source = captureDialog.getByText("Source", { exact: true }).locator("..").locator("dd");
  await expect(source).toContainText(/^127\.0\.0\.1:\d+ · IPv4$/);
  const match = (await source.textContent())?.match(/^127\.0\.0\.1:(\d+)/);
  if (!match) throw new Error("The managed capture UI did not expose its bound UDP source.");
  return Number(match[1]);
}

async function workspaceIsDurable(page: Page): Promise<boolean> {
  return page.evaluate(({ markerTitle, note, rangeTitle }) => {
    const values = Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return key === null ? null : localStorage.getItem(key);
    });
    return values.some((value) => (
      value?.includes(markerTitle) === true
      && value.includes(note)
      && value.includes(rangeTitle)
    ));
  }, {
    markerTitle: MARKER_TITLE,
    note: OPERATOR_NOTE,
    rangeTitle: RANGE_TITLE,
  });
}

test("unpacked release records UDP and preserves verifiable evidence across replacement", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const archivePath = configuredReleaseArchive();
  let installation: ReleaseInstallation | undefined;
  let server: RunningRelease | undefined;
  let replacementInstallation: ReleaseInstallation | undefined;
  let replacementServer: RunningRelease | undefined;

  try {
    installation = await unpackRelease(archivePath);
    server = await startRelease(installation);
    const appUrl = server.ready.appUrl;
    const originalPort = Number(new URL(appUrl).port);
    const releaseIdentity = { ...installation.identity };
    expect(originalPort).toBeGreaterThan(0);
    expect(releaseIdentity.version).toBe("0.3.0");
    expect(releaseIdentity.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(server.ready).toMatchObject(releaseIdentity);
    expect(new URL(server.ready.bridgeUrl).hostname).toBe("127.0.0.1");

    const datagrams = await releaseFixtureDatagrams(appUrl, DATAGRAM_COUNT);
    const sentBytes = datagrams.reduce((total, datagram) => total + datagram.byteLength, 0);

    await page.goto(appUrl);
    await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 })).toBeVisible();

    await page.getByRole("button", { name: /Live capture UDP or serial/ }).click();
    const captureDialog = page.getByRole("dialog", { name: "Record live telemetry" });
    await expect(captureDialog).toBeVisible();
    await expect(captureDialog.getByText(/Managed local bridge.*authenticated/i)).toBeVisible();
    await expect(captureDialog.getByLabel(/Bridge URL/)).toHaveCount(0);
    await expect(captureDialog.getByLabel("Bridge token", { exact: true })).toHaveCount(0);

    await captureDialog.getByLabel("Session title", { exact: true }).fill(CAPTURE_TITLE);
    await captureDialog.getByLabel(/Display timezone/).fill("UTC");
    await captureDialog.getByLabel("UDP bind host", { exact: true }).fill("127.0.0.1");
    await captureDialog.getByLabel(/UDP port/).fill("0");
    await captureDialog.getByRole("button", { name: "Run UDP preflight" }).click();
    await expect(captureDialog.getByRole("region", { name: "Preflight waiting for traffic" })).toBeVisible();
    const preflightPort = await boundUdpPort(captureDialog);
    await sendReleaseDatagrams(datagrams.slice(0, 2), preflightPort);
    await expect(captureDialog.getByRole("region", { name: "Preflight ready" })).toBeVisible();
    await captureDialog.getByRole("button", { name: "Start recording" }).click();
    await expect(captureDialog.getByRole("region", { name: "Recording" })).toBeVisible();

    const udpPort = await boundUdpPort(captureDialog);
    await sendReleaseDatagrams(datagrams, udpPort);
    await expect(captureDialog.getByText("Datagrams received", { exact: true }).locator(".."))
      .toContainText(String(DATAGRAM_COUNT));
    await expect(captureDialog.getByText("Input bytes", { exact: true }).locator(".."))
      .toContainText(`${sentBytes} B`);
    await expect(captureDialog.getByText("Records retained", { exact: true }).locator(".."))
      .toContainText(String(DATAGRAM_COUNT));

    const sessionDownloadPromise = page.waitForEvent("download");
    await captureDialog.getByRole("button", { name: "Stop, save & replay" }).click();
    const sessionDownload = await sessionDownloadPromise;
    expect(sessionDownload.suggestedFilename()).toMatch(/\.nlsession$/);
    const sessionPath = testInfo.outputPath("artifact-captured-session.nlsession");
    await sessionDownload.saveAs(sessionPath);

    const captureHeading = page.getByRole("heading", { name: CAPTURE_TITLE, level: 1 });
    await expect(captureHeading).toBeVisible();
    const savedSession = page.getByRole("button", {
      name: new RegExp(`^(?:Reopen current|Open) saved session ${CAPTURE_TITLE},`),
    });
    await expect(savedSession).toHaveCount(1);
    await expect(savedSession).toContainText("Verified");

    const document = JSON.parse(await readFile(sessionPath, "utf8")) as CapturedSession;
    expect(document).toMatchObject({
      title: CAPTURE_TITLE,
      formatVersion: 2,
      captureIntegrity: {
        status: "verified",
        assessmentBasis: "udp-bridge-reconciled",
        issueCodes: [],
      },
      transportProvenance: {
        status: "verified",
        transport: "udp",
      },
    });
    expect(document.records).toHaveLength(DATAGRAM_COUNT);
    expect(document.records.map((record) => record.dataHex.toLowerCase()))
      .toEqual(datagrams.map((datagram) => datagram.dataHex));
    expect(document.records.every((record) => (
      record.transport.kind === "udp"
      && record.transport.remoteEndpoint?.address === "127.0.0.1"
      && record.transport.remoteEndpoint.family === "IPv4"
    ))).toBe(true);

    const startRecord = document.records[2];
    const endRecord = document.records[8];
    if (!startRecord || !endRecord || endRecord.offsetUs <= startRecord.offsetUs) {
      throw new Error("The release capture did not retain enough ordered records for an exact range.");
    }
    expect(document.durationUs).toBeGreaterThan(endRecord.offsetUs);

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

    const markerOffsetUs = Math.round(
      ((startRecord.offsetUs + endRecord.offsetUs) / 2) / 10_000,
    ) * 10_000;
    expect(markerOffsetUs).toBeGreaterThan(startRecord.offsetUs);
    expect(markerOffsetUs).toBeLessThan(endRecord.offsetUs);
    await page.getByRole("button", { name: "Add marker" }).click();
    const markerDialog = page.getByRole("dialog", { name: "Add an operator marker" });
    await markerDialog.getByLabel(/^Offset from session start/)
      .fill((markerOffsetUs / 1_000_000).toFixed(2));
    await markerDialog.getByLabel("Title", { exact: true }).fill(MARKER_TITLE);
    await markerDialog.getByRole("combobox", { name: "Category" }).selectOption("observation");
    await markerDialog.getByLabel("Note", { exact: true })
      .fill("The artifact-only release gate placed this marker inside the selected range.");
    await markerDialog.getByRole("button", { name: "Add marker" }).click();
    await expect(page.getByRole("region", { name: "Session overview" })).toContainText("1 operator marker");

    const operatorNote = page.getByLabel("Session-wide operator note");
    await operatorNote.fill(OPERATOR_NOTE);
    await expect(operatorNote).toHaveValue(OPERATOR_NOTE);
    await expect.poll(() => workspaceIsDurable(page)).toBe(true);

    const bundlePanel = page.getByRole("region", { name: "Incident bundle preview" });
    await bundlePanel.getByRole("button", { name: "Create incident bundle" }).click();
    const bundleDialog = page.getByRole("dialog", { name: "Package this incident for handoff?" });
    const bundleDownloadPromise = page.waitForEvent("download");
    await bundleDialog.getByRole("button", { name: "Build and download" }).click();
    const bundleDownload = await bundleDownloadPromise;
    expect(bundleDownload.suggestedFilename()).toMatch(/\.nlb$/);
    const bundlePath = testInfo.outputPath("artifact-exact-range-evidence.nlb");
    await bundleDownload.saveAs(bundlePath);
    await expect(page.getByRole("dialog", { name: "Handoff archive is ready" })).toBeVisible();

    const report = await verifyBundleWithRelease(installation, bundlePath);
    expect(report).toMatchObject({
      integrity: "internally-consistent",
      evidence: "verified",
      captureEvidence: "verified",
      provenanceEvidence: "verified",
      authenticity: "not-established",
      session: {
        id: document.id,
        title: CAPTURE_TITLE,
      },
      selection: {
        startUs: startRecord.offsetUs,
        endUs: endRecord.offsetUs,
      },
    });
    expect(report.bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.bundle.bytes).toBeGreaterThan(0);
    expect(report.artifacts.count).toBeGreaterThan(0);

    await page.getByRole("dialog", { name: "Handoff archive is ready" })
      .getByRole("button", { name: "Return to session" })
      .click();
    await page.getByLabel("Choose a NarrowsLink evidence bundle").setInputFiles(bundlePath);
    const receiver = page.getByRole("main", { name: "Received incident evidence workspace" });
    await expect(receiver).toBeVisible({ timeout: 30_000 });
    await expect(receiver.getByRole("heading", { name: RANGE_TITLE, level: 1 })).toBeVisible();
    await expect(receiver.getByRole("region", { name: "Evidence verification claims" }))
      .toContainText("Internally Consistent");
    await expect(receiver.getByRole("region", { name: "Evidence verification claims" }))
      .toContainText("Verified");
    await receiver.getByRole("tab", { name: "notes" }).click();
    await expect(receiver.getByRole("tabpanel", { name: "notes" })).toContainText(OPERATOR_NOTE);
    await receiver.getByLabel("Receiver finding for this evidence bundle").fill(RECEIVER_NOTE);
    await expect(receiver.getByText("Stored separately", { exact: true })).toBeVisible();

    await receiver.getByRole("button", { name: "Compare", exact: true }).click();
    const comparisonSetup = page.getByRole("dialog", { name: "Define two bounded inputs" });
    await expect(comparisonSetup).toContainText("Verified evidence bundle");
    await comparisonSetup.locator("input[type='file']").setInputFiles(sessionPath);
    await expect(comparisonSetup).toContainText(CAPTURE_TITLE);
    await comparisonSetup.getByLabel("Shared event anchors").check();
    await comparisonSetup.getByLabel("Shared event label").fill("Exact authored-range start");
    await comparisonSetup.getByLabel("Baseline anchor (µs)").fill(String(startRecord.offsetUs));
    await comparisonSetup.getByLabel("Candidate anchor (µs)").fill(String(startRecord.offsetUs));
    await comparisonSetup.getByRole("button", { name: "Open comparison" }).click();

    const comparison = page.getByRole("main", { name: "Comparative telemetry evidence workspace" });
    await expect(comparison).toBeVisible();
    await expect(comparison.getByRole("region", { name: "Comparison eligibility" }))
      .toContainText("Bounded finding Unchanged");
    await expect(comparison.getByRole("region", { name: "Aligned comparison timeline" }))
      .toContainText("Exact authored-range start");
    const comparisonInspector = comparison.getByRole("complementary", { name: "Comparison finding inspector" });
    await comparisonInspector.getByLabel("Operator conclusion").fill(COMPARISON_CONCLUSION);
    const comparisonDownloadPromise = page.waitForEvent("download");
    await comparisonInspector.getByRole("button", { name: "Export finding" }).click();
    const comparisonDownload = await comparisonDownloadPromise;
    const comparisonPath = testInfo.outputPath("artifact-release-comparison.nlcompare.json");
    await comparisonDownload.saveAs(comparisonPath);
    const comparisonFinding = validateComparisonFinding(
      JSON.parse(await readFile(comparisonPath, "utf8")),
    ) as ComparisonFinding;
    expect(comparisonFinding).toMatchObject({
      assessment: "unchanged",
      conclusion: COMPARISON_CONCLUSION,
      inputs: {
        baseline: { kind: "evidence-bundle", sessionId: document.id },
        candidate: { kind: "session", sessionId: document.id },
      },
      alignment: {
        mode: "shared-event",
        label: "Exact authored-range start",
        baselineAnchorUs: startRecord.offsetUs,
        candidateAnchorUs: startRecord.offsetUs,
      },
    });
    await comparison.getByRole("button", { name: "Return", exact: true }).click();
    await expect(receiver).toBeVisible();

    await server.stop();
    server = undefined;
    await installation.remove();
    installation = undefined;

    replacementInstallation = await unpackRelease(archivePath);
    expect(replacementInstallation.identity).toEqual(releaseIdentity);
    replacementServer = await startRelease(replacementInstallation, originalPort);
    expect(replacementServer.ready.appUrl).toBe(appUrl);
    expect(replacementServer.ready).toMatchObject(releaseIdentity);

    await page.goto(replacementServer.ready.appUrl);
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

    await page.getByLabel("Choose a NarrowsLink evidence bundle").setInputFiles(bundlePath);
    const replacementReceiver = page.getByRole("main", { name: "Received incident evidence workspace" });
    await expect(replacementReceiver).toBeVisible({ timeout: 30_000 });
    await replacementReceiver.getByRole("tab", { name: "notes" }).click();
    await expect(replacementReceiver.getByLabel("Receiver finding for this evidence bundle"))
      .toHaveValue(RECEIVER_NOTE);
    expect(browserErrors).toEqual([]);
  } finally {
    await replacementServer?.stop().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    await replacementInstallation?.remove().catch(() => undefined);
    await installation?.remove().catch(() => undefined);
  }
});
