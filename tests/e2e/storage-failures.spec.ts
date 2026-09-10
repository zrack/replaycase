import { expect, test, type Page } from "@playwright/test";

async function expectReplayRemainsUsable(page: Page, title = "Harbor relay downlink"): Promise<void> {
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("button", { name: "Play replay" }).click();
  await expect(page.getByRole("button", { name: "Pause replay" })).toBeVisible();
  await page.getByRole("button", { name: "Pause replay" }).click();
}

test("keeps replay usable when IndexedDB is unavailable", async ({ page }) => {
  await page.addInitScript({
    content: "Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });",
  });
  await page.goto("/");

  await expect(page.getByText("The local session library is unavailable in this browser. The active replay remains usable.").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Save current replay/ })).toHaveCount(0);
  await expectReplayRemainsUsable(page);
});

test("surfaces quota failure without replacing the active replay", async ({ page }) => {
  await page.addInitScript({
    content: `
      const originalAdd = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args) {
        if (this.name === 'sessions') throw new DOMException('Quota exceeded', 'QuotaExceededError');
        return Reflect.apply(originalAdd, this, args);
      };
    `,
  });
  await page.goto("/");

  await page.getByRole("button", { name: /Save current replay/ }).click();
  await expect(page.getByText("Browser storage is full. Remove a saved replay or free site storage, then try again.").first()).toBeVisible();
  await expectReplayRemainsUsable(page);
});

test("rejects corrupt stored bytes without changing the active replay", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Save current replay/ }).click();
  await expect(page.locator(".saved-session-entry")).toHaveCount(1);

  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("narrowslink-session-library");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("sessions", "readwrite");
        const store = transaction.objectStore("sessions");
        const records = store.getAll();
        records.onerror = () => reject(records.error);
        records.onsuccess = () => {
          const record = records.result[0] as Record<string, unknown> | undefined;
          if (!record) {
            reject(new Error("Expected one saved session"));
            return;
          }
          store.put(record.recordVersion === 3
            ? { ...record, canonicalBytes: new TextEncoder().encode("{").buffer }
            : record.recordVersion === 2
              ? { ...record, canonicalBlob: new Blob(["{"]) }
              : { ...record, serialized: "{" });
        };
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      };
    });
  });

  await page.getByRole("button", { name: /Reopen current saved session Harbor relay downlink/ }).click();
  const corruptDialog = page.getByRole("dialog", { name: "Harbor relay downlink was not opened" });
  await expect(corruptDialog).toContainText("The saved replay failed its content or validation checks and was not opened.");
  await expect(corruptDialog).toContainText("No partial session was opened or persisted.");
  await corruptDialog.getByRole("button", { name: "Return to workspace" }).click();
  await expectReplayRemainsUsable(page);
});

test("warns when workspace cleanup fails and keeps the in-memory investigation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Save current replay/ }).click();
  await expect(page.locator(".saved-session-entry")).toHaveCount(1);
  // Saving schedules a focus handoff after the library row renders.
  await expect(page.getByRole("button", { name: /Reopen current saved session Harbor relay downlink/ })).toBeFocused();
  await page.getByLabel("Session-wide operator note").fill("Residual cleanup warning proof");
  await expect(page.getByLabel("Session-wide operator note")).toHaveValue("Residual cleanup warning proof");

  await page.evaluate(() => {
    Storage.prototype.removeItem = function (): never {
      throw new DOMException("Storage removal failed", "InvalidStateError");
    };
  });

  await page.getByRole("button", { name: "Remove saved session Harbor relay downlink" }).click();
  await page.getByRole("group", { name: "Confirm removal of Harbor relay downlink" }).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("The replay was removed, but its separately stored operator workspace could not be fully cleared. Browser storage may still contain markers, notes, or incident ranges.").first()).toBeVisible();
  await expect(page.locator(".saved-session-entry")).toHaveCount(0);
  await expect(page.getByLabel("Session-wide operator note")).toHaveValue("Residual cleanup warning proof");
  await expectReplayRemainsUsable(page);
});

test("recovers from a failed bundle download without losing the active replay", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const target = globalThis as typeof globalThis & { __narrowslinkCreateObjectUrl?: typeof URL.createObjectURL };
    target.__narrowslinkCreateObjectUrl = URL.createObjectURL;
    URL.createObjectURL = () => {
      throw new DOMException("Download unavailable", "InvalidStateError");
    };
  });

  await page.getByRole("region", { name: "Incident bundle preview" }).getByRole("button", { name: "Create incident bundle" }).click();
  const dialog = page.getByRole("dialog", { name: "Package this incident for handoff?" });
  await dialog.getByRole("button", { name: "Build and download" }).click();
  await expect(page.getByRole("heading", { name: "The archive was not created" })).toBeVisible();

  await page.evaluate(() => {
    const target = globalThis as typeof globalThis & { __narrowslinkCreateObjectUrl?: typeof URL.createObjectURL };
    if (target.__narrowslinkCreateObjectUrl) URL.createObjectURL = target.__narrowslinkCreateObjectUrl;
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Try again" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.nlb$/);
  await page.getByRole("button", { name: "Return to session" }).click();
  await expectReplayRemainsUsable(page);
});
