import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { NMEA0183_DECODER_PACK, SUPPORTED_DECODER } from "../domain/decoder";
import { decoderDescriptorForPack } from "../domain/decoder-pack";
import type { SessionDocument, SessionDocumentV2 } from "../domain/types";
import {
  createSessionLibrary,
  SESSION_LIBRARY_DB_VERSION,
  SESSION_LIBRARY_STORE_NAME,
  sessionLibraryIdentity,
} from "./session-library";

function session(overrides: Partial<SessionDocument> = {}): SessionDocument {
  return {
    format: "narrowslink/session",
    formatVersion: 1,
    id: "session-alpha",
    title: "Alpha downlink",
    startedAt: "2026-07-16T04:38:12.000Z",
    displayTimeZone: "America/Los_Angeles",
    durationUs: 1_000_000,
    source: {
      id: "alpha-udp",
      kind: "udp",
      label: "UDP :9104",
      address: "127.0.0.1",
      port: 9104,
    },
    decoder: { ...SUPPORTED_DECODER },
    records: [{
      id: "record-0",
      index: 0,
      sourceId: "alpha-udp",
      offsetUs: 100_000,
      dataHex: "00",
      captureBytes: 1,
      wireBytes: 1,
      transport: { kind: "udp" },
    }],
    incidents: [],
    ...overrides,
  } as SessionDocument;
}

function version2Session(): SessionDocumentV2 {
  const legacy = session();
  return {
    ...legacy,
    formatVersion: 2,
    transportEvents: [],
    captureIntegrity: {
      schemaVersion: 1,
      status: "verified",
      assessmentBasis: "udp-bridge-reconciled",
      stopDisposition: "confirmed",
      stopOffsetUs: legacy.durationUs,
      eventLogComplete: true,
      input: {
        unit: "datagram",
        observedUnits: 1,
        observedBytes: 1,
        transportReportedUnits: 1,
        transportReportedBytes: 1,
      },
      retained: { records: 1, bytes: 1 },
      issueCodes: [],
    },
  };
}

function nmeaVersion2Session(): SessionDocumentV2 {
  const fixture = NMEA0183_DECODER_PACK.fixtures[0];
  const fixtureRecord = fixture?.records[0];
  if (!fixtureRecord) throw new Error("Expected NMEA fixture record");
  const bytes = fixtureRecord.dataHex.length / 2;
  return {
    format: "narrowslink/session",
    formatVersion: 2,
    id: "session-nmea",
    title: "NMEA replay",
    startedAt: "2026-07-16T04:38:12.000Z",
    displayTimeZone: "America/Los_Angeles",
    durationUs: fixtureRecord.offsetUs + 1,
    source: { id: "nmea-file", kind: "file", label: "NMEA fixture" },
    decoder: decoderDescriptorForPack(NMEA0183_DECODER_PACK),
    decoderPack: NMEA0183_DECODER_PACK,
    records: [{
      id: "nmea-record-0",
      index: 0,
      sourceId: "nmea-file",
      offsetUs: fixtureRecord.offsetUs,
      dataHex: fixtureRecord.dataHex,
      captureBytes: bytes,
      wireBytes: bytes,
      transport: { kind: "file" },
    }],
    incidents: [],
    transportEvents: [],
    captureIntegrity: {
      schemaVersion: 1,
      status: "unknown",
      assessmentBasis: "file-source-unassessed",
      stopDisposition: "not-observed",
      stopOffsetUs: null,
      eventLogComplete: false,
      input: {
        unit: "unknown",
        observedUnits: null,
        observedBytes: null,
        transportReportedUnits: null,
        transportReportedBytes: null,
      },
      retained: { records: 1, bytes },
      issueCodes: ["file-source-unassessed"],
    },
  };
}

function oversizedSession(): SessionDocument {
  const dataHex = "00".repeat(65_500);
  const records = Array.from({ length: 513 }, (_, index) => ({
    id: `record-${index}`,
    index,
    sourceId: "alpha-udp",
    offsetUs: index,
    dataHex,
    captureBytes: 65_500,
    wireBytes: 65_500,
    transport: { kind: "udp" as const },
  }));
  return session({ records });
}

function waitForRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => {
      // The abort event reports the final transaction outcome.
    };
  });
}

