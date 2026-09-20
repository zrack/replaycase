import { z } from "zod";

import { CASE_LIMITS, type VerifiedCase } from "../domain/case";
import {
  caseCancelled,
  processCase,
  type CaseProcessingOptions,
} from "../cases/case-processing";

export const CASE_LIBRARY_DB = "replaycase-case-library";
const entrySchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(240),
    updatedAt: z.string().datetime(),
    archiveHash: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.number().int().positive().max(CASE_LIMITS.archiveBytes),
    bundleCount: z.number().int().nonnegative().max(CASE_LIMITS.bundles),
  })
  .strict();
export type CaseLibraryEntry = z.infer<typeof entrySchema>;
interface StoredCase {
  version: 1;
  entry: CaseLibraryEntry;
  bytes: ArrayBuffer;
}
export interface CaseLibrary {
  list(): Promise<CaseLibraryEntry[]>;
  load(id: string, options?: CaseProcessingOptions): Promise<VerifiedCase>;
  save(
    value: VerifiedCase,
    expectedHash: string | null,
    options?: CaseProcessingOptions,
  ): Promise<void>;
  remove(id: string, expectedHash: string): Promise<void>;
}

function metadata(value: VerifiedCase): CaseLibraryEntry {
  return {
    id: value.manifest.id,
    title: value.manifest.title,
    updatedAt: value.manifest.updatedAt,
    archiveHash: value.archiveHash,
    byteLength: value.archive.byteLength,
    bundleCount: value.manifest.bundles.length,
  };
}
function stored(input: unknown): StoredCase {
  const record = input as StoredCase | undefined;
  if (
    !record ||
    record.version !== 1 ||
    !(record.bytes instanceof ArrayBuffer) ||
    record.bytes.byteLength > CASE_LIMITS.archiveBytes
  )
    throw new Error("Stored case is missing, incompatible, or corrupt.");
  entrySchema.parse(record.entry);
  if (record.bytes.byteLength !== record.entry.byteLength)
    throw new Error("Stored case size does not match its metadata.");
  return record;
}
function failure(error: unknown): Error {
  if (error instanceof Error && error.name === "QuotaExceededError")
    return new Error(
      "Local case storage is full. The in-memory case remains open; export it before leaving.",
    );
  return error instanceof Error
    ? error
    : new Error("Local case storage transaction failed.");
}

