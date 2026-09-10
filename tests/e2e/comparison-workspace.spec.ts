import { readFile } from "node:fs/promises";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { bytesToHex, encodeFrame } from "../../src/domain/decoder";
import {
  validateComparisonFinding,
  type ComparisonFinding,
} from "../../src/domain/comparison";
import {
  startLoopbackBridge,
  type LoopbackBridge,
} from "./support/bridge";

interface CapturedSession {
  id: string;
  title: string;
  durationUs: number;
  records: Array<{
    id: string;
    offsetUs: number;
    dataHex: string;
  }>;
  decoder: {
    id: string;
    revision: string;
    schemaHash: string;
  };
  captureIntegrity: {
    status: string;
    assessmentBasis: string;
    issueCodes: string[];
  };
}

const BASELINE_TITLE = "Controlled clean link";
const CANDIDATE_TITLE = "Controlled checksum impairment";
const CONCLUSION = "The candidate regressed on packet integrity in the aligned real-capture overlap; link signal remains unresolved because the laptop capture had no RSSI sidecar.";
let activeBridge: LoopbackBridge | undefined;

test.afterEach(async () => {
  await activeBridge?.close();
  activeBridge = undefined;
});

function controlledDatagrams(corruptIndex: number | null): string[] {
  return Array.from({ length: 10 }, (_, index) => bytesToHex(encodeFrame({
    familyId: 0x02,
    sequence: index + 1,
    deviceTimeMs: index * 100,
    payload: new Uint8Array(8),
    corruptChecksum: index === corruptIndex,
  })));
}

async function captureUdpSession(
  page: Page,
  testInfo: TestInfo,
  title: string,
  dataHex: readonly string[],
  fileName: string,
): Promise<{ path: string; document: CapturedSession; bridge: LoopbackBridge }> {
  const bridge = await startLoopbackBridge();
  activeBridge = bridge;
  await page.getByRole("button", { name: /Live capture UDP or serial/ }).click();
  const dialog = page.getByRole("dialog", { name: "Record live telemetry" });
  await dialog.getByLabel("Session title", { exact: true }).fill(title);
  await dialog.getByLabel(/Display timezone/).fill("UTC");
  await dialog.getByLabel(/Bridge URL/).fill(bridge.controlUrl);
  await dialog.getByLabel("Bridge token", { exact: true }).fill(bridge.token);
  await dialog.getByLabel("UDP bind host", { exact: true }).fill("127.0.0.1");
  await dialog.getByLabel(/UDP port/).fill("0");
  await dialog.getByRole("button", { name: "Run UDP preflight" }).click();
  await bridge.waitForStatus((status) => status.state === "capturing" && (status.udp?.port ?? 0) > 0);
  await bridge.sendFixtureDatagrams({ count: 1 });
  await expect(dialog.getByRole("region", { name: "Preflight ready" })).toBeVisible();
  await dialog.getByRole("button", { name: "Start recording" }).click();
  await expect(dialog.getByRole("region", { name: "Recording" })).toBeVisible();
  await bridge.waitForStatus((status) => status.state === "capturing" && (status.udp?.port ?? 0) > 0);

  const sent = await bridge.sendDatagrams(dataHex, { intervalMs: 55 });
  await bridge.waitForStatus((status) => status.capture?.datagrams === sent.length);
  await bridge.waitForStatus((status) => (status.capture?.durationUs ?? 0) >= 650_000);
  await expect(dialog.getByText("Records retained", { exact: true }).locator(".."))
    .toContainText(String(sent.length));

  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Stop, save & replay" }).click();
  const download = await downloadPromise;
  const path = testInfo.outputPath(fileName);
  await download.saveAs(path);
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  const document = JSON.parse(await readFile(path, "utf8")) as CapturedSession;
  expect(document.records.map((record) => record.dataHex.toLowerCase())).toEqual(
    dataHex.map((value) => value.toLowerCase()),
  );
  expect(document.captureIntegrity).toEqual(expect.objectContaining({
    status: "verified",
    assessmentBasis: "udp-bridge-reconciled",
    issueCodes: [],
  }));
  return { path, document, bridge };
}

