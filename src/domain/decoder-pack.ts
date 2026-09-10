import { z } from "zod";

import { canonicalJson, canonicalSha256 } from "./canonical";

export const DECODER_PACK_FORMAT = "narrowslink/decoder-pack";
export const DECODER_PACK_FORMAT_VERSION = 1;
export const MAX_DECODER_PACK_BYTES = 512 * 1024;
export const MAX_DECODER_PACK_FIXTURES = 32;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "SHA-256 values must use 64 lowercase hexadecimal characters");
const legacySha256Schema = z.string().regex(/^[0-9a-fA-F]{64}$/, "SHA-256 values must use 64 hexadecimal characters");
const boundedText = (maximum: number) => z.string().min(1).max(maximum);

export const decoderRuntimeSchema = z.object({
  id: z.enum(["nsl01-binary-v1", "nmea0183-line-v1"]),
  revision: z.literal("1"),
}).strict();

export type DecoderRuntimeDescriptor = z.infer<typeof decoderRuntimeSchema>;

export const decoderDescriptorSchema = z.object({
  id: boundedText(128),
  revision: boundedText(64),
  schemaHash: legacySha256Schema,
  packHash: sha256Schema.optional(),
  runtimeId: decoderRuntimeSchema.shape.id.optional(),
  runtimeRevision: decoderRuntimeSchema.shape.revision.optional(),
}).strict().superRefine((descriptor, context) => {
  const packFields = [
    descriptor.packHash,
    descriptor.runtimeId,
    descriptor.runtimeRevision,
  ];
  const present = packFields.filter((value) => value != null).length;
  if (present !== 0 && present !== packFields.length) {
    context.addIssue({
      code: "custom",
      message: "Pack hash, runtime id, and runtime revision must be declared together.",
    });
  }
});

export type DecoderDescriptor = z.infer<typeof decoderDescriptorSchema>;

const decoderPackFramingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("binary-frame"),
    maxRecordBytes: z.number().int().positive().max(65_550),
    serialAssembly: z.literal("nsl01-sync-length"),
  }).strict(),
  z.object({
    kind: z.literal("delimited-text"),
    maxRecordBytes: z.number().int().positive().max(65_550),
    serialAssembly: z.literal("line-feed"),
    prefix: z.string().length(1),
    checksumDelimiter: z.string().length(1),
  }).strict(),
]);

export type DecoderPackFraming = z.infer<typeof decoderPackFramingSchema>;

const expectedFieldValueSchema = z.union([
  z.number().finite(),
  z.string().max(2_000),
  z.boolean(),
  z.null(),
]);

const decoderPackFixtureSchema = z.object({
  id: boundedText(128),
  title: boundedText(240),
  transport: z.enum(["udp", "serial", "file"]),
  records: z.array(z.object({
    offsetUs: z.number().int().nonnegative().max(86_399_999_999).safe(),
    dataHex: z.string().min(2).max(131_100).regex(/^(?:[0-9a-fA-F]{2})+$/),
  }).strict()).min(1).max(32),
  expectedFrames: z.array(z.object({
    status: z.enum(["complete", "partial", "invalid"]),
    integrity: z.enum([
      "valid",
      "crc-failed",
      "checksum-failed",
      "truncated",
      "invalid-length",
      "unknown-family",
      "unsupported-version",
    ]),
    familyName: boundedText(240),
    fields: z.record(boundedText(128), expectedFieldValueSchema),
  }).strict()).min(1).max(32),
  expectedDiagnostics: z.array(boundedText(128)).max(64),
}).strict().superRefine((fixture, context) => {
  if (fixture.records.length !== fixture.expectedFrames.length) {
    context.addIssue({
      code: "custom",
      path: ["expectedFrames"],
      message: "Each fixture record must have exactly one expected decoded frame.",
    });
  }
  for (const [index, frame] of fixture.expectedFrames.entries()) {
    if (Object.keys(frame.fields).length > 100) {
      context.addIssue({
        code: "custom",
        path: ["expectedFrames", index, "fields"],
        message: "Fixture frames cannot declare more than 100 expected fields.",
      });
    }
  }
});

const decoderPackIntegritySchema = z.object({
  algorithm: z.literal("SHA-256"),
  canonicalSha256: sha256Schema,
}).strict();