async function corruptSerializedContent(
  factory: IDBFactory,
  databaseName: string,
  identity: string,
): Promise<void> {
  const database = await waitForRequest(factory.open(databaseName, SESSION_LIBRARY_DB_VERSION));
  try {
    const transaction = database.transaction(SESSION_LIBRARY_STORE_NAME, "readwrite");
    const completed = waitForTransaction(transaction);
    const store = transaction.objectStore(SESSION_LIBRARY_STORE_NAME);
    const value = await waitForRequest(store.get(identity)) as Record<string, unknown> | undefined;
    if (!value) throw new Error("Expected stored session record");
    const corrupt = value.recordVersion === 3
      ? { ...value, canonicalBytes: new TextEncoder().encode("{").buffer }
      : value.recordVersion === 2
        ? { ...value, canonicalBlob: new Blob(["{"]) }
        : { ...value, serialized: "{" };
    await Promise.all([
      waitForRequest(store.put(corrupt)),
      completed,
    ]);
  } finally {
    database.close();
  }
}

async function storedRecord(
  factory: IDBFactory,
  databaseName: string,
  identity: string,
): Promise<Record<string, unknown>> {
  const database = await waitForRequest(factory.open(databaseName, SESSION_LIBRARY_DB_VERSION));
  try {
    const transaction = database.transaction(SESSION_LIBRARY_STORE_NAME, "readonly");
    const [value] = await Promise.all([
      waitForRequest(transaction.objectStore(SESSION_LIBRARY_STORE_NAME).get(identity)),
      waitForTransaction(transaction),
    ]);
    if (typeof value !== "object" || value === null) {
      throw new Error("Expected stored session record");
    }
    return value as Record<string, unknown>;
  } finally {
    database.close();
  }
}

