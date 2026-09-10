import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { resolve } from "node:path";

const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const DEMO_SESSION_PATH = resolve("public/fixtures/harbor-relay-session.json");

async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(
    results.violations,
    JSON.stringify(results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target),
    })), null, 2),
  ).toEqual([]);
}

async function expectPageFitsViewport(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))).toEqual({ body: 0, root: 0 });
}

async function expectArrowScrolls(region: Locator): Promise<void> {
  await region.evaluate((element) => { element.scrollLeft = 0; });
  await region.focus();
  await expect(region).toBeFocused();
  await region.press("ArrowRight");
  await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
}

async function createDemoEvidenceBundle(page: Page, testInfo: TestInfo): Promise<string> {
  await page.getByRole("button", { name: "Create incident bundle", exact: true }).first().click();
  const bundleDialog = page.getByRole("dialog", { name: "Package this incident for handoff?" });
  const downloadPromise = page.waitForEvent("download");
  await bundleDialog.getByRole("button", { name: "Build and download" }).click();
  const download = await downloadPromise;
  const bundlePath = testInfo.outputPath("accessibility-receiver.nlb");
  await download.saveAs(bundlePath);
  await page.getByRole("dialog", { name: "Handoff archive is ready" })
    .getByRole("button", { name: "Return to session" })
    .click();
  return bundlePath;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Harbor relay downlink", level: 1 })).toBeVisible();
});

test("workspace and critical dialogs pass axe rules tagged WCAG A and AA", async ({ page }) => {
  await expectNoAxeViolations(page);

  await page.getByRole("button", { name: /^Live capture UDP or serial/ }).click();
  const captureDialog = page.getByRole("dialog", { name: "Record live telemetry" });
  await expect(captureDialog.getByLabel("Session title", { exact: true })).toBeFocused();
  await expectNoAxeViolations(page);
  await captureDialog.getByRole("button", { name: "Close live capture dialog" }).click();

  await page.getByRole("button", { name: "New range" }).click();
  const rangeDialog = page.getByRole("dialog", { name: "Define an incident range" });
  await expect(rangeDialog.getByLabel("Title", { exact: true })).toBeFocused();
  await expectNoAxeViolations(page);
  await rangeDialog.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Add marker" }).click();
  const markerDialog = page.getByRole("dialog", { name: "Add an operator marker" });
  await expect(markerDialog.getByLabel(/^Offset from session start/)).toBeFocused();
  await expectNoAxeViolations(page);
  await markerDialog.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Create incident bundle" }).first().click();
  const bundleDialog = page.getByRole("dialog", { name: "Package this incident for handoff?" });
  await expect(bundleDialog.getByRole("button", { name: "Build and download" })).toBeFocused();
  await expectNoAxeViolations(page);
  await bundleDialog.getByRole("button", { name: "Cancel" }).click();
});