export const decoderPackDocumentSchema = z.object({
  format: z.literal(DECODER_PACK_FORMAT),
  formatVersion: z.literal(DECODER_PACK_FORMAT_VERSION),
  id: boundedText(128),
  revision: boundedText(64),
  displayName: boundedText(160),
  description: boundedText(1_000),
  runtime: decoderRuntimeSchema,
  framing: decoderPackFramingSchema,
  schema: z.unknown(),
  fixtures: z.array(decoderPackFixtureSchema).min(1).max(MAX_DECODER_PACK_FIXTURES),
  integrity: decoderPackIntegritySchema,
}).strict().superRefine((pack, context) => {
  const bytes = new TextEncoder().encode(canonicalJson(pack)).byteLength;
  if (bytes > MAX_DECODER_PACK_BYTES) {
    context.addIssue({
      code: "custom",
      message: `Decoder pack exceeds the ${MAX_DECODER_PACK_BYTES}-byte canonical size limit.`,
    });
  }
  if (pack.runtime.id === "nsl01-binary-v1" && pack.framing.kind !== "binary-frame") {
    context.addIssue({
      code: "custom",
      path: ["framing", "kind"],
      message: "The NSL-01 runtime requires binary-frame framing.",
    });
  }
  if (pack.runtime.id === "nmea0183-line-v1" && pack.framing.kind !== "delimited-text") {
    context.addIssue({
      code: "custom",
      path: ["framing", "kind"],
      message: "The NMEA 0183 runtime requires delimited-text framing.",
    });
  }
});

export type DecoderPackDocument = z.infer<typeof decoderPackDocumentSchema>;
export type DecoderPackDraft = Omit<DecoderPackDocument, "integrity">;
export type DecoderPackFixture = DecoderPackDocument["fixtures"][number];

export class DecoderPackValidationError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "DecoderPackValidationError";
    this.details = details;
  }
}

function packIdentityPayload(pack: DecoderPackDraft | DecoderPackDocument): DecoderPackDraft {
  const { integrity: _integrity, ...payload } = pack as DecoderPackDocument;
  return payload;
}

export function decoderPackHash(pack: DecoderPackDraft | DecoderPackDocument): string {
  return canonicalSha256(packIdentityPayload(pack));
}

export function decoderSchemaHash(pack: DecoderPackDocument): string {
  return canonicalSha256(pack.schema);
}

export function parseBoundedDecoderPackJson(text: string): unknown {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_DECODER_PACK_BYTES) {
    throw new DecoderPackValidationError(
      `Decoder pack JSON exceeds the ${MAX_DECODER_PACK_BYTES}-byte input limit.`,
    );
  }
  if (text.startsWith("\uFEFF") || text.includes("\0")) {
    throw new DecoderPackValidationError("Decoder pack JSON cannot contain a byte-order mark or NUL character.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > 64) {
        throw new DecoderPackValidationError("Decoder pack JSON exceeds the 64-level nesting limit.");
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) throw new DecoderPackValidationError("Decoder pack JSON structure is invalid.");
    }
  }
  if (inString || depth !== 0) throw new DecoderPackValidationError("Decoder pack JSON structure is invalid.");

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new DecoderPackValidationError(
      "Decoder pack input is not valid JSON.",
      [error instanceof Error ? error.message : "JSON parsing failed."],
    );
  }
}

export function sealDecoderPack(input: DecoderPackDraft | unknown): DecoderPackDocument {
  if (typeof input !== "object" || input == null || Array.isArray(input)) {
    throw new DecoderPackValidationError("Decoder pack draft must be a JSON object.");
  }
  const { integrity: _integrity, ...draft } = input as DecoderPackDocument;
  return validateDecoderPack({
    ...draft,
    integrity: {
      algorithm: "SHA-256",
      canonicalSha256: decoderPackHash(draft),
    },
  });
}

export function validateDecoderPack(input: unknown): DecoderPackDocument {
  const result = decoderPackDocumentSchema.safeParse(input);
  if (!result.success) {
    throw new DecoderPackValidationError(
      "The file is not a supported ReplayCase decoder pack.",
      result.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "pack"}: ${issue.message}`),
    );
  }
  const pack = result.data;
  const actualHash = decoderPackHash(pack);
  if (actualHash !== pack.integrity.canonicalSha256) {
    throw new DecoderPackValidationError("The decoder pack content does not match its declared identity.", [
      `Declared ${pack.integrity.canonicalSha256}`,
      `Calculated ${actualHash}`,
    ]);
  }
  return pack;
}

export function decoderDescriptorForPack(pack: DecoderPackDocument): DecoderDescriptor {
  return {
    id: pack.id,
    revision: pack.revision,
    schemaHash: decoderSchemaHash(pack),
    packHash: pack.integrity.canonicalSha256,
    runtimeId: pack.runtime.id,
    runtimeRevision: pack.runtime.revision,
  };
}

export function descriptorMatchesPack(
  descriptor: DecoderDescriptor,
  pack: DecoderPackDocument,
): boolean {
  const expected = decoderDescriptorForPack(pack);
  return descriptor.id === expected.id
    && descriptor.revision === expected.revision
    && descriptor.schemaHash.toLowerCase() === expected.schemaHash
    && descriptor.packHash?.toLowerCase() === expected.packHash
    && descriptor.runtimeId === expected.runtimeId
    && descriptor.runtimeRevision === expected.runtimeRevision;
}

export function serializeDecoderPack(pack: DecoderPackDocument): string {
  return `${canonicalJson(validateDecoderPack(pack), true)}\n`;
}
