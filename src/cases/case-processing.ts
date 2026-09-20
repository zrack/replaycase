import {
  CASE_LIMITS,
  type CaseContent,
  type VerifiedCase,
} from "../domain/case";
import type { ReceiverDocument } from "../receiver/receiver-document";

export type CaseRequest =
  | { kind: "import"; archive: Uint8Array; expectedHash?: string }
  | {
      kind: "build";
      content: CaseContent;
      bundles: Uint8Array[];
      additions?: { fileName: string; bytes: Uint8Array }[];
    };
export interface CaseProcessingOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { percent: number; message: string }) => void;
}
export const CASE_ARRAY_KEYS = [
  "rawRecords",
  "decodedPackets",
  "diagnostics",
  "markers",
  "sourceNotes",
  "transportEvents",
] as const;
export type CaseArrayKey = (typeof CASE_ARRAY_KEYS)[number];
export type CaseResponse =
  | { type: "progress"; percent: number; message: string }
  | {
      type: "bundle";
      index: number;
      bundle: VerifiedCase["bundles"][number];
      counts: Record<CaseArrayKey, number>;
    }
  | {
      type: "chunk";
      index: number;
      key: CaseArrayKey;
      offset: number;
      values: unknown[];
    }
  | { type: "complete"; value: Omit<VerifiedCase, "bundles"> }
  | { type: "error"; message: string };

export function caseCancelled(): DOMException {
  return new DOMException(
    "Case operation canceled; the active case was not changed.",
    "AbortError",
  );
}

export function processCase(
  request: CaseRequest,
  options: CaseProcessingOptions = {},
  createWorker = () =>
    new Worker(new URL("./case.worker.ts", import.meta.url), {
      type: "module",
    }),
): Promise<VerifiedCase> {
  if (options.signal?.aborted) return Promise.reject(caseCancelled());
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    const bundles: VerifiedCase["bundles"] = [];
    const expectedCounts: Record<CaseArrayKey, number>[] = [];
    let settled = false;
    let lastProgress = 0;
    const finish = () => {
      settled = true;
      worker.terminate();
      options.signal?.removeEventListener("abort", cancel);
    };
    const fail = (error: unknown) => {
      if (!settled) {
        finish();
        reject(error);
      }
    };
    const cancel = () => fail(caseCancelled());
    options.signal?.addEventListener("abort", cancel, { once: true });
    worker.onmessage = (event: MessageEvent<CaseResponse>) => {
      if (settled) return;
      const response = event.data;
      if (response.type === "error") return fail(new Error(response.message));
      if (response.type === "progress") {
        if (response.percent < lastProgress || response.percent > 100)
          return fail(new Error("Invalid case processing progress."));
        lastProgress = response.percent;
        options.onProgress?.({
          percent: response.percent,
          message: response.message,
        });
      } else if (response.type === "bundle") {
        if (response.index !== bundles.length)
          return fail(new Error("Case bundles arrived out of order."));
        bundles.push(response.bundle);
        expectedCounts.push(response.counts);
      } else if (response.type === "chunk") {
        const array = bundles[response.index]?.document.evidence[
          response.key
        ] as unknown[] | undefined;
        if (
          !array ||
          array.length !== response.offset ||
          response.values.length > 1_000
        )
          return fail(new Error("Case evidence chunks arrived out of order."));
        array.push(...response.values);
      } else {
        if (bundles.length !== response.value.manifest.bundles.length)
          return fail(new Error("Case evidence transfer is incomplete."));
        if (
          bundles.some((bundle, index) =>
            CASE_ARRAY_KEYS.some(
              (key) =>
                bundle.document.evidence[key].length !==
                expectedCounts[index]?.[key],
            ),
          )
        )
          return fail(new Error("Case evidence transfer is incomplete."));
        finish();
        resolve({ ...response.value, bundles });
      }
    };
    worker.onerror = (event) =>
      fail(new Error(event.message || "Case processing worker failed."));
    worker.onmessageerror = () =>
      fail(new Error("Case processing response could not be read."));
    try {
      worker.postMessage(request);
    } catch (error) {
      fail(error);
    }
  });
}

export async function readCaseFile(
  file: File,
  limit = CASE_LIMITS.archiveBytes,
): Promise<Uint8Array> {
  if (file.size === 0 || file.size > limit)
    throw new Error(`File must contain 1 to ${limit} bytes.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size)
    throw new Error("The complete file could not be read.");
  return bytes;
}

export function emptyEvidenceArrays(
  document: ReceiverDocument,
): ReceiverDocument {
  const evidence = { ...document.evidence };
  for (const key of CASE_ARRAY_KEYS) evidence[key] = [];
  return { ...document, evidence };
}
