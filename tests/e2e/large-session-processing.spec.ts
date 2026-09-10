import { execFile } from "node:child_process";
import { access, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import { LARGE_SESSION_SUPPORT_TIER } from "../../src/domain/limits";
import { verifyEvidenceBundle } from "./support/archive";

const execFileAsync = promisify(execFile);
const LARGE_SESSION_TITLE = "NarrowsLink scale acceptance - 200,000 records";
const LARGE_SESSION_ID = "narrowslink-scale-acceptance-200k";
const LARGE_SESSION_RECORDS = 200_000;
const LARGE_RANGE_RECORDS = 10_000;
const LARGE_SESSION_PATH = path.join(
  process.cwd(),
  "output",
  "large-session",
  "scale-acceptance-200k.nlsession",
);

interface HeartbeatReport {
  readonly ticks: number;
  readonly maximumGapMs: number;
  readonly delayedMs: number;
  readonly delayRatio: number;
  readonly elapsedMs: number;
  readonly heapStartBytes: number | null;
  readonly heapEndBytes: number | null;
  readonly heapGrowthBytes: number | null;
}

interface ScaleReport {
  readonly browser: string;
  readonly sourceBytes: number;
  readonly recordCount: number;
  readonly import: HeartbeatReport;
  readonly reopen: HeartbeatReport;
  readonly comparisonAndBundle: HeartbeatReport;
}

test.describe.configure({ timeout: 360_000 });

test.beforeAll(async () => {
  try {
    await access(LARGE_SESSION_PATH);
  } catch {
    await execFileAsync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts", "large-session-corpus.mjs"),
        "--output",
        LARGE_SESSION_PATH,
      ],
      { cwd: process.cwd() },
    );
  }
});

function savedSessions(page: Page) {
  return page.locator(".saved-sessions");
}

async function sessionLibraryRecords(page: Page): Promise<Array<{
  recordVersion: number;
  identity: string;
  byteLength: number;
  storedBytes: number | null;
}>> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("narrowslink-session-library");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const records = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const transaction = database.transaction("sessions", "readonly");
        const request = transaction.objectStore("sessions").getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
      });
      return records.map((record) => ({
        recordVersion: Number(record.recordVersion),
        identity: String(record.identity),
        byteLength: Number(record.byteLength),
        storedBytes: record.canonicalBytes instanceof ArrayBuffer
          ? record.canonicalBytes.byteLength
          : record.canonicalBlob instanceof Blob
            ? record.canonicalBlob.size
            : null,
      }));
    } finally {
      database.close();
    }
  });
}

async function startHeartbeat(
  page: Page,
  options: { onNextReplayFileChange?: boolean } = {},
): Promise<void> {
  await page.evaluate(({ onNextReplayFileChange, heartbeatIntervalMs }) => {
    const scope = globalThis as typeof globalThis & {
      __narrowslinkScaleHeartbeat?: {
        timer: number;
        startedAt: number;
        previousAt: number;
        ticks: number;
        maximumGapMs: number;
        delayedMs: number;
        heapStartBytes: number | null;
      };
    };
    const begin = () => {
      const memory = (
        performance as Performance & {
          memory?: { usedJSHeapSize?: number };
        }
      ).memory;
      const startedAt = performance.now();
      const heartbeat = {
        timer: 0,
        startedAt,
        previousAt: startedAt,
        ticks: 0,
        maximumGapMs: 0,
        delayedMs: 0,
        heapStartBytes: typeof memory?.usedJSHeapSize === "number"
          ? memory.usedJSHeapSize
          : null,
      };
      heartbeat.timer = window.setInterval(() => {
        const now = performance.now();
        const gapMs = now - heartbeat.previousAt;
        heartbeat.maximumGapMs = Math.max(
          heartbeat.maximumGapMs,
          gapMs,
        );
        heartbeat.delayedMs += Math.max(0, gapMs - heartbeatIntervalMs);
        heartbeat.previousAt = now;
        heartbeat.ticks += 1;
      }, heartbeatIntervalMs);
      scope.__narrowslinkScaleHeartbeat = heartbeat;
    };
    if (onNextReplayFileChange) {
      const input = document.querySelector<HTMLInputElement>(
        "input[aria-label='Choose a local ReplayCase replay']",
      );
      if (!input) throw new Error("The replay file input is unavailable.");
      input.addEventListener("change", begin, { capture: true, once: true });
    } else {
      begin();
    }
  }, {
    ...options,
    heartbeatIntervalMs: LARGE_SESSION_SUPPORT_TIER.heartbeatIntervalMs,
  });
}

