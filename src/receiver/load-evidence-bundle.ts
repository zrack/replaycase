import { EVIDENCE_ARCHIVE_LIMITS } from "../domain/evidence-contract";
import type { VerifiedEvidenceBundle } from "../../verifier/evidence-verifier";
import {
  buildReceiverDocument,
  type ReceiverDocument,
} from "./receiver-document";
import type {
  ReceiverVerificationWorkerRequest,
  ReceiverVerificationWorkerResponse,
} from "./evidence-verifier.worker";

export class EvidenceBundleLoadError extends Error {
  readonly code: string;
  readonly path: string | null;
  readonly details: string[];

  constructor(
    code: string,
    message: string,
    path: string | null = null,
    details: string[] = [],
  ) {
    super(message);
    this.name = "EvidenceBundleLoadError";
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

export type BrowserEvidenceVerifier = (bytes: ArrayBuffer) => Promise<VerifiedEvidenceBundle>;

export function verifyEvidenceBytesInWorker(bytes: ArrayBuffer): Promise<VerifiedEvidenceBundle> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./evidence-verifier.worker.ts", import.meta.url),
      { type: "module", name: "replaycase-evidence-verifier" },
    );
    const finish = () => worker.terminate();
    worker.addEventListener("message", (event: MessageEvent<ReceiverVerificationWorkerResponse>) => {
      finish();
      if (event.data.ok) {
        resolve(event.data.verified);
      } else {
        reject(new EvidenceBundleLoadError(
          event.data.error.code,
          event.data.error.message,
          event.data.error.path,
        ));
      }
    }, { once: true });
    worker.addEventListener("error", (event) => {
      finish();
      reject(new EvidenceBundleLoadError(
        "WORKER_FAILURE",
        event.message || "The evidence verifier worker could not complete.",
      ));
    }, { once: true });
    const request: ReceiverVerificationWorkerRequest = { bytes };
    worker.postMessage(request, [bytes]);
  });
}

export async function loadEvidenceBundleFile(
  file: File,
  verify: BrowserEvidenceVerifier = verifyEvidenceBytesInWorker,
): Promise<ReceiverDocument> {
  if (file.size === 0) {
    throw new EvidenceBundleLoadError("ARCHIVE_STRUCTURE_INVALID", "The selected evidence bundle is empty.");
  }
  if (file.size > EVIDENCE_ARCHIVE_LIMITS.archiveBytes) {
    throw new EvidenceBundleLoadError(
      "ARCHIVE_LIMIT_EXCEEDED",
      `The selected evidence bundle exceeds the ${EVIDENCE_ARCHIVE_LIMITS.archiveBytes}-byte safety limit.`,
      file.name,
    );
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (error) {
    throw new EvidenceBundleLoadError(
      "ARCHIVE_IO_ERROR",
      "The selected evidence bundle could not be read.",
      file.name,
      [error instanceof Error ? error.message : "Browser file reading failed."],
    );
  }
  if (bytes.byteLength !== file.size) {
    throw new EvidenceBundleLoadError(
      "ARCHIVE_IO_ERROR",
      "The selected evidence bundle changed while it was being read.",
      file.name,
    );
  }
  if (bytes.byteLength > EVIDENCE_ARCHIVE_LIMITS.archiveBytes) {
    throw new EvidenceBundleLoadError(
      "ARCHIVE_LIMIT_EXCEEDED",
      `The selected evidence bundle exceeds the ${EVIDENCE_ARCHIVE_LIMITS.archiveBytes}-byte safety limit.`,
      file.name,
    );
  }
  try {
    return buildReceiverDocument(await verify(bytes));
  } catch (error) {
    if (error instanceof EvidenceBundleLoadError) throw error;
    throw new EvidenceBundleLoadError(
      "WORKER_FAILURE",
      "ReplayCase could not verify the selected evidence bundle.",
      file.name,
      [error instanceof Error ? error.message : "Unknown evidence verification error."],
    );
  }
}