describe("durable local session library", () => {
  it("saves listable metadata and reloads a version 1 document through the decoder", async () => {
    const factory = new IDBFactory();
    const databaseName = "session-library-save-load";
    const library = createSessionLibrary({
      indexedDB: factory,
      databaseName,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    const document = session();

    const saved = await library.save(document);

    expect(saved).toMatchObject({
      identity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      sessionId: "session-alpha",
      title: "Alpha downlink",
      startedAt: "2026-07-16T04:38:12.000Z",
      displayTimeZone: "America/Los_Angeles",
      durationUs: 1_000_000,
      formatVersion: 1,
      sourceKind: "udp",
      sourceLabel: "UDP :9104",
      decoderId: SUPPORTED_DECODER.id,
      decoderRevision: SUPPORTED_DECODER.revision,
      decoderSchemaHash: SUPPORTED_DECODER.schemaHash,
      captureIntegrityStatus: "unknown",
      recordCount: 1,
      savedAt: "2026-07-17T12:00:00.000Z",
    });
    expect(saved.byteLength).toBeGreaterThan(0);
    expect(await library.list()).toEqual([saved]);
    const persisted = await storedRecord(factory, databaseName, saved.identity);
    expect(persisted.recordVersion).toBe(3);
    expect(persisted.canonicalBytes).toBeInstanceOf(ArrayBuffer);
    expect((persisted.canonicalBytes as ArrayBuffer).byteLength).toBe(saved.byteLength);

    const loaded = await library.load(saved.identity);
    expect(loaded.document).toEqual(document);
    expect(loaded.document.formatVersion).toBe(1);
    expect("transportEvents" in loaded.document).toBe(false);
    expect(loaded.frames).toHaveLength(1);
    expect(loaded.frames[0]?.sourceRecord).toBe(loaded.document.records[0]);
  });

  it("preserves version 2 transport evidence and integrity metadata", async () => {
    const library = createSessionLibrary({
      indexedDB: new IDBFactory(),
      databaseName: "session-library-version-2",
      now: () => new Date("2026-07-17T12:30:00.000Z"),
    });
    const document = version2Session();

    const saved = await library.save(document);
    const loaded = await library.load(saved.identity);

    expect(saved).toMatchObject({
      formatVersion: 2,
      captureIntegrityStatus: "verified",
      recordCount: 1,
    });
    expect(saved.identity).toBe(await sessionLibraryIdentity(document));
    expect(loaded.document).toEqual(document);
    expect(loaded.document.formatVersion).toBe(2);
    expect(loaded.transportEvents).toEqual([]);
    expect(loaded.captureIntegrity).toEqual(document.captureIntegrity);
  });

  it("reopens a version 2 Blob-backed library record without rewriting it", async () => {
    const factory = new IDBFactory();
    const databaseName = "session-library-blob-record";
    const library = createSessionLibrary({ indexedDB: factory, databaseName });
    const saved = await library.save(session());
    const current = await storedRecord(factory, databaseName, saved.identity);
    const canonicalBytes = current.canonicalBytes;
    if (!(canonicalBytes instanceof ArrayBuffer)) {
      throw new Error("Expected version 3 canonical bytes");
    }

    const database = await waitForRequest(factory.open(databaseName, SESSION_LIBRARY_DB_VERSION));
    try {
      const transaction = database.transaction(SESSION_LIBRARY_STORE_NAME, "readwrite");
      const completed = waitForTransaction(transaction);
      const {
        canonicalBytes: _canonicalBytes,
        recordVersion: _recordVersion,
        ...metadata
      } = current;
      await Promise.all([
        waitForRequest(transaction.objectStore(SESSION_LIBRARY_STORE_NAME).put({
          ...metadata,
          recordVersion: 2,
          canonicalBlob: new Blob([canonicalBytes], { type: "application/json" }),
        })),
        completed,
      ]);
    } finally {
      database.close();
    }

    const loaded = await library.load(saved.identity);
    expect(loaded.document).toEqual(session());
    expect((await storedRecord(factory, databaseName, saved.identity)).recordVersion).toBe(2);
  });

  it("persists and reopens the exact embedded decoder pack", async () => {
    const library = createSessionLibrary({
      indexedDB: new IDBFactory(),
      databaseName: "session-library-nmea-pack",
    });
    const document = nmeaVersion2Session();

    const saved = await library.save(document);
    const loaded = await library.load(saved.identity);

    expect(loaded.decoderPack.integrity.canonicalSha256).toBe(NMEA0183_DECODER_PACK.integrity.canonicalSha256);
    expect(loaded.frames[0]).toMatchObject({
      status: "complete",
      familyName: "NMEA GGA · Global Positioning System Fix Data",
    });
    expect(loaded.document).toEqual(document);
  });

  it("validates a session document before any record is written", async () => {
    const library = createSessionLibrary({
      indexedDB: new IDBFactory(),
      databaseName: "session-library-invalid-save",
    });
    const invalid = session();
    const firstRecord = invalid.records[0];
    if (!firstRecord) throw new Error("Expected source record");
    firstRecord.sourceId = "different-source";

    await expect(library.save(invalid)).rejects.toMatchObject({
      name: "SessionValidationError",
    });
    expect(await library.list()).toEqual([]);
  });

  it("rejects oversized canonical content before opening IndexedDB", async () => {
    const backingFactory = new IDBFactory();
    let openCalls = 0;
    const countingFactory = {
      open(name: string, version?: number): IDBOpenDBRequest {
        openCalls += 1;
        return backingFactory.open(name, version);
      },
    } as unknown as IDBFactory;
    const library = createSessionLibrary({
      indexedDB: countingFactory,
      databaseName: "session-library-too-large",
    });

    await expect(library.save(oversizedSession())).rejects.toMatchObject({
      name: "SessionLibraryError",
      code: "too-large",
      message: "The session exceeds the 64 MiB local-library safety limit and was not saved.",
    });
    expect(openCalls).toBe(0);
  });

  it("uses deterministic SHA-256 content identities and does not duplicate or reorder identical saves", async () => {
    const factory = new IDBFactory();
    const saveTimes = [
      new Date("2026-07-17T12:00:00.000Z"),
      new Date("2026-07-17T12:10:00.000Z"),
    ];
    const library = createSessionLibrary({
      indexedDB: factory,
      databaseName: "session-library-dedup",
      now: () => saveTimes.shift() ?? new Date("2026-07-17T12:20:00.000Z"),
    });
    const firstDocument = session();
    const equivalentDocument = structuredClone(firstDocument);

    expect(await sessionLibraryIdentity(firstDocument)).toBe(await sessionLibraryIdentity(equivalentDocument));
    expect(await sessionLibraryIdentity(session({ title: "Changed content" })))
      .not.toBe(await sessionLibraryIdentity(firstDocument));

    const firstSave = await library.save(firstDocument);
    const duplicateSave = await library.save(equivalentDocument);

    expect(duplicateSave).toEqual(firstSave);
    expect(duplicateSave.savedAt).toBe("2026-07-17T12:00:00.000Z");
    expect(await library.list()).toEqual([firstSave]);
  });

  it("lists distinct session content newest first", async () => {
    const factory = new IDBFactory();
    const saveTimes = [
      new Date("2026-07-17T12:00:00.000Z"),
      new Date("2026-07-17T12:05:00.000Z"),
      new Date("2026-07-17T12:10:00.000Z"),
    ];
    const library = createSessionLibrary({
      indexedDB: factory,
      databaseName: "session-library-ordering",
      now: () => saveTimes.shift() ?? new Date("2026-07-17T12:15:00.000Z"),
    });

    const alpha = await library.save(session());
    const bravo = await library.save(session({ id: "session-bravo", title: "Bravo downlink" }));
    const charlie = await library.save(session({ id: "session-charlie", title: "Charlie downlink" }));

    expect((await library.list()).map((entry) => entry.identity)).toEqual([
      charlie.identity,
      bravo.identity,
      alpha.identity,
    ]);
  });

  it("removes by content identity and reports missing sessions", async () => {
    const factory = new IDBFactory();
    const library = createSessionLibrary({ indexedDB: factory, databaseName: "session-library-remove" });
    const saved = await library.save(session());

    await library.remove(saved.identity);

    expect(await library.list()).toEqual([]);
    await expect(library.load(saved.identity)).rejects.toMatchObject({
      name: "SessionLibraryError",
      code: "not-found",
    });
    await expect(library.remove(saved.identity)).rejects.toMatchObject({
      name: "SessionLibraryError",
      code: "not-found",
    });
  });

  it("rejects tampered stored content as corrupt", async () => {
    const factory = new IDBFactory();
    const databaseName = "session-library-corrupt";
    const library = createSessionLibrary({ indexedDB: factory, databaseName });
    const saved = await library.save(session());

    await corruptSerializedContent(factory, databaseName, saved.identity);

    await expect(library.load(saved.identity)).rejects.toMatchObject({
      name: "SessionLibraryError",
      code: "corrupt",
    });
  });

  it("surfaces unavailable browser storage as a typed error", async () => {
    const library = createSessionLibrary({ indexedDB: null });

    await expect(library.list()).rejects.toMatchObject({
      name: "SessionLibraryError",
      code: "unavailable",
    });
    await expect(library.save(session())).rejects.toMatchObject({
      name: "SessionLibraryError",
      code: "unavailable",
    });
  });

  it("distinguishes open failures from unavailable storage", async () => {
    const failingFactory = {
      open(): IDBOpenDBRequest {
        throw new DOMException("Database open failed", "InvalidStateError");
      },
    } as unknown as IDBFactory;
    const library = createSessionLibrary({ indexedDB: failingFactory });

    await expect(library.list()).rejects.toMatchObject({
      name: "SessionLibraryError",
      code: "open-failed",
    });
  });

  it("surfaces an IndexedDB blocked-open event instead of waiting indefinitely", async () => {
    const blockedFactory = {
      open(): IDBOpenDBRequest {
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => request.onblocked?.({} as IDBVersionChangeEvent));
        return request;
      },
    } as unknown as IDBFactory;
    const library = createSessionLibrary({ indexedDB: blockedFactory });

    await expect(library.list()).rejects.toMatchObject({
      name: "SessionLibraryError",
      code: "open-failed",
      message: "The local session library is blocked by another ReplayCase window.",
    });
  });

  it("does not claim a save succeeded when its IndexedDB transaction aborts", async () => {
    const addDescriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "add");
    if (!addDescriptor || typeof addDescriptor.value !== "function") {
      throw new Error("Expected fake-indexeddb add implementation");
    }
    const originalAdd = addDescriptor.value as IDBObjectStore["add"];
    Object.defineProperty(IDBObjectStore.prototype, "add", {
      configurable: true,
      value(this: IDBObjectStore, ...args: Parameters<IDBObjectStore["add"]>): IDBRequest<IDBValidKey> {
        const request = originalAdd.apply(this, args);
        this.transaction.abort();
        return request;
      },
    });

    try {
      const library = createSessionLibrary({
        indexedDB: new IDBFactory(),
        databaseName: "session-library-transaction-abort",
      });
      await expect(library.save(session())).rejects.toMatchObject({
        name: "SessionLibraryError",
        code: "write-failed",
      });
      expect(await library.list()).toEqual([]);
    } finally {
      Object.defineProperty(IDBObjectStore.prototype, "add", addDescriptor);
    }
  });

  it("classifies quota write failures without replacing an immutable record", async () => {
    const addDescriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "add");
    if (!addDescriptor) throw new Error("Expected fake-indexeddb add descriptor");
    Object.defineProperty(IDBObjectStore.prototype, "add", {
      configurable: true,
      value(): never {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      },
    });

    try {
      const library = createSessionLibrary({
        indexedDB: new IDBFactory(),
        databaseName: "session-library-quota",
      });
      await expect(library.save(session())).rejects.toMatchObject({
        name: "SessionLibraryError",
        code: "quota",
      });
      expect(await library.list()).toEqual([]);
    } finally {
      Object.defineProperty(IDBObjectStore.prototype, "add", addDescriptor);
    }
  });
});