async function stopHeartbeat(page: Page): Promise<HeartbeatReport> {
  return page.evaluate((heartbeatIntervalMs) => {
    const scope = globalThis as typeof globalThis & {
      __narrowslinkScaleHeartbeat?: {
        timer: number;
        startedAt: number;
        previousAt: number;
        ticks: number;
        maximumGapMs: number;
        delayedMs: number;
        heapStartBytes: number | null;
      };
    };
    const heartbeat = scope.__narrowslinkScaleHeartbeat;
    if (!heartbeat) throw new Error("The large-session heartbeat was not started.");
    window.clearInterval(heartbeat.timer);
    const endedAt = performance.now();
    const memory = (
      performance as Performance & {
        memory?: { usedJSHeapSize?: number };
      }
    ).memory;
    const heapEndBytes = typeof memory?.usedJSHeapSize === "number"
      ? memory.usedJSHeapSize
      : null;
    const heapGrowthBytes = heartbeat.heapStartBytes === null || heapEndBytes === null
      ? null
      : Math.max(0, heapEndBytes - heartbeat.heapStartBytes);
    const finalGapMs = endedAt - heartbeat.previousAt;
    const delayedMs = heartbeat.delayedMs + Math.max(0, finalGapMs - heartbeatIntervalMs);
    const elapsedMs = endedAt - heartbeat.startedAt;
    delete scope.__narrowslinkScaleHeartbeat;
    return {
      ticks: heartbeat.ticks,
      maximumGapMs: Math.max(
        heartbeat.maximumGapMs,
        finalGapMs,
      ),
      delayedMs,
      delayRatio: elapsedMs === 0 ? 0 : Math.min(1, delayedMs / elapsedMs),
      elapsedMs,
      heapStartBytes: heartbeat.heapStartBytes,
      heapEndBytes,
      heapGrowthBytes,
    };
  }, LARGE_SESSION_SUPPORT_TIER.heartbeatIntervalMs);
}

function assertResponsive(report: HeartbeatReport): void {
  expect(report.ticks).toBeGreaterThan(0);
  expect(report.maximumGapMs).toBeLessThanOrEqual(
    LARGE_SESSION_SUPPORT_TIER.maxMainThreadHeartbeatGapMs,
  );
  expect(report.delayRatio).toBeLessThanOrEqual(
    LARGE_SESSION_SUPPORT_TIER.maxMainThreadDelayRatio,
  );
  if (report.heapGrowthBytes !== null) {
    expect(report.heapGrowthBytes).toBeLessThanOrEqual(
      LARGE_SESSION_SUPPORT_TIER.maxChromiumHeapGrowthBytes,
    );
  }
}

async function chromiumHeapBytes(
  page: Page,
  testInfo: TestInfo,
): Promise<number | null> {
  if (testInfo.project.name !== "chromium") return null;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Performance.enable");
    const response = await session.send("Performance.getMetrics") as {
      metrics?: Array<{ name?: string; value?: number }>;
    };
    const metric = response.metrics?.find((candidate) => (
      candidate.name === "JSHeapUsedSize"
    ));
    return typeof metric?.value === "number" ? metric.value : null;
  } finally {
    await session.detach();
  }
}

function withHeapMeasurement(
  report: HeartbeatReport,
  heapStartBytes: number | null,
  heapEndBytes: number | null,
): HeartbeatReport {
  if (heapStartBytes === null || heapEndBytes === null) return report;
  return {
    ...report,
    heapStartBytes,
    heapEndBytes,
    heapGrowthBytes: Math.max(0, heapEndBytes - heapStartBytes),
  };
}

async function recordScaleReport(
  testInfo: TestInfo,
  report: ScaleReport,
): Promise<void> {
  const reportPath = testInfo.outputPath("large-session-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await testInfo.attach("large-session-report", {
    path: reportPath,
    contentType: "application/json",
  });
}

test("canceling a maximum-tier import preserves the open replay and persists nothing", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The full support-tier path runs in every browser; cancellation is exercised once against the same worker contract.");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 }))
    .toBeVisible();

  await page.getByLabel("Choose a local ReplayCase replay")
    .setInputFiles(LARGE_SESSION_PATH);
  const processingDialog = page.getByRole("dialog", {
    name: /Processing scale-acceptance-200k\.nlsession/,
  });
  await expect(processingDialog).toBeVisible();
  const accessibility = await new AxeBuilder({ page })
    .include(".replay-processing-dialog")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await processingDialog.getByRole("button", { name: "Cancel processing" }).click();

  await expect(processingDialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 }))
    .toBeVisible();
  await expect(savedSessions(page).locator(".saved-session-entry")).toHaveCount(0);
  expect(await sessionLibraryRecords(page)).toEqual([]);
});