test("keyboard focus survives dialogs, authored-range deletion, and incident replacement", async ({ page }) => {
  const captureOpener = page.getByRole("button", { name: /^Live capture UDP or serial/ });
  await captureOpener.focus();
  await captureOpener.press("Enter");
  const captureDialog = page.getByRole("dialog", { name: "Record live telemetry" });
  await expect(captureDialog.getByLabel("Session title", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(captureOpener).toBeFocused();

  const narrativeTab = page.getByRole("tab", { name: "narrative" });
  await narrativeTab.focus();
  await narrativeTab.press("ArrowRight");
  const detailsTab = page.getByRole("tab", { name: "details" });
  await expect(detailsTab).toBeFocused();
  await expect(detailsTab).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "New range" }).click();
  const createDialog = page.getByRole("dialog", { name: "Define an incident range" });
  await createDialog.getByLabel("Title", { exact: true }).fill("Accessibility focus range");
  await createDialog.getByRole("button", { name: "Create range" }).click();
  await expect(page.getByRole("heading", { name: "Accessibility focus range", level: 2 })).toBeVisible();

  await page.getByRole("button", { name: "Edit operator range" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit incident range" });
  const requestDelete = editDialog.getByRole("button", { name: "Delete local range" });
  await requestDelete.click();
  const keepRange = editDialog.getByRole("button", { name: "Keep range" });
  await expect(keepRange).toBeFocused();
  await keepRange.click();
  await expect(requestDelete).toBeFocused();
  await requestDelete.click();
  await expect(keepRange).toBeFocused();
  await editDialog.getByRole("button", { name: "Delete range", exact: true }).click();
  await expect(page.getByLabel("Selected incident")).toBeFocused();

  await page.getByRole("button", { name: "Clear incident" }).click();
  const emptyHeading = page.getByRole("heading", { name: "No incident selected" });
  await expect(emptyHeading).toBeFocused();
  await page.getByRole("button", { name: "Select first incident" }).click();
  await expect(page.getByLabel("Selected incident")).toBeFocused();

  await expect(page.locator(".overview-incident-hit[aria-pressed='true']")).toHaveCount(1);
  await expect(page.locator(".diagnostic-severity").first()).toBeVisible();
  await expect(page.locator(".timeline-diagnostic-severity").first()).toBeVisible();
});

test("narrow and 200-percent-equivalent layouts reflow while wide evidence remains keyboard scrollable", async ({ page }) => {
  for (const viewport of [
    { width: 960, height: 900 },
    { width: 640, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expectPageFitsViewport(page);
    await expect(page.locator(".header-actions")).toHaveCSS("flex-wrap", "wrap");
    for (const action of [
      page.getByRole("button", { name: /^Saved \(/ }),
      page.getByRole("button", { name: "Capture", exact: true }),
      page.getByRole("button", { name: "Open replay", exact: true }),
      page.getByRole("button", { name: "Play replay", exact: true }),
      page.getByRole("button", { name: "Add marker", exact: true }),
      page.getByRole("button", { name: "Create incident bundle", exact: true }).first(),
    ]) {
      await expect(action).toBeVisible();
    }
  }

  const timeline = page.locator(".timeline-panel.keyboard-scroll-region");
  await expect(timeline).toHaveAttribute("aria-describedby", "timeline-keyboard-scroll-instructions");
  await expectArrowScrolls(timeline);

  const evidenceTable = page.getByRole("region", { name: "Scrollable evidence bundle contents" });
  await expect(evidenceTable).toHaveAttribute("aria-describedby", "bundle-table-keyboard-scroll-instructions");
  await expectArrowScrolls(evidenceTable);

  await page.emulateMedia({ forcedColors: "active" });
  const selectedIncident = page.locator(".overview-incident-hit[aria-pressed='true']");
  await expect(selectedIncident).toHaveCount(1);
  await expect(selectedIncident).toHaveCSS("outline-style", "solid");
  await expect(selectedIncident).toHaveCSS("outline-width", "2px");
  await expect(page.locator(".diagnostic-severity").first()).toBeVisible();
});

test("packet-family heading stays above readable family labels at every layout breakpoint", async ({ page }, testInfo) => {
  for (const viewport of [
    { width: 1487, height: 1058 },
    { width: 1220, height: 900 },
    { width: 1060, height: 980 },
    { width: 960, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const heading = await page.locator(".families-lane .lane-label strong").boundingBox();
    const label = await page.locator(".families-lane .lane-label").boundingBox();
    const firstFamily = await page.locator(".family-row > span").first().boundingBox();
    expect(heading).not.toBeNull();
    expect(label).not.toBeNull();
    expect(firstFamily).not.toBeNull();
    if (!heading || !label || !firstFamily) throw new Error("Packet-family labels are missing.");
    expect(heading.y + heading.height).toBeLessThanOrEqual(firstFamily.y);
    expect(heading.x + heading.width).toBeLessThanOrEqual(label.x + label.width);
    await expectPageFitsViewport(page);
    await page.screenshot({ path: testInfo.outputPath(`packet-families-${viewport.width}.png`), fullPage: true });
  }
});

test("received evidence passes axe and remains bounded at narrow widths", async ({ page }, testInfo) => {
  const bundlePath = await createDemoEvidenceBundle(page, testInfo);
  await page.getByLabel("Choose a NarrowsLink evidence bundle").setInputFiles(bundlePath);
  const receiver = page.getByRole("main", { name: "Received incident evidence workspace" });
  await expect(receiver).toBeVisible({ timeout: 30_000 });
  await expectNoAxeViolations(page);

  for (const viewport of [
    { width: 960, height: 900 },
    { width: 640, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expectPageFitsViewport(page);
    await expect(receiver.getByRole("region", { name: "Evidence verification claims" })).toBeVisible();
    await expect(receiver.getByRole("region", { name: "Received incident timeline" })).toBeVisible();
    await expect(receiver.getByRole("button", { name: "Open replay", exact: true })).toBeVisible();
    await expect(receiver.getByRole("button", { name: "Open evidence", exact: true })).toBeVisible();
  }

  const evidenceRows = receiver.getByRole("region", { name: "Scrollable received evidence rows" });
  await expect(evidenceRows).toBeVisible();
  await expectArrowScrolls(evidenceRows);
});

test("comparison setup and evidence remain accessible across narrow layouts", async ({ page }) => {
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  const setup = page.getByRole("dialog", { name: "Define two bounded inputs" });
  await expect(setup.getByRole("heading", { name: "Define two bounded inputs" })).toBeFocused();
  await expectNoAxeViolations(page);
  await setup.locator("input[type='file']").setInputFiles(DEMO_SESSION_PATH);
  await expect(setup).toContainText("Candidate incident");
  await expectNoAxeViolations(page);
  await setup.getByRole("button", { name: "Open comparison" }).click();

  const comparison = page.getByRole("main", { name: "Comparative telemetry evidence workspace" });
  await expect(comparison).toBeVisible();
  await expectNoAxeViolations(page);
  for (const viewport of [
    { width: 960, height: 900 },
    { width: 640, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expectPageFitsViewport(page);
    await expect(comparison.getByRole("region", { name: "Comparison eligibility" })).toBeVisible();
    await expect(comparison.getByRole("region", { name: "Aligned comparison timeline" })).toBeVisible();
    await expect(comparison.getByRole("complementary", { name: "Comparison finding inspector" })).toBeVisible();
    await expect(comparison.getByRole("button", { name: "New comparison", exact: true }).last()).toBeVisible();
  }

  const metrics = comparison.getByRole("region", { name: "Scrollable comparison measures" });
  await expect(metrics).toHaveAttribute("aria-describedby", "comparison-table-scroll-instructions");
  await expectArrowScrolls(metrics);
});
