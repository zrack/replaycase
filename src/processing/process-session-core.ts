import { sha256Hex } from "../domain/canonical";
import { MAX_SESSION_FILE_BYTES } from "../domain/limits";
import {
  parseSession,
  SessionValidationError,
  type SessionDerivationPhase,
} from "../domain/session";
import type { ParsedSession } from "../domain/types";
import { serializeSessionDocument } from "../data/session-file";
import {
  processingProgress,
  type SessionProcessingProgress,
  type SessionProcessingReport,
} from "./contracts";
import type { CanonicalSessionArtifact } from "./session-artifact";

const UTF8_ENCODER = new TextEncoder();

export type SessionProcessingErrorCode =
  | "LIMIT_EXCEEDED"
  | "INVALID_UTF8"
  | "INVALID_JSON"
  | "VALIDATION_FAILED"
  | "IO_ERROR"
  | "PROCESSING_FAILED";

export class SessionProcessingCoreError extends Error {
  readonly code: SessionProcessingErrorCode;
  readonly details: readonly string[];

  constructor(
    code: SessionProcessingErrorCode,
    message: string,
    details: readonly string[] = [],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionProcessingCoreError";
    this.code = code;
    this.details = details;
  }
}

export interface ProcessedSessionResult {
  readonly session: ParsedSession;
  readonly artifact: CanonicalSessionArtifact;
  readonly report: SessionProcessingReport;
}

export interface ProcessSessionCoreOptions {
  readonly sourceLabel: string;
  readonly onProgress?: (progress: SessionProcessingProgress) => void;
}

function elapsed(start: number): number {
  return Math.max(0, performance.now() - start);
}

async function readBoundedBlob(
  blob: Blob,
  onProgress: ProcessSessionCoreOptions["onProgress"],
): Promise<Uint8Array> {
  if (blob.size > MAX_SESSION_FILE_BYTES) {
    throw new SessionProcessingCoreError(
      "LIMIT_EXCEEDED",
      `The replay exceeds the ${MAX_SESSION_FILE_BYTES}-byte safety limit.`,
    );
  }
  const output = new Uint8Array(blob.size);
  let offset = 0;
  onProgress?.(processingProgress("reading", 0, blob.size));
  try {
    if (typeof blob.stream === "function") {
      const reader = blob.stream().getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (offset + chunk.value.byteLength > output.byteLength) {
          throw new SessionProcessingCoreError(
            "IO_ERROR",
            "The replay changed while its source bytes were being read.",
          );
        }
        output.set(chunk.value, offset);
        offset += chunk.value.byteLength;
        onProgress?.(processingProgress("reading", offset, blob.size));
      }
    } else {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      output.set(bytes);
      offset = bytes.byteLength;
      onProgress?.(processingProgress("reading", offset, blob.size));
    }
  } catch (error) {
    if (error instanceof SessionProcessingCoreError) throw error;
    throw new SessionProcessingCoreError(
      "IO_ERROR",
      "The replay source bytes could not be read.",
      [],
      error,
    );
  }
  if (offset !== blob.size) {
    throw new SessionProcessingCoreError(
      "IO_ERROR",
      "The replay byte count changed while it was being read.",
      [`Expected ${blob.size} bytes; received ${offset}.`],
    );
  }
  onProgress?.(processingProgress("reading", blob.size, blob.size));
  return output;
}

function decodeUtf8(bytes: Uint8Array, sourceLabel: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SessionProcessingCoreError(
      "INVALID_UTF8",
      "The replay is not valid UTF-8 text.",
      [sourceLabel],
    );
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new SessionProcessingCoreError(
      "INVALID_JSON",
      "The selected file is not valid JSON.",
      [error instanceof Error ? error.message : "JSON parsing failed."],
      error,
    );
  }
}

function processingPhase(phase: SessionDerivationPhase): "validating" | "decoding" | "aggregating" {
  return phase;
}

export async function processSessionBlobCore(
  blob: Blob,
  options: ProcessSessionCoreOptions,
): Promise<ProcessedSessionResult> {
  const startedAt = performance.now();
  const readingStartedAt = performance.now();
  const sourceBytes = await readBoundedBlob(blob, options.onProgress);
  const readingMs = elapsed(readingStartedAt);

  const parsingStartedAt = performance.now();
  options.onProgress?.(processingProgress("parsing", 0, 1));
  const text = decodeUtf8(sourceBytes, options.sourceLabel);
  const input = parseJson(text);
  options.onProgress?.(processingProgress("parsing", 1, 1));
  const parsingMs = elapsed(parsingStartedAt);

  const derivationStartedAt = performance.now();
  let parsed: ParsedSession;
  try {
    parsed = parseSession(input, {
      report(phase, completed, total) {
        options.onProgress?.(processingProgress(processingPhase(phase), completed, total));
      },
    });
  } catch (error) {
    if (error instanceof SessionValidationError) {
      throw new SessionProcessingCoreError(
        "VALIDATION_FAILED",
        error.message,
        error.details,
        error,
      );
    }
    throw new SessionProcessingCoreError(
      "PROCESSING_FAILED",
      "ReplayCase could not decode this replay.",
      [error instanceof Error ? error.message : "Unknown decoder error."],
      error,
    );
  }
  const validatingAndDecodingMs = elapsed(derivationStartedAt);

  const canonicalizingStartedAt = performance.now();
  options.onProgress?.(processingProgress("canonicalizing", 0, 3));
  const canonicalText = serializeSessionDocument(parsed.document);
  options.onProgress?.(processingProgress("canonicalizing", 1, 3));
  const sourceWasCanonical = canonicalText === text;
  const canonicalBytes = sourceWasCanonical ? sourceBytes : UTF8_ENCODER.encode(canonicalText);
  const identity = `sha256:${sha256Hex(canonicalBytes)}`;
  options.onProgress?.(processingProgress("canonicalizing", 2, 3));
  const canonicalBlob = sourceWasCanonical
    ? blob
    : new Blob([
        canonicalBytes.buffer.slice(
          canonicalBytes.byteOffset,
          canonicalBytes.byteOffset + canonicalBytes.byteLength,
        ) as ArrayBuffer,
      ], { type: "application/json" });
  const session: ParsedSession = Object.freeze({
    ...parsed,
    canonicalIdentity: identity,
    canonicalByteLength: canonicalBytes.byteLength,
  });
  options.onProgress?.(processingProgress("canonicalizing", 3, 3));
  const canonicalizingMs = elapsed(canonicalizingStartedAt);

  return {
    session,
    artifact: {
      blob: canonicalBlob,
      identity,
      byteLength: canonicalBytes.byteLength,
      sourceWasCanonical,
    },
    report: {
      sourceBytes: sourceBytes.byteLength,
      canonicalBytes: canonicalBytes.byteLength,
      recordCount: session.document.records.length,
      sourceWasCanonical,
      timings: {
        readingMs,
        parsingMs,
        validatingAndDecodingMs,
        canonicalizingMs,
        totalMs: elapsed(startedAt),
      },
    },
  };
}
