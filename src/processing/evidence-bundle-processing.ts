import {
  buildEvidenceBundle,
  type BuildEvidenceBundleOptions,
} from "../domain/bundle";
import { serializeSessionDocument } from "../data/session-file";
import { canonicalSessionArtifact } from "./session-artifact";
import type {
  EvidenceBundleWorkerRequest,
  EvidenceBundleWorkerResponse,
} from "./evidence-bundle.worker";

export type EvidenceBundleProcessingPhase =
  | "loading-session"
  | "selecting-evidence"
  | "hashing-and-compressing";

export interface EvidenceBundleProcessingProgress {
  readonly phase: EvidenceBundleProcessingPhase;
  readonly percent: number;
  readonly message: string;
}

export class EvidenceBundleProcessingCancelledError extends Error {
  constructor() {
    super("Evidence bundle construction was canceled before an archive was created.");
    this.name = "EvidenceBundleProcessingCancelledError";
  }
}

export interface EvidenceBundleProcessingOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: EvidenceBundleProcessingProgress) => void;
}

type WorkerFactory = () => Worker;

function defaultWorkerFactory(): Worker {
  return new Worker(
    new URL("./evidence-bundle.worker.ts", import.meta.url),
    { type: "module", name: "replaycase-evidence-builder" },
  );
}

export function buildEvidenceBundleInWorker(
  buildOptions: BuildEvidenceBundleOptions,
  processingOptions: EvidenceBundleProcessingOptions = {},
  createWorker: WorkerFactory = defaultWorkerFactory,
): Promise<Uint8Array> {
  if (processingOptions.signal?.aborted) {
    return Promise.reject(new EvidenceBundleProcessingCancelledError());
  }
  if (typeof Worker === "undefined") return buildEvidenceBundle(buildOptions);

  const artifact = canonicalSessionArtifact(buildOptions.session);
  const sessionBlob = artifact?.blob
    ?? new Blob([serializeSessionDocument(buildOptions.session.document)], { type: "application/json" });
  const sessionIdentity = artifact?.identity ?? buildOptions.session.canonicalIdentity ?? null;

  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = createWorker();
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const finish = () => {
      worker.terminate();
      processingOptions.signal?.removeEventListener("abort", cancel);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    };
    const cancel = () => fail(new EvidenceBundleProcessingCancelledError());
    processingOptions.signal?.addEventListener("abort", cancel, { once: true });

    worker.addEventListener("message", (event: MessageEvent<EvidenceBundleWorkerResponse>) => {
      if (settled) return;
      if (event.data.type === "progress") {
        processingOptions.onProgress?.(event.data.progress);
        return;
      }
      settled = true;
      finish();
      if (event.data.type === "success") {
        resolve(new Uint8Array(event.data.bytes));
      } else {
        reject(new Error(event.data.message));
      }
    });
    worker.addEventListener("error", (event) => {
      fail(new Error(event.message || "The evidence bundle worker could not complete."));
    }, { once: true });

    const { session: _session, ...options } = buildOptions;
    const request: EvidenceBundleWorkerRequest = {
      sessionBlob,
      sessionIdentity,
      options,
    };
    worker.postMessage(request);
  });
}
