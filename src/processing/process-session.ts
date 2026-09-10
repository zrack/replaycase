import type {
  DecodedFrame,
  ParsedSession,
  SessionDocument,
  SourceRecord,
} from "../domain/types";
import type {
  SessionProcessorWorkerRequest,
  SessionProcessorWorkerResponse,
  WorkerProcessedSessionResult,
} from "./session-processor.worker";
import {
  processSessionBlobCore,
  SessionProcessingCoreError,
  type ProcessedSessionResult,
} from "./process-session-core";
import type { SessionProcessingProgress, SessionProcessingReport } from "./contracts";
import { processingProgress } from "./contracts";
import { registerCanonicalSessionArtifact } from "./session-artifact";

export class SessionProcessingCancelledError extends Error {
  constructor() {
    super("Replay processing was canceled before it changed the active session.");
    this.name = "SessionProcessingCancelledError";
  }
}

export class SessionProcessingError extends Error {
  readonly code: string;
  readonly details: readonly string[];

  constructor(code: string, message: string, details: readonly string[] = [], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionProcessingError";
    this.code = code;
    this.details = details;
  }
}

export interface ProcessSessionOptions {
  readonly sourceLabel: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SessionProcessingProgress) => void;
}

export interface BrowserProcessedSession {
  readonly session: ParsedSession;
  readonly report: SessionProcessingReport;
}

type WorkerFactory = () => Worker;

function defaultWorkerFactory(): Worker {
  return new Worker(
    new URL("./session-processor.worker.ts", import.meta.url),
    { type: "module", name: "replaycase-session-processor" },
  );
}

class LazyFrameMap implements ReadonlyMap<string, DecodedFrame> {
  readonly #frames: readonly DecodedFrame[];
  #index: Map<string, DecodedFrame> | null = null;

  constructor(frames: readonly DecodedFrame[]) {
    this.#frames = frames;
  }

  get size(): number {
    return this.#frames.length;
  }

  get [Symbol.toStringTag](): string {
    return "Map";
  }

  get(key: string): DecodedFrame | undefined {
    return this.index().get(key);
  }

  has(key: string): boolean {
    return this.index().has(key);
  }

  forEach(
    callbackfn: (
      value: DecodedFrame,
      key: string,
      map: ReadonlyMap<string, DecodedFrame>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.index()) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  entries(): MapIterator<[string, DecodedFrame]> {
    return this.index().entries();
  }

  keys(): MapIterator<string> {
    return this.index().keys();
  }

  values(): MapIterator<DecodedFrame> {
    return this.index().values();
  }

  [Symbol.iterator](): MapIterator<[string, DecodedFrame]> {
    return this.entries();
  }

  private index(): Map<string, DecodedFrame> {
    if (this.#index === null) {
      this.#index = new Map(this.#frames.map((frame) => [frame.id, frame]));
    }
    return this.#index;
  }
}

function deepFreezeTransferred<T>(value: T): T {
  if (value == null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeTransferred(child);
  return Object.freeze(value);
}

export function hydrateWorkerResult(
  result: WorkerProcessedSessionResult,
  records: SourceRecord[],
  frames: DecodedFrame[],
): ProcessedSessionResult {
  if (
    records.length !== result.report.recordCount
    || frames.length !== result.report.recordCount
    || result.session.document.records.length !== 0
    || result.session.frames.length !== 0
  ) {
    throw new SessionProcessingError(
      "WORKER_FAILURE",
      "The replay processing worker returned an incomplete result.",
      [
        `Expected ${result.report.recordCount} rows; received ${records.length} records and ${frames.length} decoded frames.`,
      ],
    );
  }
  for (const record of records) deepFreezeTransferred(record);
  deepFreezeTransferred(result.session);
  Object.freeze(records);
  Object.freeze(frames);
  const document = Object.freeze({
    ...result.session.document,
    records,
  }) as SessionDocument;
  return {
    ...result,
    session: Object.freeze({
      ...result.session,
      document,
      frames,
      framesById: new LazyFrameMap(frames),
    }),
  };
}

function registerResult(result: ProcessedSessionResult): BrowserProcessedSession {
  registerCanonicalSessionArtifact(result.session, result.artifact);
  return { session: result.session, report: result.report };
}

async function processWithoutWorker(
  blob: Blob,
  options: ProcessSessionOptions,
): Promise<BrowserProcessedSession> {
  if (options.signal?.aborted) throw new SessionProcessingCancelledError();
  try {
    const result = await processSessionBlobCore(blob, {
      sourceLabel: options.sourceLabel,
      onProgress(progress) {
        if (options.signal?.aborted) throw new SessionProcessingCancelledError();
        options.onProgress?.(progress);
      },
    });
    if (options.signal?.aborted) throw new SessionProcessingCancelledError();
    options.onProgress?.(processingProgress("transferring", 1, 1));
    return registerResult(result);
  } catch (error) {
    if (error instanceof SessionProcessingCancelledError) throw error;
    if (error instanceof SessionProcessingCoreError) {
      throw new SessionProcessingError(error.code, error.message, error.details, error);
    }
    throw error;
  }
}

export function processSessionBlob(
  blob: Blob,
  options: ProcessSessionOptions,
  createWorker: WorkerFactory = defaultWorkerFactory,
): Promise<BrowserProcessedSession> {
  if (options.signal?.aborted) return Promise.reject(new SessionProcessingCancelledError());
  if (typeof Worker === "undefined") return processWithoutWorker(blob, options);

  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = createWorker();
    } catch (error) {
      reject(new SessionProcessingError(
        "WORKER_FAILURE",
        "ReplayCase could not start the replay processing worker.",
        [error instanceof Error ? error.message : "Worker construction failed."],
        error,
      ));
      return;
    }

    let settled = false;
    const records: SourceRecord[] = [];
    const frames: DecodedFrame[] = [];
    const finish = () => {
      worker.terminate();
      options.signal?.removeEventListener("abort", cancel);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    };
    const cancel = () => fail(new SessionProcessingCancelledError());
    options.signal?.addEventListener("abort", cancel, { once: true });

    worker.addEventListener("message", (event: MessageEvent<SessionProcessorWorkerResponse>) => {
      if (settled) return;
      if (event.data.type === "progress") {
        options.onProgress?.(event.data.progress);
        return;
      }
      if (event.data.type === "chunk") {
        if (
          event.data.chunk.start !== records.length
          || event.data.chunk.records.length !== event.data.chunk.frames.length
        ) {
          fail(new SessionProcessingError(
            "WORKER_FAILURE",
            "The replay processing worker returned out-of-order evidence chunks.",
          ));
          return;
        }
        for (const record of event.data.chunk.records) deepFreezeTransferred(record);
        records.push(...event.data.chunk.records);
        frames.push(...event.data.chunk.frames);
        options.onProgress?.(
          processingProgress("transferring", event.data.completed, event.data.total),
        );
        return;
      }
      settled = true;
      finish();
      if (event.data.type === "success") {
        try {
          resolve(registerResult(hydrateWorkerResult(event.data.result, records, frames)));
        } catch (error) {
          reject(error);
        }
      } else {
        reject(new SessionProcessingError(
          event.data.error.code,
          event.data.error.message,
          event.data.error.details,
        ));
      }
    });
    worker.addEventListener("error", (event) => {
      fail(new SessionProcessingError(
        "WORKER_FAILURE",
        event.message || "The replay processing worker could not complete.",
      ));
    }, { once: true });

    const request: SessionProcessorWorkerRequest = {
      blob,
      sourceLabel: options.sourceLabel,
    };
    worker.postMessage(request);
  });
}
