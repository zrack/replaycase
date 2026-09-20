import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

import { caseFixture } from "../../tests/fixtures/case";
import {
  buildCaseArchive,
  verifyCaseArchive,
} from "../../verifier/case-verifier";
import { sha256Hex } from "../domain/canonical";
import type { CaseRequest } from "../cases/case-processing";
import { createCaseLibrary } from "./case-library";

async function verify(request: CaseRequest) {
  if (request.kind !== "import") throw new Error("Unexpected test operation");
  if (
    request.expectedHash &&
    sha256Hex(request.archive) !== request.expectedHash
  )
    throw new Error("Stored case checksum mismatch.");
  return verifyCaseArchive(request.archive);
}
async function fixture() {
  const factory = new IDBFactory();
  const { content, bundles } = await caseFixture();
  const value = buildCaseArchive(content, bundles);
  const library = createCaseLibrary({
    indexedDB: factory,
    databaseName: "case-test",
    verify,
  });
  return { factory, content, bundles, value, library };
}
async function alter(
  factory: IDBFactory,
  id: string,
  mutate: (record: { bytes: ArrayBuffer; entry: { title: string } }) => void,
) {
  await new Promise<void>((resolve, reject) => {
    const open = factory.open("case-test", 1);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction("cases", "readwrite");
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error);
      };
      const store = transaction.objectStore("cases");
      const read = store.get(id);
      read.onsuccess = () => {
        const record = read.result;
        mutate(record);
        store.put(record);
      };
    };
  });
}

describe("case library", () => {
  it("cancels before opening storage and never reports a committed save", async () => {
    const { value } = await fixture();
    const controller = new AbortController();
    const factory = new IDBFactory();
    const open = vi.spyOn(factory, "open");
    const library = createCaseLibrary({
      indexedDB: factory,
      verify: async (request) => {
        const checked = await verify(request);
        controller.abort();
        return checked;
      },
    });
    await expect(
      library.save(value, null, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(open).not.toHaveBeenCalled();
  });
  it("commits, re-verifies, deduplicates, updates and removes a complete case", async () => {
    const { library, value, content, bundles } = await fixture();
    await library.save(value, null);
    await library.save(value, null);
    expect(await library.list()).toHaveLength(1);
    expect((await library.load(content.id)).archive).toEqual(value.archive);
    const revised = buildCaseArchive(
      { ...content, title: "Revised investigation" },
      bundles,
    );
    await library.save(revised, value.archiveHash);
    expect((await library.load(content.id)).manifest.title).toBe(
      "Revised investigation",
    );
    await library.remove(content.id, revised.archiveHash);
    expect(await library.list()).toEqual([]);
    await expect(library.load(content.id)).rejects.toThrow(/missing/);
    expect(value.bundles).toHaveLength(3);
  });

  it("does not overwrite or remove a concurrent revision", async () => {
    const { library, value, content, bundles } = await fixture();
    await library.save(value, null);
    const revised = buildCaseArchive(
      { ...content, title: "Concurrent revision" },
      bundles,
    );
    await expect(library.save(revised, null)).rejects.toThrow(
      /different revision/,
    );
    await library.save(revised, value.archiveHash);
    await expect(library.save(value, value.archiveHash)).rejects.toThrow(
      /different revision/,
    );
    await expect(library.remove(content.id, value.archiveHash)).rejects.toThrow(
      /changed/,
    );
    expect((await library.load(content.id)).archiveHash).toBe(
      revised.archiveHash,
    );
  });

  it("rejects corrupt bytes and metadata without silently repairing them", async () => {
    const { library, value, factory, content } = await fixture();
    await library.save(value, null);
    await alter(factory, content.id, (record) => {
      const bytes = new Uint8Array(record.bytes);
      bytes[30] = (bytes[30] ?? 0) ^ 1;
    });
    await expect(library.load(content.id)).rejects.toThrow(/checksum/);
    await expect(library.save(value, null)).rejects.toThrow(/checksum|corrupt/);
    const other = await fixture();
    await other.library.save(other.value, null);
    await alter(other.factory, other.content.id, (record) => {
      record.entry.title = "False title";
    });
    await expect(other.library.load(other.content.id)).rejects.toThrow(
      /metadata/,
    );
  });

  it("surfaces unavailable storage, quota exhaustion and transaction aborts", async () => {
    const { library, value } = await fixture();
    await expect(
      createCaseLibrary({ indexedDB: null, verify }).save(value, null),
    ).rejects.toThrow(/unavailable/);
    const original = IDBObjectStore.prototype.put;
    const quota = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(() => {
        throw new DOMException("Full", "QuotaExceededError");
      });
    await expect(library.save(value, null)).rejects.toThrow(/full/);
    quota.mockRestore();
    const abort = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (this: IDBObjectStore, ...args) {
        const result = original.apply(this, args);
        result.onsuccess = () => this.transaction.abort();
        return result;
      });
    await expect(library.save(value, null)).rejects.toThrow(
      /transaction failed/,
    );
    abort.mockRestore();
    expect(await library.list()).toEqual([]);
  });

  it("verifies input bytes before allowing a write", async () => {
    const { library, value } = await fixture();
    const corrupt = { ...value, archive: Uint8Array.from(value.archive) };
    corrupt.archive[50] = (corrupt.archive[50] ?? 0) ^ 1;
    await expect(library.save(corrupt, null)).rejects.toThrow(/checksum/);
    expect(await library.list()).toEqual([]);
  });
});
