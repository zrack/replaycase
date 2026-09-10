import {
  encodeSessionDocument,
  MAX_SESSION_FILE_BYTES,
  serializeSessionDocument,
  utf8ByteLength,
} from "../data/session-file";
import { validateSessionDocument } from "../domain/session";
import type { CaptureIntegrityReceipt, ParsedSession, SessionDocument } from "../domain/types";
import type { SessionProcessingProgress } from "../processing/contracts";
import {
  processSessionBlob,
  SessionProcessingCancelledError,
} from "../processing/process-session";
import { canonicalSessionArtifact } from "../processing/session-artifact";

export const SESSION_LIBRARY_DB_NAME = "narrowslink-session-library";
export const SESSION_LIBRARY_DB_VERSION = 2;
export const SESSION_LIBRARY_STORE_NAME = "sessions";

const SESSION_LIBRARY_RECORD_VERSION = 3;
const BLOB_SESSION_LIBRARY_RECORD_VERSION = 2;
const LEGACY_SESSION_LIBRARY_RECORD_VERSION = 1;

export type SessionLibraryErrorCode =
  | "unavailable"
  | "not-found"
  | "corrupt"
  | "too-large"
  | "quota"
  | "write-failed"
  | "transaction-failed"
  | "open-failed";

export class SessionLibraryError extends Error {
  readonly code: SessionLibraryErrorCode;

  constructor(code: SessionLibraryErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionLibraryError";
    this.code = code;
  }
}

export interface SessionLibraryEntry {
  readonly identity: string;
  readonly sessionId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly displayTimeZone: string;
  readonly durationUs: number;
  readonly formatVersion: 1 | 2;
  readonly sourceKind: SessionDocument["source"]["kind"];
  readonly sourceLabel: string;
  readonly decoderId: string;
  readonly decoderRevision: string;
  readonly decoderSchemaHash: string;
  readonly captureIntegrityStatus: CaptureIntegrityReceipt["status"];
  readonly recordCount: number;
  readonly byteLength: number;
  readonly savedAt: string;
}

export interface SessionLibrary {
  save(source: SessionDocument | ParsedSession): Promise<SessionLibraryEntry>;
  list(): Promise<SessionLibraryEntry[]>;
  load(identity: string, options?: SessionLibraryLoadOptions): Promise<ParsedSession>;
  remove(identity: string): Promise<void>;
}

export interface SessionLibraryLoadOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SessionProcessingProgress) => void;
}

export interface SessionLibraryOptions {
  /** Pass null to explicitly disable persistence, or a separate factory to isolate tests. */
  indexedDB?: IDBFactory | null;
  /** Primarily useful for isolated tests and future migrations. */
  databaseName?: string;
  now?: () => Date;
}

interface LegacyStoredSessionRecord extends SessionLibraryEntry {
  readonly recordVersion: typeof LEGACY_SESSION_LIBRARY_RECORD_VERSION;
  readonly serialized: string;
}

interface StoredSessionRecordV2 extends SessionLibraryEntry {
  readonly recordVersion: typeof BLOB_SESSION_LIBRARY_RECORD_VERSION;
  readonly canonicalBlob: Blob;
}

interface StoredSessionRecordV3 extends SessionLibraryEntry {
  readonly recordVersion: typeof SESSION_LIBRARY_RECORD_VERSION;
  readonly canonicalBytes: ArrayBuffer;
}

type StoredSessionRecord =
  | LegacyStoredSessionRecord
  | StoredSessionRecordV2
  | StoredSessionRecordV3;

type FailureCode = Extract<SessionLibraryErrorCode, "transaction-failed" | "write-failed">;

const identityPattern = /^sha256:[0-9a-f]{64}$/;

function defaultIndexedDB(): IDBFactory | null {
  try {
    return typeof globalThis.indexedDB === "undefined" ? null : globalThis.indexedDB;
  } catch {
    return null;
  }
}

function errorName(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("name" in error)) return null;
  return typeof error.name === "string" ? error.name : null;
}

function isQuotaError(error: unknown): boolean {
  return errorName(error) === "QuotaExceededError";
}

