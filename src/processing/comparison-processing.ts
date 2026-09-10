import {
  compareSources,
  type ComparisonAlignment,
  type ComparisonModel,
  type ComparisonSource,
} from "../domain/comparison";
import type {
  ComparisonWorkerRequest,
  ComparisonWorkerResponse,
} from "./comparison.worker";

export interface ComparisonProcessingProgress {
  readonly percent: number;
  readonly message: string;
}

export class ComparisonProcessingCancelledError extends Error {
  constructor() {
    super("Comparison construction was canceled before a finding workspace was opened.");
    this.name = "ComparisonProcessingCancelledError";
  }
}

export interface ComparisonProcessingOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ComparisonProcessingProgress) => void;
}

type WorkerFactory = () => Worker;

function defaultWorkerFactory(): Worker {
  return new Worker(
    new URL("./comparison.worker.ts", import.meta.url),
    { type: "module", name: "replaycase-comparison-processor" },
  );
}

export function compareSourcesInWorker(
  baseline: ComparisonSource,
  candidate: ComparisonSource,
  alignment: ComparisonAlignment,
  options: ComparisonProcessingOptions = {},
  createWorker: WorkerFactory = defaultWorkerFactory,
): Promise<ComparisonModel> {
  if (options.signal?.aborted) return Promise.reject(new ComparisonProcessingCancelledError());
  if (typeof Worker === "undefined") {
    options.onProgress?.({ percent: 10, message: "Aligning bounded evidence" });
    const model = compareSources(baseline, candidate, alignment);
    options.onProgress?.({ percent: 100, message: "Comparison workspace ready" });
    return Promise.resolve(model);
  }

  return new Promise((resolve, reject) => {
    const worker = createWorker();
    let settled = false;
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
    const cancel = () => fail(new ComparisonProcessingCancelledError());
    options.signal?.addEventListener("abort", cancel, { once: true });

    worker.addEventListener("message", (event: MessageEvent<ComparisonWorkerResponse>) => {
      if (settled) return;
      if (event.data.type === "progress") {
        options.onProgress?.(event.data.progress);
        return;
      }
      settled = true;
      finish();
      if (event.data.type === "success") resolve(event.data.model);
      else reject(new Error(event.data.message));
    });
    worker.addEventListener("error", (event) => {
      fail(new Error(event.message || "The comparison worker could not complete."));
    }, { once: true });

    const request: ComparisonWorkerRequest = { baseline, candidate, alignment };
    worker.postMessage(request);
  });
}