test("processes, reopens, compares, and exports the 200,000-record support tier", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 }))
    .toBeVisible();

  const importHeapStart = await chromiumHeapBytes(page, testInfo);
  await startHeartbeat(page, { onNextReplayFileChange: true });
  await page.getByLabel("Choose a local ReplayCase replay")
    .setInputFiles(LARGE_SESSION_PATH);
  await expect(page.getByRole("dialog", {
    name: /Processing scale-acceptance-200k\.nlsession/,
  })).toBeVisible();
  await expect(page.getByRole("heading", { name: LARGE_SESSION_TITLE, level: 1 }))
    .toBeVisible({ timeout: 240_000 });
  await expect(savedSessions(page).locator(".saved-session-entry")).toHaveCount(1, {
    timeout: 60_000,
  });
  const importReport = withHeapMeasurement(
    await stopHeartbeat(page),
    importHeapStart,
    await chromiumHeapBytes(page, testInfo),
  );
  assertResponsive(importReport);

  await expect(page.locator(".session-info").getByText(
    LARGE_SESSION_RECORDS.toLocaleString("en-US"),
    { exact: true },
  )).toBeVisible();
  const records = await sessionLibraryRecords(page);
  const sourceFile = await stat(LARGE_SESSION_PATH);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    recordVersion: 3,
    byteLength: sourceFile.size,
    storedBytes: sourceFile.size,
  });
  expect(records[0]?.identity).toMatch(/^sha256:[0-9a-f]{64}$/);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 }))
    .toBeVisible();
  const savedLargeReplay = savedSessions(page).getByRole("button", {
    name: new RegExp(`Open saved session ${LARGE_SESSION_TITLE}`),
  });
  await savedLargeReplay.click();
  const libraryProcessingDialog = page.getByRole("dialog", {
    name: `Processing ${LARGE_SESSION_TITLE}`,
  });
  await expect(libraryProcessingDialog).toBeVisible();
  await libraryProcessingDialog.getByRole("button", { name: "Cancel processing" })
    .click();
  await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 }))
    .toBeVisible();
  await expect(savedSessions(page).locator(".saved-session-entry")).toHaveCount(1);

  const reopenHeapStart = await chromiumHeapBytes(page, testInfo);
  await startHeartbeat(page);
  await savedLargeReplay.click();
  await expect(libraryProcessingDialog).toBeVisible();
  await expect(page.getByRole("heading", { name: LARGE_SESSION_TITLE, level: 1 }))
    .toBeVisible({ timeout: 240_000 });
  const reopenReport = withHeapMeasurement(
    await stopHeartbeat(page),
    reopenHeapStart,
    await chromiumHeapBytes(page, testInfo),
  );
  assertResponsive(reopenReport);

  await page.getByRole("button", { name: "Compare", exact: true }).click();
  const setup = page.getByRole("dialog", { name: "Define two bounded inputs" });
  await setup.locator("input[type='file']").setInputFiles(LARGE_SESSION_PATH);
  await expect(setup).toContainText(LARGE_SESSION_TITLE, { timeout: 240_000 });
  const comparisonAndBundleHeapStart = await chromiumHeapBytes(page, testInfo);
  await startHeartbeat(page);
  await setup.getByRole("button", { name: "Open comparison" }).click();
  const comparison = page.getByRole("main", {
    name: "Comparative telemetry evidence workspace",
  });
  await expect(comparison).toBeVisible({ timeout: 60_000 });
  await expect(comparison.getByRole("region", { name: "Comparison eligibility" }))
    .toContainText("Bounded finding");
  await comparison.locator(".comparison-topbar").getByRole("button", { name: "Return" })
    .click();
  await expect(page.getByRole("heading", { name: LARGE_SESSION_TITLE, level: 1 }))
    .toBeVisible();

  const bundlePanel = page.getByRole("region", { name: "Incident bundle preview" });
  await bundlePanel.getByRole("button", { name: "Create incident bundle" }).click();
  const bundleDialog = page.getByRole("dialog", {
    name: "Package this incident for handoff?",
  });
  let observedDownloads = 0;
  page.on("download", () => {
    observedDownloads += 1;
  });
  await bundleDialog.getByRole("button", { name: "Build and download" }).click();
  await expect(page.getByRole("button", { name: "Cancel construction" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel construction" }).click();
  const canceledBundleDialog = page.getByRole("dialog", {
    name: "No archive was created",
  });
  await expect(canceledBundleDialog).toBeVisible();
  expect(observedDownloads).toBe(0);

  const bundleDownloadPromise = page.waitForEvent("download", { timeout: 240_000 });
  await canceledBundleDialog.getByRole("button", { name: "Build again" }).click();
  const bundleDownload = await bundleDownloadPromise;
  const bundlePath = testInfo.outputPath("large-session-incident.nlb");
  await bundleDownload.saveAs(bundlePath);
  const comparisonAndBundleReport = withHeapMeasurement(
    await stopHeartbeat(page),
    comparisonAndBundleHeapStart,
    await chromiumHeapBytes(page, testInfo),
  );
  assertResponsive(comparisonAndBundleReport);

  const verified = await verifyEvidenceBundle(bundlePath);
  expect(verified.manifest.session.id).toBe(LARGE_SESSION_ID);
  expect(verified.rawRecords).toHaveLength(LARGE_RANGE_RECORDS);
  expect(verified.decodedRecordCount).toBe(LARGE_RANGE_RECORDS);
  expect(verified.report.integrity).toBe("internally-consistent");
  expect(browserErrors).toEqual([]);

  await recordScaleReport(testInfo, {
    browser: testInfo.project.name,
    sourceBytes: records[0]?.byteLength ?? 0,
    recordCount: LARGE_SESSION_RECORDS,
    import: importReport,
    reopen: reopenReport,
    comparisonAndBundle: comparisonAndBundleReport,
  });
});