function storageFailure(code: FailureCode, message: string, error: unknown): SessionLibraryError {
  if (error instanceof SessionLibraryError) return error;
  if (isQuotaError(error)) {
    return new SessionLibraryError("quota", "The local session library is out of storage space.", error);
  }
  return new SessionLibraryError(code, message, error);
}

function unavailable(message: string, cause?: unknown): SessionLibraryError {
  return new SessionLibraryError("unavailable", message, cause);
}

function factoryFrom(options: SessionLibraryOptions): IDBFactory {
  const factory = options.indexedDB === undefined ? defaultIndexedDB() : options.indexedDB;
  if (!factory) {
    throw unavailable("IndexedDB is unavailable; this browser cannot persist a local session library.");
  }
  return factory;
}

async function contentIdentity(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw unavailable("Web Crypto SHA-256 is unavailable; ReplayCase cannot identify session content safely.");
  }

  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `sha256:${hex}`;
  } catch (error) {
    throw unavailable("Web Crypto could not calculate the session content identity.", error);
  }
}

/** Returns the stable content identity used as the durable library key. */
export function sessionLibraryIdentity(source: SessionDocument | ParsedSession): Promise<string> {
  if ("document" in source) {
    const artifact = canonicalSessionArtifact(source);
    if (artifact) return Promise.resolve(artifact.identity);
    return contentIdentity(encodeSessionDocument(validateSessionDocument(source.document)));
  }
  return contentIdentity(encodeSessionDocument(validateSessionDocument(source)));
}

function openDatabase(factory: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, SESSION_LIBRARY_DB_VERSION);
    } catch (error) {
      const code = errorName(error) === "SecurityError" ? "unavailable" : "open-failed";
      reject(new SessionLibraryError(code, "ReplayCase could not open the local session library.", error));
      return;
    }

    let settled = false;
    let upgradeError: unknown;
    const fail = (error: SessionLibraryError): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.onupgradeneeded = () => {
      try {
        const database = request.result;
        const store = database.objectStoreNames.contains(SESSION_LIBRARY_STORE_NAME)
          ? request.transaction?.objectStore(SESSION_LIBRARY_STORE_NAME)
          : database.createObjectStore(SESSION_LIBRARY_STORE_NAME, { keyPath: "identity" });
        if (!store) throw new Error("The session-library upgrade transaction is unavailable.");
        if (!store.indexNames.contains("savedAt")) store.createIndex("savedAt", "savedAt", { unique: false });
      } catch (error) {
        upgradeError = error;
        request.transaction?.abort();
      }
    };
    request.onerror = () => {
      fail(new SessionLibraryError(
        "open-failed",
        "ReplayCase could not open the local session library.",
        upgradeError ?? request.error,
      ));
    };
    request.onblocked = () => {
      fail(new SessionLibraryError(
        "open-failed",
        "The local session library is blocked by another ReplayCase window.",
      ));
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
}

function requestResult<T>(
  request: IDBRequest<T>,
  code: FailureCode,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(storageFailure(code, message, request.error));
  });
}

function startRequest<T>(
  start: () => IDBRequest<T>,
  code: FailureCode,
  message: string,
): Promise<T> {
  try {
    return requestResult(start(), code, message);
  } catch (error) {
    return Promise.reject(storageFailure(code, message, error));
  }
}

function transactionDone(
  transaction: IDBTransaction,
  code: FailureCode,
  message: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(storageFailure(code, message, transaction.error));
    transaction.onerror = () => {
      // The abort event owns the final failure because it carries the transaction outcome.
    };
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStoredSessionRecord(value: unknown): value is StoredSessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const hasStoredContent = (
    record.recordVersion === LEGACY_SESSION_LIBRARY_RECORD_VERSION
    && typeof record.serialized === "string"
  ) || (
    record.recordVersion === BLOB_SESSION_LIBRARY_RECORD_VERSION
    && record.canonicalBlob instanceof Blob
  ) || (
    record.recordVersion === SESSION_LIBRARY_RECORD_VERSION
    && record.canonicalBytes instanceof ArrayBuffer
  );
  return hasStoredContent
    && typeof record.identity === "string"
    && identityPattern.test(record.identity)
    && typeof record.sessionId === "string"
    && typeof record.title === "string"
    && typeof record.startedAt === "string"
    && typeof record.displayTimeZone === "string"
    && isFiniteNumber(record.durationUs)
    && (record.formatVersion === 1 || record.formatVersion === 2)
    && (record.sourceKind === "udp" || record.sourceKind === "serial" || record.sourceKind === "file")
    && typeof record.sourceLabel === "string"
    && typeof record.decoderId === "string"
    && typeof record.decoderRevision === "string"
    && typeof record.decoderSchemaHash === "string"
    && (record.captureIntegrityStatus === "verified"
      || record.captureIntegrityStatus === "incomplete"
      || record.captureIntegrityStatus === "unknown")
    && isFiniteNumber(record.recordCount)
    && isFiniteNumber(record.byteLength)
    && typeof record.savedAt === "string"
    && Number.isFinite(Date.parse(record.savedAt));
}

