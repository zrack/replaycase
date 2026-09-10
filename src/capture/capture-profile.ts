import { z } from "zod";

import { verifyDecoderPackConformance } from "../domain/decoder-conformance";
import {
  decoderPackDocumentSchema,
  type DecoderPackDocument,
} from "../domain/decoder-pack";

export const CAPTURE_PROFILE_FORMAT = "narrowslink/capture-profile";
export const CAPTURE_PROFILE_FORMAT_VERSION = 1;
export const CAPTURE_PROFILE_STORAGE_KEY = "narrowslink.capture-profiles.v1";
export const MAX_CAPTURE_PROFILES = 16;
export const MAX_CAPTURE_PROFILE_STORAGE_BYTES = 2 * 1024 * 1024;

const timestampSchema = z.string().max(64).refine(
  (value) => Number.isFinite(Date.parse(value)),
  "Capture profile timestamps must be valid ISO timestamps.",
);

const udpSettingsSchema = z.object({
  transport: z.literal("udp"),
  host: z.string().min(1).max(253),
  port: z.number().int().min(0).max(65_535),
  multicastGroup: z.string().min(1).max(253).nullable(),
  multicastInterface: z.string().min(1).max(253).nullable(),
}).strict();

const serialSettingsSchema = z.object({
  transport: z.literal("serial"),
  baudRate: z.number().int().min(1).max(4_000_000),
  dataBits: z.union([z.literal(7), z.literal(8)]),
  stopBits: z.union([z.literal(1), z.literal(2)]),
  parity: z.enum(["none", "even", "odd"]),
  flowControl: z.enum(["none", "hardware"]),
}).strict();

export const captureProfileDocumentSchema = z.object({
  format: z.literal(CAPTURE_PROFILE_FORMAT),
  formatVersion: z.literal(CAPTURE_PROFILE_FORMAT_VERSION),
  id: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(80),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  decoderPack: decoderPackDocumentSchema,
  settings: z.discriminatedUnion("transport", [
    udpSettingsSchema,
    serialSettingsSchema,
  ]),
}).strict();

const captureProfileCollectionSchema = z.object({
  format: z.literal("narrowslink/capture-profiles"),
  formatVersion: z.literal(1),
  profiles: z.array(captureProfileDocumentSchema).max(MAX_CAPTURE_PROFILES),
}).strict();

export type CaptureProfileDocument = z.infer<typeof captureProfileDocumentSchema>;
export type CaptureProfileSettings = CaptureProfileDocument["settings"];

export interface CaptureProfileStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type CaptureProfileStorageErrorCode =
  | "unavailable"
  | "corrupt"
  | "too-large"
  | "quota"
  | "write-failed";

export class CaptureProfileStorageError extends Error {
  readonly code: CaptureProfileStorageErrorCode;

  constructor(code: CaptureProfileStorageErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CaptureProfileStorageError";
    this.code = code;
  }
}

export interface CreateCaptureProfileInput {
  id?: string;
  name: string;
  decoderPack: DecoderPackDocument;
  settings: CaptureProfileSettings;
  createdAt?: string;
  updatedAt?: string;
  now?: () => Date;
}

const encoder = new TextEncoder();

function defaultStorage(): CaptureProfileStorageLike | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function storageFrom(
  storage: CaptureProfileStorageLike | null | undefined,
): CaptureProfileStorageLike {
  const target = storage === undefined ? defaultStorage() : storage;
  if (!target) {
    throw new CaptureProfileStorageError(
      "unavailable",
      "Local capture-profile storage is unavailable. Capture remains usable without saved profiles.",
    );
  }
  return target;
}

function errorName(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("name" in error)) return null;
  return typeof error.name === "string" ? error.name : null;
}

function profileId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `profile-${random}`;
}

function validateProfile(input: unknown): CaptureProfileDocument {
  const result = captureProfileDocumentSchema.safeParse(input);
  if (!result.success) {
    throw new CaptureProfileStorageError(
      "corrupt",
      `A capture profile is invalid: ${result.error.issues[0]?.message ?? "schema validation failed"}`,
    );
  }
  try {
    verifyDecoderPackConformance(result.data.decoderPack);
  } catch (error) {
    throw new CaptureProfileStorageError(
      "corrupt",
      "A capture profile contains an incompatible or altered decoder pack.",
      error,
    );
  }
  return result.data;
}

function serializeProfiles(profiles: readonly CaptureProfileDocument[]): string {
  const value = JSON.stringify({
    format: "narrowslink/capture-profiles",
    formatVersion: 1,
    profiles,
  });
  if (encoder.encode(value).byteLength > MAX_CAPTURE_PROFILE_STORAGE_BYTES) {
    throw new CaptureProfileStorageError(
      "too-large",
      "Saved capture profiles exceed the 2 MiB local profile budget. Remove a profile or use a smaller decoder pack.",
    );
  }
  return value;
}

