import type { ParsedSession } from "../domain/types";
import { MAX_SESSION_FILE_BYTES } from "./session-file";
import {
  processSessionBlob,
  SessionProcessingCancelledError,
  SessionProcessingError,
} from "../processing/process-session";
import type { SessionProcessingProgress, SessionProcessingReport } from "../processing/contracts";

export { MAX_SESSION_FILE_BYTES } from "./session-file";

export const DEFAULT_SESSION_URL = "/fixtures/harbor-relay-session.json";

export class SessionLoadError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "SessionLoadError";
    this.details = details;
  }
}

export interface SessionLoadOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SessionProcessingProgress) => void;
  readonly onComplete?: (report: SessionProcessingReport) => void;
}

function sessionLimitMessage(): string {
  return `The replay exceeds the ${MAX_SESSION_FILE_BYTES / (1024 * 1024)} MiB safety limit.`;
}

async function processBlob(
  blob: Blob,
  sourceLabel: string,
  options: SessionLoadOptions,
): Promise<ParsedSession> {
  try {
    const processed = await processSessionBlob(blob, {
      sourceLabel,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    options.onComplete?.(processed.report);
    return processed.session;
  } catch (error) {
    if (error instanceof SessionProcessingCancelledError) throw error;
    if (error instanceof SessionProcessingError) {
      throw new SessionLoadError(error.message, [...error.details]);
    }
    throw new SessionLoadError("ReplayCase could not decode this replay.", [
      error instanceof Error ? error.message : "Unknown decoder error",
    ]);
  }
}

export async function loadBundledSession(
  signalOrOptions?: AbortSignal | SessionLoadOptions,
): Promise<ParsedSession> {
  const options: SessionLoadOptions = signalOrOptions instanceof AbortSignal
    ? { signal: signalOrOptions }
    : signalOrOptions ?? {};
  const response = await fetch(DEFAULT_SESSION_URL, { signal: options.signal });
  if (!response.ok) {
    throw new SessionLoadError("The bundled replay is unavailable.", [`HTTP ${response.status} ${response.statusText}`]);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_SESSION_FILE_BYTES) {
    throw new SessionLoadError(sessionLimitMessage());
  }
  const blob = await response.blob();
  if (blob.size > MAX_SESSION_FILE_BYTES) {
    throw new SessionLoadError(sessionLimitMessage());
  }
  return processBlob(blob, DEFAULT_SESSION_URL, options);
}

export async function loadSessionFile(
  file: File,
  options: SessionLoadOptions = {},
): Promise<ParsedSession> {
  if (file.size > MAX_SESSION_FILE_BYTES) {
    throw new SessionLoadError(sessionLimitMessage(), [file.name]);
  }
  return processBlob(file, file.name, options);
}