function assertStoredSessionRecord(value: unknown, identity?: string): StoredSessionRecord {
  if (!isStoredSessionRecord(value) || (identity !== undefined && value.identity !== identity)) {
    throw new SessionLibraryError(
      "corrupt",
      identity === undefined
        ? "The local session library contains invalid metadata."
        : "The stored session record is corrupt.",
    );
  }
  return value;
}

function freezeEntry(record: SessionLibraryEntry): SessionLibraryEntry {
  return Object.freeze({
    identity: record.identity,
    sessionId: record.sessionId,
    title: record.title,
    startedAt: record.startedAt,
    displayTimeZone: record.displayTimeZone,
    durationUs: record.durationUs,
    formatVersion: record.formatVersion,
    sourceKind: record.sourceKind,
    sourceLabel: record.sourceLabel,
    decoderId: record.decoderId,
    decoderRevision: record.decoderRevision,
    decoderSchemaHash: record.decoderSchemaHash,
    captureIntegrityStatus: record.captureIntegrityStatus,
    recordCount: record.recordCount,
    byteLength: record.byteLength,
    savedAt: record.savedAt,
  });
}

function entryFromDocument(
  document: SessionDocument,
  identity: string,
  byteLength: number,
  savedAt: string,
): SessionLibraryEntry {
  return {
    identity,
    sessionId: document.id,
    title: document.title,
    startedAt: document.startedAt,
    displayTimeZone: document.displayTimeZone,
    durationUs: document.durationUs,
    formatVersion: document.formatVersion,
    sourceKind: document.source.kind,
    sourceLabel: document.source.label,
    decoderId: document.decoder.id,
    decoderRevision: document.decoder.revision,
    decoderSchemaHash: document.decoder.schemaHash,
    captureIntegrityStatus: document.formatVersion === 1 ? "unknown" : document.captureIntegrity.status,
    recordCount: document.records.length,
    byteLength,
    savedAt,
  };
}

function recordMatchesEntry(record: StoredSessionRecord, entry: SessionLibraryEntry): boolean {
  return record.identity === entry.identity
    && record.sessionId === entry.sessionId
    && record.title === entry.title
    && record.startedAt === entry.startedAt
    && record.displayTimeZone === entry.displayTimeZone
    && record.durationUs === entry.durationUs
    && record.formatVersion === entry.formatVersion
    && record.sourceKind === entry.sourceKind
    && record.sourceLabel === entry.sourceLabel
    && record.decoderId === entry.decoderId
    && record.decoderRevision === entry.decoderRevision
    && record.decoderSchemaHash === entry.decoderSchemaHash
    && record.captureIntegrityStatus === entry.captureIntegrityStatus
    && record.recordCount === entry.recordCount
    && record.byteLength === entry.byteLength
    && record.savedAt === entry.savedAt;
}

function corruptRecord(message: string, cause?: unknown): SessionLibraryError {
  return new SessionLibraryError("corrupt", message, cause);
}

function sourceDocument(source: SessionDocument | ParsedSession): SessionDocument {
  return "document" in source ? source.document : source;
}

interface CanonicalSaveSource {
  readonly document: SessionDocument;
  readonly blob: Blob;
  readonly identity: string;
  readonly byteLength: number;
}