export function createCaseLibrary(
  options: {
    indexedDB?: IDBFactory | null;
    databaseName?: string;
    verify?: typeof processCase;
  } = {},
): CaseLibrary {
  const verify = options.verify ?? processCase;
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        const factory =
          options.indexedDB === undefined
            ? globalThis.indexedDB
            : options.indexedDB;
        if (!factory)
          throw new Error(
            "IndexedDB is unavailable. Cases cannot be saved locally.",
          );
        request = factory.open(options.databaseName ?? CASE_LIBRARY_DB, 1);
      } catch (error) {
        reject(failure(error));
        return;
      }
      let settled = false;
      request.onupgradeneeded = () =>
        request.result.createObjectStore("cases", { keyPath: "entry.id" });
      request.onblocked = () => {
        settled = true;
        reject(
          new Error(
            "Case storage is blocked by another window. Close that window and retry.",
          ),
        );
      };
      request.onerror = () => {
        settled = true;
        reject(failure(request.error));
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  async function transaction<T>(
    mode: IDBTransactionMode,
    operation: (
      store: IDBObjectStore,
      result: (value: T) => void,
      fail: (error: unknown) => void,
    ) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    const database = await open();
    try {
      if (signal?.aborted) throw caseCancelled();
      return await new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = database.transaction("cases", mode);
        } catch (error) {
          reject(failure(error));
          return;
        }
        let value: T;
        let operationError: unknown;
        const fail = (error: unknown) => {
          operationError = error;
          try {
            tx.abort();
          } catch {
            reject(failure(error));
          }
        };
        const cancel = () => fail(caseCancelled());
        signal?.addEventListener("abort", cancel, { once: true });
        tx.oncomplete = () => {
          signal?.removeEventListener("abort", cancel);
          resolve(value);
        };
        tx.onabort = () => {
          signal?.removeEventListener("abort", cancel);
          reject(failure(operationError ?? tx.error));
        };
        tx.onerror = () => {};
        try {
          operation(
            tx.objectStore("cases"),
            (result) => {
              value = result;
            },
            fail,
          );
        } catch (error) {
          fail(error);
        }
      });
    } finally {
      database.close();
    }
  }
  const readStored = (id: string) =>
    transaction<StoredCase | null>("readonly", (store, result, fail) => {
      const request = store.get(id);
      request.onsuccess = () => {
        try {
          result(request.result === undefined ? null : stored(request.result));
        } catch (error) {
          fail(error);
        }
      };
    });
  return {
    async list() {
      return transaction<CaseLibraryEntry[]>(
        "readonly",
        (store, result, fail) => {
          const entries: CaseLibraryEntry[] = [];
          const request = store.openCursor();
          request.onsuccess = () => {
            try {
              if (!request.result) {
                result(
                  entries.sort((a, b) =>
                    b.updatedAt.localeCompare(a.updatedAt),
                  ),
                );
                return;
              }
              entries.push(stored(request.result.value).entry);
              request.result.continue();
            } catch (error) {
              fail(error);
            }
          };
        },
      );
    },
    async load(id, processingOptions) {
      const record = await transaction<StoredCase>(
        "readonly",
        (store, result, fail) => {
          const request = store.get(id);
          request.onsuccess = () => {
            try {
              result(stored(request.result));
            } catch (error) {
              fail(error);
            }
          };
        },
      );
      const value = await verify(
        {
          kind: "import",
          archive: new Uint8Array(record.bytes),
          expectedHash: record.entry.archiveHash,
        },
        processingOptions,
      );
      const expected = metadata(value);
      if (
        id !== expected.id ||
        Object.keys(expected).some(
          (key) =>
            expected[key as keyof CaseLibraryEntry] !==
            record.entry[key as keyof CaseLibraryEntry],
        )
      )
        throw new Error(
          "Stored case metadata does not match the verified archive.",
        );
      return value;
    },
    async save(value, expectedHash, processingOptions = {}) {
      if (value.archive.byteLength > CASE_LIMITS.archiveBytes)
        throw new Error("Case exceeds the 64 MiB storage limit.");
      const checked = await verify(
        {
          kind: "import",
          archive: value.archive,
          expectedHash: value.archiveHash,
        },
        {
          ...processingOptions,
          onProgress: (progress) =>
            processingOptions.onProgress?.({
              ...progress,
              percent: Math.floor(progress.percent / 2),
            }),
        },
      );
      const entry = entrySchema.parse(metadata(checked));
      if (JSON.stringify(entry) !== JSON.stringify(metadata(value)))
        throw new Error("Case metadata does not match its verified archive.");
      if (processingOptions.signal?.aborted) throw caseCancelled();
      const bytes = Uint8Array.from(value.archive).buffer;
      const previous = await readStored(entry.id);
      const previousBytes = previous ? new Uint8Array(previous.bytes) : null;
      if (previous) {
        const prior = await verify(
          {
            kind: "import",
            archive: new Uint8Array(previous.bytes),
            expectedHash: previous.entry.archiveHash,
          },
          {
            ...processingOptions,
            onProgress: (progress) =>
              processingOptions.onProgress?.({
                ...progress,
                percent: 50 + Math.floor(progress.percent * 0.45),
              }),
          },
        );
        if (JSON.stringify(metadata(prior)) !== JSON.stringify(previous.entry))
          throw new Error("Existing case metadata is corrupt.");
      }
      if (processingOptions.signal?.aborted) throw caseCancelled();
      processingOptions.onProgress?.({
        percent: 98,
        message: "Committing verified case",
      });
      await transaction<void>(
        "readwrite",
        (store, result, fail) => {
          const request = store.get(entry.id);
          request.onsuccess = () => {
            try {
              const existing =
                request.result === undefined ? null : stored(request.result);
              if (
                (existing?.entry.archiveHash ?? null) !==
                (previous?.entry.archiveHash ?? null)
              )
                throw new Error(
                  "The saved case changed during verification. Reopen it before saving.",
                );
              if (
                existing &&
                previous &&
                (existing.bytes.byteLength !== previous.bytes.byteLength ||
                  !new Uint8Array(existing.bytes).every(
                    (byte, index) => byte === previousBytes?.[index],
                  ) ||
                  JSON.stringify(existing.entry) !==
                    JSON.stringify(previous.entry))
              )
                throw new Error(
                  "Existing case changed or became corrupt during verification.",
                );
              if (existing?.entry.archiveHash === entry.archiveHash) {
                if (
                  !new Uint8Array(existing.bytes).every(
                    (byte, index) => byte === value.archive[index],
                  ) ||
                  existing.bytes.byteLength !== bytes.byteLength
                )
                  throw new Error(
                    "Existing case bytes are corrupt; refusing to overwrite them.",
                  );
                if (JSON.stringify(existing.entry) !== JSON.stringify(entry))
                  throw new Error("Existing case metadata is corrupt.");
                result();
                return;
              }
              if ((existing?.entry.archiveHash ?? null) !== expectedHash)
                throw new Error(
                  "A different revision of this case is already saved. Reopen it or export this revision; no case was overwritten.",
                );
              store.put({ version: 1, entry, bytes } satisfies StoredCase);
              result();
            } catch (error) {
              fail(error);
            }
          };
        },
        processingOptions.signal,
      );
      processingOptions.onProgress?.({
        percent: 100,
        message: "Case saved locally",
      });
    },
    async remove(id, expectedHash) {
      await transaction<void>("readwrite", (store, result, fail) => {
        const request = store.get(id);
        request.onsuccess = () => {
          try {
            const current = stored(request.result);
            if (current.entry.archiveHash !== expectedHash)
              throw new Error(
                "The saved case changed. Refresh the case list before removing it.",
              );
            store.delete(id);
            result();
          } catch (error) {
            fail(error);
          }
        };
      });
    },
  };
}
