import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

import { caseFixture } from "../fixtures/case";
import { buildCaseArchive } from "../../verifier/case-verifier";
import {
  startRelease,
  unpackRelease,
  type RunningRelease,
} from "./support/release";

test("installed application verifies, saves, reopens and re-exports a portable case without a source checkout", async ({
  page,
}, testInfo) => {
  const installation = await unpackRelease();
  let runtime: RunningRelease | undefined;
  try {
    runtime = await startRelease(installation);
    const { content, bundles } = await caseFixture();
    const source = buildCaseArchive(content, bundles);
    await page.goto(runtime.ready.appUrl);
    await page.getByRole("button", { name: "Cases", exact: true }).click();
    await page
      .getByLabel("Choose a ReplayCase case archive")
      .setInputFiles({
        name: "installed.nlcase",
        mimeType: "application/zip",
        buffer: Buffer.from(source.archive),
      });
    await expect(
      page.getByRole("heading", { level: 1, name: content.title }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Save case", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: /^Case saved locally\.$/ }),
    ).toHaveText("Case saved locally.");
    await page.reload();
    await page.getByRole("button", { name: "Cases", exact: true }).click();
    await page
      .getByRole("button", { name: /Radio reset investigation 3 bundles/ })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: content.title }),
    ).toBeVisible();
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Export case", exact: true })
      .click();
    const file = await download;
    const path = testInfo.outputPath("installed-roundtrip.nlcase");
    await file.saveAs(path);
    expect(new Uint8Array(await readFile(path))).toEqual(source.archive);
  } finally {
    await runtime?.stop();
    await installation.remove();
  }
});