function parseProfiles(value: string): CaptureProfileDocument[] {
  if (encoder.encode(value).byteLength > MAX_CAPTURE_PROFILE_STORAGE_BYTES) {
    throw new CaptureProfileStorageError(
      "corrupt",
      "Stored capture profiles exceed the supported 2 MiB limit.",
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(value) as unknown;
  } catch (error) {
    throw new CaptureProfileStorageError(
      "corrupt",
      "Stored capture profiles are not valid JSON.",
      error,
    );
  }
  const result = captureProfileCollectionSchema.safeParse(input);
  if (!result.success) {
    throw new CaptureProfileStorageError(
      "corrupt",
      `Stored capture profiles are invalid: ${result.error.issues[0]?.message ?? "schema validation failed"}`,
    );
  }
  const ids = new Set<string>();
  return result.data.profiles.map((profile) => {
    if (ids.has(profile.id)) {
      throw new CaptureProfileStorageError("corrupt", "Stored capture profile identifiers are duplicated.");
    }
    ids.add(profile.id);
    return validateProfile(profile);
  });
}

function writeProfiles(
  profiles: readonly CaptureProfileDocument[],
  storage: CaptureProfileStorageLike,
): void {
  const value = serializeProfiles(profiles);
  try {
    storage.setItem(CAPTURE_PROFILE_STORAGE_KEY, value);
  } catch (error) {
    if (errorName(error) === "QuotaExceededError") {
      throw new CaptureProfileStorageError(
        "quota",
        "The browser has no space left for capture profiles. Existing capture and session data were not changed.",
        error,
      );
    }
    throw new CaptureProfileStorageError(
      "write-failed",
      "The capture profile could not be saved locally.",
      error,
    );
  }
}

export function createCaptureProfile(input: CreateCaptureProfileInput): CaptureProfileDocument {
  const now = input.now?.() ?? new Date();
  const createdAt = input.createdAt ?? now.toISOString();
  const updatedAt = input.updatedAt ?? now.toISOString();
  return validateProfile({
    format: CAPTURE_PROFILE_FORMAT,
    formatVersion: CAPTURE_PROFILE_FORMAT_VERSION,
    id: input.id ?? profileId(),
    name: input.name.trim(),
    createdAt,
    updatedAt,
    decoderPack: input.decoderPack,
    settings: input.settings,
  });
}

export function loadCaptureProfiles(
  storage?: CaptureProfileStorageLike | null,
): CaptureProfileDocument[] {
  const target = storageFrom(storage);
  let value: string | null;
  try {
    value = target.getItem(CAPTURE_PROFILE_STORAGE_KEY);
  } catch (error) {
    throw new CaptureProfileStorageError(
      "unavailable",
      "Local capture-profile storage could not be read. Capture remains usable without saved profiles.",
      error,
    );
  }
  if (value == null) return [];
  return parseProfiles(value)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt, "en"));
}

export function saveCaptureProfile(
  profile: CaptureProfileDocument,
  storage?: CaptureProfileStorageLike | null,
): CaptureProfileDocument[] {
  const target = storageFrom(storage);
  const validated = validateProfile(profile);
  const current = loadCaptureProfiles(target);
  const existingIndex = current.findIndex((candidate) => candidate.id === validated.id);
  const next = existingIndex >= 0
    ? current.map((candidate, index) => index === existingIndex ? validated : candidate)
    : [validated, ...current];
  if (next.length > MAX_CAPTURE_PROFILES) {
    throw new CaptureProfileStorageError(
      "too-large",
      `ReplayCase supports up to ${MAX_CAPTURE_PROFILES} saved capture profiles.`,
    );
  }
  next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt, "en"));
  writeProfiles(next, target);
  return next;
}

export function removeCaptureProfile(
  profileIdToRemove: string,
  storage?: CaptureProfileStorageLike | null,
): CaptureProfileDocument[] {
  const target = storageFrom(storage);
  const current = loadCaptureProfiles(target);
  const next = current.filter((profile) => profile.id !== profileIdToRemove);
  if (next.length === current.length) return current;
  if (next.length === 0) {
    try {
      target.removeItem(CAPTURE_PROFILE_STORAGE_KEY);
    } catch (error) {
      throw new CaptureProfileStorageError(
        "write-failed",
        "The capture profile could not be removed from local storage.",
        error,
      );
    }
    return [];
  }
  writeProfiles(next, target);
  return next;
}

export function clearCaptureProfiles(
  storage?: CaptureProfileStorageLike | null,
): void {
  const target = storageFrom(storage);
  try {
    target.removeItem(CAPTURE_PROFILE_STORAGE_KEY);
  } catch (error) {
    throw new CaptureProfileStorageError(
      "write-failed",
      "Saved capture profiles could not be reset.",
      error,
    );
  }
}
