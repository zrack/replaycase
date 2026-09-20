import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { caseFixture } from "../fixtures/case";
import { verifyCaseArchive } from "../../verifier/case-verifier";

test("hands off a three-bundle case with exact citations and a reproduced comparison to a clean offline-local installation", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await caseFixture(1001);
  const files = fixture.bundles.map((bytes, index) => ({
    name: ["Baseline.nlb", "Failure.nlb", "Post-fix.nlb"][index]!,
    mimeType: "application/zip",
    buffer: Buffer.from(bytes),
  }));
  await page.goto("/");
  await page
    .getByLabel("Session-wide operator note", { exact: true })
    .fill("Retain the original replay investigation.");
  await page.getByRole("button", { name: "Cases", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Local cases", exact: true }),
  ).toBeFocused();
  await page.getByLabel("New case title").fill("Radio reset investigation");
  await page.getByRole("button", { name: "Create case", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Radio reset investigation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(
    page.getByLabel("Session-wide operator note", { exact: true }),
  ).toHaveValue("Retain the original replay investigation.");
  await page.getByRole("button", { name: "Cases", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Radio reset investigation" }),
  ).toBeVisible();
  await page.getByLabel("Choose case evidence bundles").setInputFiles(files);
  await expect(
    page.getByRole("region", { name: "Case evidence", exact: true }),
  ).toContainText("3 / 16");
  await page
    .getByLabel("Choose case evidence bundles")
    .setInputFiles(files[0]!);
  await expect(
    page.getByRole("status").filter({ hasText: "0 distinct bundles added" }),
  ).toContainText("0 distinct bundles added");
  await page.getByRole("button", { name: "New finding", exact: true }).click();
  await page.getByLabel("Entry type").selectOption("question");
  await page
    .getByLabel("Finding text")
    .fill(
      "Did the reset restore valid checksums without changing capture completeness?",
    );
  await page
    .getByRole("button", { name: "Inspect Baseline", exact: true })
    .click();
  await expect(
    page.getByRole("main", { name: "Received incident evidence workspace" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cases", exact: true }).click();
  await expect(page.getByLabel("Finding text")).toHaveValue(
    "Did the reset restore valid checksums without changing capture completeness?",
  );
  await page.getByLabel("Citation bundle").selectOption({ label: "Failure" });
  await page.getByRole("button", { name: "Add citation", exact: true }).click();
  await page.getByLabel("Citation kind").selectOption("record");
  await page.getByLabel("Exact evidence ID").fill("record-1");
  await page.getByRole("button", { name: "Add citation", exact: true }).click();
  await page
    .getByRole("button", { name: "Apply finding", exact: true })
    .click();
  await expect(page.getByText("Open question", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Failure: record-1", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Cited evidence" }),
  ).toContainText('"id": "record-1"');
  await page.getByRole("button", { name: "Close citation" }).click();
  await page
    .getByRole("button", { name: "Compare bundles", exact: true })
    .click();
  const setup = page.getByRole("dialog", { name: "Define two bounded inputs" });
  await setup
    .getByRole("button", { name: "Open comparison", exact: true })
    .click();
  await page
    .getByLabel("Operator conclusion")
    .fill(
      "The failure run introduced one checksum failure. Source authenticity remains unestablished.",
    );
  await page
    .getByRole("button", { name: "Add finding to case", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Finding added to the open case" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cases", exact: true }).click();
  await page.getByRole("button", { name: "Save case", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /^Case saved locally\.$/ }),
  ).toHaveText("Case saved locally.");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export case", exact: true }).click();
  const file = await downloaded;
  const path = testInfo.outputPath("radio-reset.nlcase");
  await file.saveAs(path);
  const original = verifyCaseArchive(new Uint8Array(await readFile(path)));
  expect(original.bundles.map((bundle) => bundle.bytes)).toEqual(
    fixture.bundles,
  );
  expect(original.manifest.findings[0]!.citations).toHaveLength(2);
  expect(original.manifest.comparisons).toHaveLength(1);
  expect(
    original.bundles.map(
      (bundle) => bundle.document.evidence.rawRecords.length,
    ),
  ).toEqual([1001, 1001, 1001]);
  await page.screenshot({
    path: testInfo.outputPath("case-desktop.png"),
    fullPage: true,
  });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations).toEqual([]);

  const receiver = await browser.newContext({ baseURL, acceptDownloads: true });
  const outbound: string[] = [];
  await receiver.route(/^https?:\/\//, (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(baseURL!).origin) return route.continue();
    outbound.push(url.origin);
    return route.abort();
  });
  try {
    const recipient = await receiver.newPage();
    recipient.on("pageerror", (error) => errors.push(error.message));
    await recipient.goto("/");
    await recipient.getByRole("button", { name: "Cases", exact: true }).click();
    await expect(
      recipient.getByText("No saved cases.", { exact: true }),
    ).toBeVisible();
    await recipient
      .getByLabel("Choose a ReplayCase case archive")
      .setInputFiles(path);
    await expect(
      recipient.getByRole("heading", {
        level: 1,
        name: "Radio reset investigation",
      }),
    ).toBeVisible();
    await expect(
      recipient.getByText(
        "Did the reset restore valid checksums without changing capture completeness?",
        { exact: true },
      ),
    ).toBeVisible();
    await recipient
      .getByRole("button", { name: "Open comparison", exact: true })
      .click();
    await expect(recipient.getByLabel("Operator conclusion")).toHaveValue(
      original.manifest.comparisons[0]!.conclusion,
    );
    await recipient.getByRole("button", { name: "Cases", exact: true }).click();
    await recipient
      .getByRole("button", { name: "Save case", exact: true })
      .click();
    await expect(
      recipient.getByRole("status").filter({ hasText: /^Case saved locally\.$/ }),
    ).toHaveText("Case saved locally.");
    await recipient.reload();
    await recipient.getByRole("button", { name: "Cases", exact: true }).click();
    await recipient
      .getByRole("button", { name: /Radio reset investigation 3 bundles/ })
      .click();
    await expect(
      recipient.getByRole("heading", {
        level: 1,
        name: "Radio reset investigation",
      }),
    ).toBeVisible();
    const secondDownload = recipient.waitForEvent("download");
    await recipient
      .getByRole("button", { name: "Export case", exact: true })
      .click();
    const receivedFile = await secondDownload;
    const receivedPath = testInfo.outputPath("received.nlcase");
    await receivedFile.saveAs(receivedPath);
    expect(new Uint8Array(await readFile(receivedPath))).toEqual(
      original.archive,
    );
    await recipient.setViewportSize({ width: 390, height: 844 });
    expect(
      await recipient.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await recipient.screenshot({
      path: testInfo.outputPath("case-mobile.png"),
      fullPage: true,
    });
    await recipient
      .getByLabel("Choose a ReplayCase case archive")
      .setInputFiles({
        name: "invalid.nlcase",
        mimeType: "application/zip",
        buffer: Buffer.from("not an archive"),
      });
    await expect(recipient.getByRole("alert")).toBeVisible();
    await expect(
      recipient.getByRole("heading", {
        level: 1,
        name: "Radio reset investigation",
      }),
    ).toBeVisible();
    expect(outbound).toEqual([]);
  } finally {
    await receiver.close();
  }
  expect(errors).toEqual([]);
});

test("keeps a case usable after quota failure and cancellation without persisting or downloading partial state", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "cases")
        throw new DOMException("Test quota", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Cases", exact: true }).click();
  await page.getByLabel("New case title").fill("Retained case");
  await page.getByRole("button", { name: "Create case", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Retained case", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Case title", { exact: true })
    .fill("  Retained case  ");
  await page
    .getByRole("button", { name: "Apply details", exact: true })
    .click();
  await expect(page.getByLabel("Case title", { exact: true })).toHaveValue(
    "Retained case",
  );
  await expect(
    page.getByRole("button", { name: "Save case", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Save case", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Local case storage is full",
  );
  await expect(
    page.getByText("No saved cases.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss case error" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export case", exact: true }).click();
  const file = await download;
  const path = testInfo.outputPath("retained-case.nlcase");
  await file.saveAs(path);
  expect(
    verifyCaseArchive(new Uint8Array(await readFile(path))).manifest.title,
  ).toBe("Retained case");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/case\.worker/, async (route) => {
    await held;
    await route.abort().catch(() => undefined);
  });
  const downloads: string[] = [];
  page.on("download", (item) => downloads.push(item.suggestedFilename()));
  await page.getByRole("button", { name: "Export case", exact: true }).click();
  await expect(
    page.getByRole("progressbar", { name: "Case processing progress" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  release();
  await expect(
    page.getByRole("status").filter({ hasText: "Operation canceled" }),
  ).toContainText("Operation canceled");
  await expect(
    page.getByRole("heading", { name: "Retained case", exact: true }),
  ).toBeVisible();
  expect(downloads).toEqual([]);
});