async function canonicalSaveSource(source: SessionDocument | ParsedSession): Promise<CanonicalSaveSource> {
  if ("document" in source) {
    const artifact = canonicalSessionArtifact(source);
    if (artifact) {
      if (artifact.byteLength > MAX_SESSION_FILE_BYTES) {
        throw new SessionLibraryError(
          "too-large",
          "The session exceeds the 64 MiB local-library safety limit and was not saved.",
        );
      }
      return {
        document: source.document,
        blob: artifact.blob,
        identity: artifact.identity,
        byteLength: artifact.byteLength,
      };
    }
  }

  const document = validateSessionDocument(sourceDocument(source));
  const serialized = serializeSessionDocument(document);
  const byteLength = utf8ByteLength(serialized);
  if (byteLength > MAX_SESSION_FILE_BYTES) {
    throw new SessionLibraryError(
      "too-large",
      "The session exceeds the 64 MiB local-library safety limit and was not saved.",
    );
  }
  const bytes = new TextEncoder().encode(serialized);
  return {
    document,
    blob: new Blob([
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    ], { type: "application/json" }),
    identity: await contentIdentity(bytes),
    byteLength,
  };
}

function storedBlob(record: StoredSessionRecord): Blob {
  return record.recordVersion === LEGACY_SESSION_LIBRARY_RECORD_VERSION
    ? new Blob([record.serialized], { type: "application/json" })
    : record.recordVersion === BLOB_SESSION_LIBRARY_RECORD_VERSION
      ? record.canonicalBlob
      : new Blob([record.canonicalBytes], { type: "application/json" });
}

