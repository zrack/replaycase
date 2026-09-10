import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

const importedTitle = "E2E imported harbor replay";

async function importedFixture(): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const fixturePath = path.join(process.cwd(), "public/fixtures/harbor-relay-session.json");
  const document = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  document.id = "e2e-imported-harbor-replay";
  document.title = importedTitle;
  return {
    name: "e2e-imported-harbor-replay.nlsession",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  };
}

function savedSessions(page: Page) {
  return page.locator(".saved-sessions");
}

test("recovers from invalid import and preserves a deduplicated investigation workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Harbor relay downlink" })).toBeVisible();
  const fileInput = page.getByLabel("Choose a local ReplayCase replay");

  await fileInput.setInputFiles({
    name: "broken.nlsession",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  const invalidDialog = page.getByRole("dialog", { name: "broken.nlsession was not opened" });
  await expect(invalidDialog).toContainText("The selected file is not valid JSON.");
  await expect(invalidDialog).toContainText("No partial session was opened or persisted.");
  await invalidDialog.getByRole("button", { name: "Return to workspace" }).click();
  await expect(page.getByRole("heading", { name: "Harbor relay downlink" })).toBeVisible();

  const fixture = await importedFixture();
  await fileInput.setInputFiles(fixture);
  await expect(page.getByRole("heading", { name: importedTitle })).toBeVisible();
  await expect(savedSessions(page).locator(".saved-session-entry")).toHaveCount(1);

  await page.getByLabel("Replay speed").selectOption("4");
  await page.getByRole("button", { name: "Play replay" }).click();
  await expect(page.getByRole("button", { name: "Pause replay" })).toBeVisible();
  await page.getByRole("button", { name: "Pause replay" }).click();

  const rangeOpener = page.getByRole("button", { name: "New range" });
  await rangeOpener.click();
  const rangeDialog = page.getByRole("dialog", { name: "Define an incident range" });
  await rangeDialog.getByLabel("Title").fill("E2E persisted incident");
  await rangeDialog.getByRole("button", { name: "Create range" }).click();
  await expect(page.getByRole("combobox", { name: "Selected incident" })).toHaveValue(/operator-/);

  await page.getByRole("button", { name: "Add marker" }).click();
  const markerDialog = page.getByRole("dialog", { name: "Add an operator marker" });
  await markerDialog.getByLabel("Title").fill("E2E persisted marker");
  await markerDialog.getByLabel("Note", { exact: true }).fill("Marker retained across reopen.");
  await markerDialog.getByRole("button", { name: "Add marker" }).click();

  const operatorNote = page.getByLabel("Session-wide operator note");
  await operatorNote.fill("E2E persisted operator note");

  await fileInput.setInputFiles(fixture);
  await expect(page.getByRole("heading", { name: importedTitle })).toBeVisible();
  await expect(savedSessions(page).locator(".saved-session-entry")).toHaveCount(1);
  await expect(operatorNote).toHaveValue("E2E persisted operator note");
  await expect(page.getByRole("combobox", { name: "Selected incident" })).toContainText("E2E persisted incident");
  await expect(page.getByRole("region", { name: "Session overview" })).toContainText("1 operator marker");

  await page.reload();
  await expect(savedSessions(page).locator(".saved-session-entry")).toHaveCount(1);
  await savedSessions(page).getByRole("button", { name: new RegExp(`Open saved session ${importedTitle}`) }).click();
  await expect(page.getByRole("heading", { name: importedTitle })).toBeVisible();
  await expect(page.getByLabel("Session-wide operator note")).toHaveValue("E2E persisted operator note");
  await expect(page.getByRole("combobox", { name: "Selected incident" })).toContainText("E2E persisted incident");

  await savedSessions(page).getByRole("button", { name: `Remove saved session ${importedTitle}` }).click();
  const confirmation = savedSessions(page).getByRole("group", { name: `Confirm removal of ${importedTitle}` });
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirmation.getByRole("button", { name: "Remove" }).click();

  await expect(savedSessions(page).locator(".saved-session-entry")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: importedTitle })).toBeVisible();
  await expect(page.getByLabel("Session-wide operator note")).toHaveValue("E2E persisted operator note");
  await expect(page.getByText("Removed from browser storage; save this replay again to persist the visible workspace")).toBeVisible();
});