test("compares controlled real captures and exports a verified regression finding", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 })).toBeVisible();

  const baselineCapture = await captureUdpSession(
    page,
    testInfo,
    BASELINE_TITLE,
    controlledDatagrams(null),
    "comparison-baseline.nlsession",
  );
  await baselineCapture.bridge.close();
  activeBridge = undefined;

  const candidateCapture = await captureUdpSession(
    page,
    testInfo,
    CANDIDATE_TITLE,
    controlledDatagrams(5),
    "comparison-candidate.nlsession",
  );
  expect(candidateCapture.document.decoder).toEqual(baselineCapture.document.decoder);
  expect(candidateCapture.document.records).toHaveLength(baselineCapture.document.records.length);

  const bundlePanel = page.getByRole("region", { name: "Incident bundle preview" });
  await bundlePanel.getByRole("button", { name: "Create incident bundle" }).click();
  const bundleDialog = page.getByRole("dialog", { name: "Package this incident for handoff?" });
  const bundleDownloadPromise = page.waitForEvent("download");
  await bundleDialog.getByRole("button", { name: "Build and download" }).click();
  const bundleDownload = await bundleDownloadPromise;
  const bundlePath = testInfo.outputPath("comparison-candidate.nlb");
  await bundleDownload.saveAs(bundlePath);
  await page.getByRole("dialog", { name: "Handoff archive is ready" })
    .getByRole("button", { name: "Return to session" })
    .click();
  await candidateCapture.bridge.close();
  activeBridge = undefined;

  await page.getByLabel("Choose a local ReplayCase replay").setInputFiles(baselineCapture.path);
  await expect(page.getByRole("heading", { name: BASELINE_TITLE, level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  const setup = page.getByRole("dialog", { name: "Define two bounded inputs" });
  await expect(setup).toContainText(BASELINE_TITLE);
  await setup.locator("input[type='file']").setInputFiles(bundlePath);
  await expect(setup).toContainText(CANDIDATE_TITLE, { timeout: 30_000 });
  await expect(setup).toContainText("Verified evidence bundle");
  await setup.getByRole("button", { name: "Open comparison" }).click();

  const workspace = page.getByRole("main", { name: "Comparative telemetry evidence workspace" });
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole("region", { name: "Comparison eligibility" }))
    .toContainText("Capture evidence Comparable");
  await expect(workspace.getByRole("region", { name: "Comparison eligibility" }))
    .toContainText("Bounded finding Regressed");
  await expect(workspace.getByRole("region", { name: "Aligned comparison timeline" }))
    .toContainText("Selected range starts");

  const integrityRow = workspace.getByRole("row", { name: /Integrity failures/ });
  await expect(integrityRow).toContainText("Regressed");
  await expect(integrityRow).toContainText("0 failures/s");
  await integrityRow.getByRole("button", { name: "Integrity failures" }).click();
  const inspector = workspace.getByRole("complementary", { name: "Comparison finding inspector" });
  await expect(inspector).toContainText("Candidate evidence IDs");
  await expect(inspector.locator(".comparison-evidence-ids").filter({ hasText: "Candidate evidence IDs" }))
    .toContainText("frame-");
  await inspector.getByLabel("Operator conclusion").fill(CONCLUSION);

  const findingDownloadPromise = page.waitForEvent("download");
  await inspector.getByRole("button", { name: "Export finding" }).click();
  const findingDownload = await findingDownloadPromise;
  expect(findingDownload.suggestedFilename()).toMatch(/\.nlcompare\.json$/);
  const findingPath = testInfo.outputPath("controlled-regression.nlcompare.json");
  await findingDownload.saveAs(findingPath);
  const finding = validateComparisonFinding(
    JSON.parse(await readFile(findingPath, "utf8")),
  ) as ComparisonFinding;

  expect(finding).toMatchObject({
    format: "narrowslink/comparison-finding",
    formatVersion: 1,
    assessment: "regressed",
    conclusion: CONCLUSION,
    inputs: {
      baseline: {
        kind: "session",
        sessionId: baselineCapture.document.id,
        range: { rangeSemantics: "half-open [startUs, endUs)" },
        captureEvidence: {
          status: "verified",
          assessmentBasis: "udp-bridge-reconciled",
          evidenceCompleteness: "verified",
        },
      },
      candidate: {
        kind: "evidence-bundle",
        sessionId: candidateCapture.document.id,
        range: { rangeSemantics: "half-open [startUs, endUs)" },
        captureEvidence: {
          status: "verified",
          assessmentBasis: "udp-bridge-reconciled",
          evidenceCompleteness: "verified",
        },
      },
    },
    alignment: {
      mode: "range-start",
      label: "Selected range starts",
    },
  });
  expect(finding.inputs.baseline.identity).not.toBe(finding.inputs.candidate.identity);
  expect(finding.metrics.find((metric) => metric.id === "integrity-failure-rate")).toEqual(
    expect.objectContaining({
      status: "comparable",
      baseline: 0,
      direction: "increased",
      assessment: "regressed",
    }),
  );
  expect(finding.limitations).toContain(
    "Alignment is operator-declared; ReplayCase does not infer synchronized source clocks.",
  );

  await workspace.locator(".comparison-topbar").getByRole("button", { name: "New comparison" }).click();
  const replacementSetup = page.getByRole("dialog", { name: "Define two bounded inputs" });
  await replacementSetup.locator("input[type='file']").setInputFiles(bundlePath);
  await expect(replacementSetup).toContainText("Controlled checksum impairment");
  await replacementSetup.getByRole("button", { name: "Open comparison" }).click();
  await expect(page.getByLabel("Operator conclusion")).toHaveValue("");
  expect(browserErrors).toEqual([]);
});