export function createSessionLibrary(options: SessionLibraryOptions = {}): SessionLibrary {
  const databaseName = options.databaseName ?? SESSION_LIBRARY_DB_NAME;
  const now = options.now ?? (() => new Date());

  const withDatabase = async <T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> => {
    const database = await openDatabase(factoryFrom(options), databaseName);
    try {
      return await operation(database);
    } finally {
      database.close();
    }
  };

  return Object.freeze({
    async save(source: SessionDocument | ParsedSession): Promise<SessionLibraryEntry> {
      const canonical = await canonicalSaveSource(source);
      const canonicalDocument = canonical.document;
      const identity = canonical.identity;
      const savedAt = now().toISOString();
      const newEntry = entryFromDocument(canonicalDocument, identity, canonical.byteLength, savedAt);
      const canonicalBytes = await canonical.blob.arrayBuffer();
      if (canonicalBytes.byteLength !== canonical.byteLength) {
        throw new SessionLibraryError(
          "write-failed",
          "ReplayCase could not prepare the complete canonical session bytes for storage.",
        );
      }
      const newRecord: StoredSessionRecordV3 = {
        recordVersion: SESSION_LIBRARY_RECORD_VERSION,
        ...newEntry,
        canonicalBytes,
      };

      return withDatabase(async (database) => {
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction(SESSION_LIBRARY_STORE_NAME, "readwrite");
        } catch (error) {
          throw storageFailure("transaction-failed", "ReplayCase could not start a library write transaction.", error);
        }
        const completed = transactionDone(
          transaction,
          "write-failed",
          "ReplayCase could not commit the session to the local library.",
        );
        const store = transaction.objectStore(SESSION_LIBRARY_STORE_NAME);

        let existingValue: unknown;
        try {
          existingValue = await startRequest(
            () => store.get(identity),
            "transaction-failed",
            "ReplayCase could not inspect the local session library.",
          );
        } catch (error) {
          await completed.catch(() => undefined);
          throw error;
        }

        if (existingValue !== undefined) {
          await completed;
          const existing = assertStoredSessionRecord(existingValue, identity);
          let processed: Awaited<ReturnType<typeof processSessionBlob>>;
          try {
            processed = await processSessionBlob(storedBlob(existing), {
              sourceLabel: `saved:${identity}`,
            });
          } catch (error) {
            throw corruptRecord("The existing session-library record could not be revalidated.", error);
          }
          const expected = entryFromDocument(
            processed.session.document,
            identity,
            processed.report.canonicalBytes,
            existing.savedAt,
          );
          if (
            processed.session.canonicalIdentity !== identity
            || !processed.report.sourceWasCanonical
            || !recordMatchesEntry(existing, expected)
          ) {
            throw corruptRecord("The existing session-library record does not match its content identity.");
          }
          return freezeEntry(existing);
        }

        await Promise.all([
          startRequest(
            () => store.add(newRecord),
            "write-failed",
            "ReplayCase could not write the session to the local library.",
          ),
          completed,
        ]);
        return freezeEntry(newEntry);
      });
    },

    async list(): Promise<SessionLibraryEntry[]> {
      return withDatabase(async (database) => {
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction(SESSION_LIBRARY_STORE_NAME, "readonly");
        } catch (error) {
          throw storageFailure("transaction-failed", "ReplayCase could not start a library read transaction.", error);
        }
        const store = transaction.objectStore(SESSION_LIBRARY_STORE_NAME);
        const [values] = await Promise.all([
          startRequest(
            () => store.getAll(),
            "transaction-failed",
            "ReplayCase could not list the local session library.",
          ),
          transactionDone(
            transaction,
            "transaction-failed",
            "ReplayCase could not finish listing the local session library.",
          ),
        ]);
        return values
          .map((value) => freezeEntry(assertStoredSessionRecord(value)))
          .sort((left, right) => {
            const bySavedAt = Date.parse(right.savedAt) - Date.parse(left.savedAt);
            return bySavedAt !== 0 ? bySavedAt : right.identity.localeCompare(left.identity);
          });
      });
    },

    async load(identity: string, loadOptions: SessionLibraryLoadOptions = {}): Promise<ParsedSession> {
      const stored = await withDatabase(async (database) => {
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction(SESSION_LIBRARY_STORE_NAME, "readonly");
        } catch (error) {
          throw storageFailure("transaction-failed", "ReplayCase could not start a library read transaction.", error);
        }
        const store = transaction.objectStore(SESSION_LIBRARY_STORE_NAME);
        const [value] = await Promise.all([
          startRequest(
            () => store.get(identity),
            "transaction-failed",
            "ReplayCase could not read the requested stored session.",
          ),
          transactionDone(
            transaction,
            "transaction-failed",
            "ReplayCase could not finish reading the requested stored session.",
          ),
        ]);
        if (value === undefined) {
          throw new SessionLibraryError("not-found", "The requested session is not in the local library.");
        }
        return assertStoredSessionRecord(value, identity);
      });

      let processed: Awaited<ReturnType<typeof processSessionBlob>>;
      try {
        processed = await processSessionBlob(storedBlob(stored), {
          sourceLabel: `saved:${identity}`,
          signal: loadOptions.signal,
          onProgress: loadOptions.onProgress,
        });
      } catch (error) {
        if (error instanceof SessionProcessingCancelledError) throw error;
        throw corruptRecord("The stored session no longer passes ReplayCase validation and decoding.", error);
      }

      const expected = entryFromDocument(
        processed.session.document,
        identity,
        processed.report.canonicalBytes,
        stored.savedAt,
      );
      if (
        processed.session.canonicalIdentity !== identity
        || !processed.report.sourceWasCanonical
        || !recordMatchesEntry(stored, expected)
      ) {
        throw corruptRecord("The stored session content or metadata is not canonical.");
      }
      return processed.session;
    },

    async remove(identity: string): Promise<void> {
      return withDatabase(async (database) => {
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction(SESSION_LIBRARY_STORE_NAME, "readwrite");
        } catch (error) {
          throw storageFailure("transaction-failed", "ReplayCase could not start a library delete transaction.", error);
        }
        const completed = transactionDone(
          transaction,
          "write-failed",
          "ReplayCase could not commit the session deletion.",
        );
        const store = transaction.objectStore(SESSION_LIBRARY_STORE_NAME);
        let existing: unknown;
        try {
          existing = await startRequest(
            () => store.get(identity),
            "transaction-failed",
            "ReplayCase could not inspect the requested stored session.",
          );
        } catch (error) {
          await completed.catch(() => undefined);
          throw error;
        }
        if (existing === undefined) {
          await completed;
          throw new SessionLibraryError("not-found", "The requested session is not in the local library.");
        }
        await Promise.all([
          startRequest(
            () => store.delete(identity),
            "write-failed",
            "ReplayCase could not delete the requested stored session.",
          ),
          completed,
        ]);
      });
    },
  });
}
