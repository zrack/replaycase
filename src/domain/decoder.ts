import { z } from "zod";

import {
  DecoderPackValidationError,
  decoderSchemaHash,
  descriptorMatchesPack,
  sealDecoderPack,
  validateDecoderPack,
  type DecoderDescriptor,
  type DecoderPackDocument,
  type DecoderPackDraft,
} from "./decoder-pack";
import type { DecodedField, DecodedFrame, FamilyId, SourceRecord } from "./types";

const SYNC_A = 0xa5;
const SYNC_B = 0x5a;
const PROTOCOL_VERSION = 1;
const HEADER_BYTES = 12;
const CHECKSUM_BYTES = 2;

const DECODER_ID = "NSL-01";
const DECODER_REVISION = "v1.3.7";

export const familyNames: Record<FamilyId, string> = {
  0x02: "Heartbeat",
  0x17: "Power",
  0x19: "Attitude",
  0x31: "Position",
  0x44: "Thermal",
};

/** Canonical, versioned byte-level schema used by both decoding and evidence export. */
export const DECODER_SCHEMA = Object.freeze({
  id: DECODER_ID,
  revision: DECODER_REVISION,
  byteOrder: "little-endian",
  checksum: "CRC-16/CCITT-FALSE over bytes [protocolVersion, checksum)",
  envelope: [
    { name: "sync", offset: 0, type: "uint16", byteOrder: "big-endian", fixedHex: "A55A" },
    { name: "protocolVersion", offset: 2, type: "uint8", fixed: 1 },
    { name: "familyId", offset: 3, type: "uint8" },
    { name: "sequence", offset: 4, type: "uint16" },
    { name: "payloadLength", offset: 6, type: "uint16", unit: "bytes" },
    { name: "deviceTimeMs", offset: 8, type: "uint32", unit: "ms" },
    { name: "payload", offset: 12, type: "bytes", lengthFrom: "payloadLength" },
    { name: "checksum", offsetFromEnd: 2, type: "uint16" },
  ],
  families: {
    "0x02": {
      name: "Heartbeat",
      payloadBytes: 8,
      fields: [
        { name: "uptime", offset: 0, type: "uint32", scale: 1, unit: "s" },
        { name: "mode", offset: 4, type: "uint8", enum: { 0: "Boot", 1: "Standby", 2: "Nominal", 3: "Safe" } },
        { name: "flags", offset: 5, type: "uint8", presentation: "hex" },
        { name: "decoderRevision", offset: 6, type: "uint16", scale: 1 },
      ],
    },
    "0x17": {
      name: "Power",
      payloadBytes: 9,
      fields: [
        { name: "busVoltage", offset: 0, type: "uint16", scale: 0.001, unit: "V" },
        { name: "busCurrent", offset: 2, type: "int16", scale: 0.001, unit: "A" },
        { name: "battery", offset: 4, type: "uint8", scale: 1, unit: "%", bounds: [0, 100] },
        { name: "boardTemp", offset: 5, type: "int16", scale: 0.01, unit: "°C" },
        { name: "inputVoltage", offset: 7, type: "uint16", scale: 0.001, unit: "V" },
      ],
    },
    "0x19": {
      name: "Attitude",
      payloadBytes: 16,
      fields: [
        { name: "roll", offset: 0, type: "int16", scale: 0.01, unit: "deg" },
        { name: "pitch", offset: 2, type: "int16", scale: 0.01, unit: "deg" },
        { name: "yaw", offset: 4, type: "int16", scale: 0.01, unit: "deg" },
        { name: "rollRate", offset: 6, type: "int16", scale: 0.01, unit: "deg/s" },
        { name: "pitchRate", offset: 8, type: "int16", scale: 0.01, unit: "deg/s" },
        { name: "yawRate", offset: 10, type: "int16", scale: 0.01, unit: "deg/s" },
        { name: "verticalAcceleration", offset: 12, type: "int16", scale: 0.001, unit: "g" },
        { name: "attitudeStatus", offset: 14, type: "uint16", presentation: "hex" },
      ],
    },
    "0x31": {
      name: "Position",
      payloadBytes: 24,
      fields: [
        { name: "latitude", offset: 0, type: "int32", scale: 1e-7, unit: "deg" },
        { name: "longitude", offset: 4, type: "int32", scale: 1e-7, unit: "deg" },
        { name: "altitude", offset: 8, type: "int32", scale: 0.001, unit: "m" },
        { name: "velocityNorth", offset: 12, type: "int16", scale: 0.01, unit: "m/s" },
        { name: "velocityEast", offset: 14, type: "int16", scale: 0.01, unit: "m/s" },
        { name: "velocityDown", offset: 16, type: "int16", scale: 0.01, unit: "m/s" },
        { name: "heading", offset: 18, type: "uint16", scale: 0.01, unit: "deg" },
        { name: "groundSpeed", offset: 20, type: "uint16", scale: 0.01, unit: "m/s" },
        { name: "fix", offset: 22, type: "uint8", scale: 1, bounds: [0, 4] },
        { name: "satellites", offset: 23, type: "uint8", scale: 1 },
      ],
    },
    "0x44": {
      name: "Thermal",
      payloadBytes: 10,
      fields: [
        { name: "avionicsTemp", offset: 0, type: "int16", scale: 0.01, unit: "°C" },
        { name: "radioTemp", offset: 2, type: "int16", scale: 0.01, unit: "°C" },
        { name: "batteryTemp", offset: 4, type: "int16", scale: 0.01, unit: "°C" },
        { name: "ambientTemp", offset: 6, type: "int16", scale: 0.01, unit: "°C" },
        { name: "fan", offset: 8, type: "uint8", scale: 1, unit: "%" },
        { name: "thermalStatus", offset: 9, type: "uint8", presentation: "hex" },
      ],
    },
  },
} as const);

/** SHA-256 of canonical DECODER_SCHEMA JSON (recursive code-unit key order, no whitespace). */
export const SUPPORTED_DECODER = Object.freeze({
  id: DECODER_ID,
  revision: DECODER_REVISION,
  schemaHash: "822aa1bf895ae52908913906ae853098a0527afa4925a134a9220847a6a9b9d4",
});

const NSL01_PACK_DRAFT = {
  format: "narrowslink/decoder-pack",
  formatVersion: 1,
  id: DECODER_ID,
  revision: DECODER_REVISION,
  displayName: "NSL-01",
  // Published pack metadata is content-addressed; a brand edit would change its identity.
  description: "NarrowsLink reference binary telemetry envelope and five packet families.",
  runtime: {
    id: "nsl01-binary-v1",
    revision: "1",
  },
  framing: {
    kind: "binary-frame",
    maxRecordBytes: 38,
    serialAssembly: "nsl01-sync-length",
  },
  schema: DECODER_SCHEMA,
  fixtures: [{
    id: "nsl01-position-valid",
    title: "Valid NSL-01 position frame",
    transport: "file",
    records: [{
      offsetUs: 100_000,
      dataHex: "A55A0131409C180058000000A15F2C1C6A2BF8B65ED302008E05FC0301006B10D606030D5B50",
    }],
    expectedFrames: [{
      status: "complete",
      integrity: "valid",
      familyName: "Position",
      fields: {},
    }],
    expectedDiagnostics: [],
  }],
} as const satisfies DecoderPackDraft;

export const NMEA0183_SCHEMA = Object.freeze({
  id: "NMEA-0183",
  revision: "reference-v1",
  standard: "NMEA 0183",
  checksum: "XOR-8 over ASCII bytes between '$' and '*'",
  sentenceId: "last three characters of the talker-and-type field",
  sentences: {
    GGA: {
      name: "Global Positioning System Fix Data",
      fields: [
        { name: "utcTime", index: 1, type: "string" },
        { name: "latitude", index: 2, companionIndex: 3, type: "latitude", unit: "deg", bounds: [-90, 90] },
        { name: "longitude", index: 4, companionIndex: 5, type: "longitude", unit: "deg", bounds: [-180, 180] },
        { name: "fixQuality", index: 6, type: "integer", bounds: [0, 8] },
        { name: "satellites", index: 7, type: "integer", bounds: [0, 99] },
        { name: "hdop", index: 8, type: "number" },
        { name: "altitude", index: 9, type: "number", unit: "m" },
        { name: "geoidSeparation", index: 11, type: "number", unit: "m" },
      ],
    },
    RMC: {
      name: "Recommended Minimum Navigation Information",
      fields: [
        { name: "utcTime", index: 1, type: "string" },
        { name: "navigationStatus", index: 2, type: "enum", enum: { A: "Active", V: "Void" } },
        { name: "latitude", index: 3, companionIndex: 4, type: "latitude", unit: "deg", bounds: [-90, 90] },
        { name: "longitude", index: 5, companionIndex: 6, type: "longitude", unit: "deg", bounds: [-180, 180] },
        { name: "groundSpeed", index: 7, type: "number", scale: 0.514444, unit: "m/s" },
        { name: "heading", index: 8, type: "number", unit: "deg", bounds: [0, 360] },
        { name: "date", index: 9, type: "string" },
      ],
    },
    HDT: {
      name: "Heading True",
      fields: [
        { name: "heading", index: 1, type: "number", unit: "deg", bounds: [0, 360] },
        { name: "reference", index: 2, type: "enum", enum: { T: "True" } },
      ],
    },
  },
} as const);

const NMEA0183_PACK_DRAFT = {
  format: "narrowslink/decoder-pack",
  formatVersion: 1,
  id: "NMEA-0183",
  revision: "reference-v1",
  displayName: "NMEA 0183 reference",
  description: "Bounded reference decoder for checksummed GGA, RMC, and HDT NMEA 0183 sentences.",
  runtime: {
    id: "nmea0183-line-v1",
    revision: "1",
  },
  framing: {
    kind: "delimited-text",
    maxRecordBytes: 256,
    serialAssembly: "line-feed",
    prefix: "$",
    checksumDelimiter: "*",
  },
  schema: NMEA0183_SCHEMA,
  fixtures: [
    {
      id: "nmea-gga-valid",
      title: "Valid GGA position sentence",
      transport: "file",
      records: [{
        offsetUs: 100_000,
        dataHex: "2447504747412C3132333531392C343830372E3033382C4E2C30313133312E3030302C452C312C30382C302E392C3534352E342C4D2C34362E392C4D2C2C2A34370D0A",
      }],
      expectedFrames: [{
        status: "complete",
        integrity: "valid",
        familyName: "NMEA GGA · Global Positioning System Fix Data",
        fields: {
          latitude: 48.1173,
          longitude: 11.516666666666667,
          altitude: 545.4,
          satellites: 8,
        },
      }],
      expectedDiagnostics: [],
    },
    {
      id: "nmea-rmc-valid",
      title: "Valid RMC navigation sentence",
      transport: "file",
      records: [{
        offsetUs: 200_000,
        dataHex: "244750524D432C3132333532302C412C343830372E3033382C4E2C30313133312E3030302C452C3032322E342C3038342E342C3233303339342C3030332E312C572A36300D0A",
      }],
      expectedFrames: [{
        status: "complete",
        integrity: "valid",
        familyName: "NMEA RMC · Recommended Minimum Navigation Information",
        fields: {
          navigationStatus: "Active",
          latitude: 48.1173,
          longitude: 11.516666666666667,
          groundSpeed: 11.5235456,
          heading: 84.4,
          date: "230394",
        },
      }],
      expectedDiagnostics: [],
    },
    {
      id: "nmea-rmc-checksum-failure",
      title: "RMC sentence with a mismatched checksum",
      transport: "file",
      records: [{
        offsetUs: 200_000,
        dataHex: "244750524D432C3132333531392C412C343830372E3033382C4E2C30313133312E3030302C452C3032322E342C3038342E342C3233303339342C3030332E312C572A30300D0A",
      }],
      expectedFrames: [{
        status: "invalid",
        integrity: "checksum-failed",
        familyName: "NMEA RMC · Recommended Minimum Navigation Information",
        fields: {},
      }],
      expectedDiagnostics: ["checksum-failure"],
    },
    {
      id: "nmea-hdt-valid",
      title: "Valid true-heading sentence",
      transport: "file",
      records: [{
        offsetUs: 300_000,
        dataHex: "2447504844542C3132332E342C542A33310D0A",
      }],
      expectedFrames: [{
        status: "complete",
        integrity: "valid",
        familyName: "NMEA HDT · Heading True",
        fields: {
          heading: 123.4,
          reference: "True",
        },
      }],
      expectedDiagnostics: [],
    },
  ],
} as const satisfies DecoderPackDraft;

function deepFreeze<T>(value: T): T {
  if (value == null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const NSL01_DECODER_PACK = deepFreeze(sealDecoderPack(NSL01_PACK_DRAFT));
export const NMEA0183_DECODER_PACK = deepFreeze(sealDecoderPack(NMEA0183_PACK_DRAFT));
export const BUILT_IN_DECODER_PACKS = Object.freeze([
  NSL01_DECODER_PACK,
  NMEA0183_DECODER_PACK,
]);

export function resolveDecoderPack(
  descriptor: DecoderDescriptor,
  embeddedPack?: DecoderPackDocument,
): DecoderPackDocument {
  if (embeddedPack != null) {
    const pack = validateDecoderPackRuntime(validateDecoderPack(embeddedPack));
    if (!descriptorMatchesPack(descriptor, pack)) {
      throw new DecoderPackValidationError("The session decoder descriptor does not match its embedded decoder pack.");
    }
    return pack;
  }

  const legacyNsl01 = descriptor.id === SUPPORTED_DECODER.id
    && descriptor.revision === SUPPORTED_DECODER.revision
    && descriptor.schemaHash.toLowerCase() === SUPPORTED_DECODER.schemaHash
    && descriptor.packHash == null
    && descriptor.runtimeId == null
    && descriptor.runtimeRevision == null;
  if (legacyNsl01) return validateDecoderPackRuntime(NSL01_DECODER_PACK);

  const builtIn = BUILT_IN_DECODER_PACKS.find((pack) => descriptorMatchesPack(descriptor, pack));
  if (builtIn) return validateDecoderPackRuntime(builtIn);
  throw new DecoderPackValidationError("The replay references an unavailable decoder pack.");
}

const familyPayloadBytes: Record<FamilyId, number> = {
  0x02: DECODER_SCHEMA.families["0x02"].payloadBytes,
  0x17: DECODER_SCHEMA.families["0x17"].payloadBytes,
  0x19: DECODER_SCHEMA.families["0x19"].payloadBytes,
  0x31: DECODER_SCHEMA.families["0x31"].payloadBytes,
  0x44: DECODER_SCHEMA.families["0x44"].payloadBytes,
};

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function crc16CcittFalse(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xffff;
  for (let index = start; index < end; index += 1) {
    crc ^= (bytes[index] ?? 0) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function field(
  name: string,
  raw: number | string | boolean,
  value: number | string | boolean | null,
  unit?: string,
  quality: DecodedField["quality"] = "valid",
): DecodedField {
  return { name, raw, value, unit, quality };
}

function decodeHeartbeat(view: DataView, offset: number): DecodedField[] {
  const modeNames = ["Boot", "Standby", "Nominal", "Safe"];
  const mode = view.getUint8(offset + 4);
  return [
    field("uptime", view.getUint32(offset, true), view.getUint32(offset, true), "s"),
    field("mode", mode, modeNames[mode] ?? `Unknown (${mode})`, undefined, mode < modeNames.length ? "valid" : "out-of-range"),
    field("flags", view.getUint8(offset + 5), `0x${view.getUint8(offset + 5).toString(16).padStart(2, "0")}`),
    field("decoderRevision", view.getUint16(offset + 6, true), view.getUint16(offset + 6, true)),
  ];
}

function decodePower(view: DataView, offset: number): DecodedField[] {
  const battery = view.getUint8(offset + 4);
  return [
    field("busVoltage", view.getUint16(offset, true), view.getUint16(offset, true) / 1000, "V"),
    field("busCurrent", view.getInt16(offset + 2, true), view.getInt16(offset + 2, true) / 1000, "A"),
    field("battery", battery, battery, "%", battery <= 100 ? "valid" : "out-of-range"),
    field("boardTemp", view.getInt16(offset + 5, true), view.getInt16(offset + 5, true) / 100, "°C"),
    field("inputVoltage", view.getUint16(offset + 7, true), view.getUint16(offset + 7, true) / 1000, "V"),
  ];
}

function decodeAttitude(view: DataView, offset: number): DecodedField[] {
  return [
    field("roll", view.getInt16(offset, true), view.getInt16(offset, true) / 100, "deg"),
    field("pitch", view.getInt16(offset + 2, true), view.getInt16(offset + 2, true) / 100, "deg"),
    field("yaw", view.getInt16(offset + 4, true), view.getInt16(offset + 4, true) / 100, "deg"),
    field("rollRate", view.getInt16(offset + 6, true), view.getInt16(offset + 6, true) / 100, "deg/s"),
    field("pitchRate", view.getInt16(offset + 8, true), view.getInt16(offset + 8, true) / 100, "deg/s"),
    field("yawRate", view.getInt16(offset + 10, true), view.getInt16(offset + 10, true) / 100, "deg/s"),
    field("verticalAcceleration", view.getInt16(offset + 12, true), view.getInt16(offset + 12, true) / 1000, "g"),
    field("attitudeStatus", view.getUint16(offset + 14, true), `0x${view.getUint16(offset + 14, true).toString(16).padStart(4, "0")}`),
  ];
}

function decodePosition(view: DataView, offset: number): DecodedField[] {
  const fix = view.getUint8(offset + 22);
  return [
    field("latitude", view.getInt32(offset, true), view.getInt32(offset, true) / 1e7, "deg"),
    field("longitude", view.getInt32(offset + 4, true), view.getInt32(offset + 4, true) / 1e7, "deg"),
    field("altitude", view.getInt32(offset + 8, true), view.getInt32(offset + 8, true) / 1000, "m"),
    field("velocityNorth", view.getInt16(offset + 12, true), view.getInt16(offset + 12, true) / 100, "m/s"),
    field("velocityEast", view.getInt16(offset + 14, true), view.getInt16(offset + 14, true) / 100, "m/s"),
    field("velocityDown", view.getInt16(offset + 16, true), view.getInt16(offset + 16, true) / 100, "m/s"),
    field("heading", view.getUint16(offset + 18, true), view.getUint16(offset + 18, true) / 100, "deg"),
    field("groundSpeed", view.getUint16(offset + 20, true), view.getUint16(offset + 20, true) / 100, "m/s"),
    field("fix", fix, fix, undefined, fix <= 4 ? "valid" : "out-of-range"),
    field("satellites", view.getUint8(offset + 23), view.getUint8(offset + 23)),
  ];
}

function decodeThermal(view: DataView, offset: number): DecodedField[] {
  return [
    field("avionicsTemp", view.getInt16(offset, true), view.getInt16(offset, true) / 100, "°C"),
    field("radioTemp", view.getInt16(offset + 2, true), view.getInt16(offset + 2, true) / 100, "°C"),
    field("batteryTemp", view.getInt16(offset + 4, true), view.getInt16(offset + 4, true) / 100, "°C"),
    field("ambientTemp", view.getInt16(offset + 6, true), view.getInt16(offset + 6, true) / 100, "°C"),
    field("fan", view.getUint8(offset + 8), view.getUint8(offset + 8), "%"),
    field("thermalStatus", view.getUint8(offset + 9), `0x${view.getUint8(offset + 9).toString(16).padStart(2, "0")}`),
  ];
}

const familyDecoders: Record<FamilyId, (view: DataView, offset: number) => DecodedField[]> = {
  0x02: decodeHeartbeat,
  0x17: decodePower,
  0x19: decodeAttitude,
  0x31: decodePosition,
  0x44: decodeThermal,
};

function decodeNsl01Record(record: SourceRecord, ordinal: number): DecodedFrame {
  const bytes = hexToBytes(record.dataHex);
  const base = {
    id: `frame-${record.id}`,
    ordinal,
    offsetUs: record.offsetUs,
    sourceRecord: record,
    familyName: "Unknown",
    fields: [] as DecodedField[],
  };

  if (bytes.length < HEADER_BYTES + CHECKSUM_BYTES) {
    return {
      ...base,
      integrity: { status: "truncated", reason: `Frame has ${bytes.length} bytes; expected at least ${HEADER_BYTES + CHECKSUM_BYTES}` },
      status: "partial",
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== SYNC_A || bytes[1] !== SYNC_B) {
    return {
      ...base,
      integrity: { status: "truncated", reason: "Sync word A55A is missing" },
      status: "partial",
    };
  }

  const protocolVersion = view.getUint8(2);
  const familyId = view.getUint8(3);
  const sequence = view.getUint16(4, true);
  const payloadLength = view.getUint16(6, true);
  const deviceTimeMs = view.getUint32(8, true);
  const expectedLength = HEADER_BYTES + payloadLength + CHECKSUM_BYTES;
  const familyName = familyNames[familyId as FamilyId] ?? `Unknown 0x${familyId.toString(16).padStart(2, "0")}`;
  const header = { protocolVersion, familyId, familyName, sequence, payloadLength, deviceTimeMs };

  if (expectedLength !== bytes.length) {
    return {
      ...base,
      ...header,
      integrity: { status: "invalid-length", reason: `Header declares ${expectedLength} bytes; received ${bytes.length}` },
      status: "invalid",
    };
  }

  const storedChecksum = view.getUint16(bytes.length - CHECKSUM_BYTES, true);
  const calculatedChecksum = crc16CcittFalse(bytes, 2, bytes.length - CHECKSUM_BYTES);
  if (storedChecksum !== calculatedChecksum) {
    return {
      ...base,
      ...header,
      integrity: { status: "crc-failed", expected: calculatedChecksum, actual: storedChecksum },
      status: "invalid",
    };
  }

  if (protocolVersion !== PROTOCOL_VERSION) {
    return {
      ...base,
      ...header,
      integrity: { status: "unsupported-version", reason: `Protocol version ${protocolVersion} is not supported; expected ${PROTOCOL_VERSION}` },
      status: "invalid",
    };
  }

  const decoder = familyDecoders[familyId as FamilyId];
  if (!decoder) {
    return {
      ...base,
      ...header,
      integrity: { status: "unknown-family", reason: `No decoder is registered for family 0x${familyId.toString(16).padStart(2, "0")}` },
      status: "invalid",
    };
  }

  const expectedPayloadBytes = familyPayloadBytes[familyId as FamilyId];
  if (payloadLength !== expectedPayloadBytes) {
    return {
      ...base,
      ...header,
      integrity: {
        status: "invalid-length",
        reason: `${familyName} payload declares ${payloadLength} bytes; schema requires ${expectedPayloadBytes}`,
      },
      status: "invalid",
    };
  }

  try {
    return {
      ...base,
      ...header,
      integrity: { status: "valid", checksum: storedChecksum },
      status: "complete",
      fields: decoder(view, HEADER_BYTES),
    };
  } catch (error) {
    return {
      ...base,
      ...header,
      integrity: { status: "truncated", reason: error instanceof Error ? error.message : "Payload could not be decoded" },
      status: "partial",
    };
  }
}

interface NmeaFieldDefinition {
  name: string;
  index: number;
  companionIndex?: number;
  type: "string" | "number" | "integer" | "latitude" | "longitude" | "enum";
  scale?: number;
  unit?: string;
  bounds?: readonly [number, number];
  enum?: Readonly<Record<string, string>>;
}

interface NmeaSentenceDefinition {
  name: string;
  fields: readonly NmeaFieldDefinition[];
}

interface NmeaSchema {
  sentences: Readonly<Record<string, NmeaSentenceDefinition>>;
}

const nmeaFieldDefinitionSchema = z.object({
  name: z.string().min(1).max(128),
  index: z.number().int().nonnegative().max(256),
  companionIndex: z.number().int().nonnegative().max(256).optional(),
  type: z.enum(["string", "number", "integer", "latitude", "longitude", "enum"]),
  scale: z.number().finite().optional(),
  unit: z.string().min(1).max(32).optional(),
  bounds: z.tuple([z.number().finite(), z.number().finite()]).optional(),
  enum: z.record(z.string().min(1).max(64), z.string().min(1).max(160)).optional(),
}).strict().superRefine((definition, context) => {
  const coordinate = definition.type === "latitude" || definition.type === "longitude";
  if (coordinate !== (definition.companionIndex != null)) {
    context.addIssue({
      code: "custom",
      message: coordinate
        ? "Coordinate fields require a hemisphere companionIndex."
        : "Only coordinate fields may declare companionIndex.",
    });
  }
  if ((definition.type === "enum") !== (definition.enum != null)) {
    context.addIssue({
      code: "custom",
      message: definition.type === "enum"
        ? "Enum fields require an enum mapping."
        : "Only enum fields may declare an enum mapping.",
    });
  }
  if (definition.bounds != null && definition.bounds[0] > definition.bounds[1]) {
    context.addIssue({
      code: "custom",
      path: ["bounds"],
      message: "Field bounds must be ordered from minimum to maximum.",
    });
  }
});

const nmeaSentenceDefinitionSchema = z.object({
  name: z.string().min(1).max(240),
  fields: z.array(nmeaFieldDefinitionSchema).min(1).max(64),
}).strict();

const nmeaSchemaDocumentSchema = z.object({
  id: z.literal("NMEA-0183"),
  revision: z.string().min(1).max(64),
  standard: z.literal("NMEA 0183"),
  checksum: z.literal("XOR-8 over ASCII bytes between '$' and '*'"),
  sentenceId: z.literal("last three characters of the talker-and-type field"),
  sentences: z.record(z.string().regex(/^[A-Z0-9]{3}$/), nmeaSentenceDefinitionSchema),
}).strict().superRefine((schema, context) => {
  const count = Object.keys(schema.sentences).length;
  if (count < 1 || count > 64) {
    context.addIssue({
      code: "custom",
      path: ["sentences"],
      message: "NMEA decoder schemas must declare between 1 and 64 sentence types.",
    });
  }
});

export function validateDecoderPackRuntime(pack: DecoderPackDocument): DecoderPackDocument {
  if (pack.runtime.id === "nsl01-binary-v1") {
    if (
      pack.id !== SUPPORTED_DECODER.id
      || pack.revision !== SUPPORTED_DECODER.revision
      || decoderSchemaHash(pack) !== SUPPORTED_DECODER.schemaHash
    ) {
      throw new DecoderPackValidationError(
        "The NSL-01 runtime is bound to the built-in NSL-01 schema and revision.",
      );
    }
    return pack;
  }

  const schema = nmeaSchemaDocumentSchema.safeParse(pack.schema);
  if (!schema.success) {
    throw new DecoderPackValidationError(
      "The NMEA 0183 decoder pack schema is incompatible with this runtime.",
      schema.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "schema"}: ${issue.message}`),
    );
  }
  if (
    pack.framing.kind !== "delimited-text"
    || pack.framing.prefix !== "$"
    || pack.framing.checksumDelimiter !== "*"
  ) {
    throw new DecoderPackValidationError(
      "The NMEA 0183 runtime requires '$' sentence prefixes and '*' checksum delimiters.",
    );
  }
  return pack;
}

function nmeaCoordinate(raw: string, hemisphere: string, longitude: boolean): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const degreeDigits = longitude ? 3 : 2;
  if (raw.length < degreeDigits + 2) return null;
  const degrees = Number(raw.slice(0, degreeDigits));
  const minutes = Number(raw.slice(degreeDigits));
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes) || minutes >= 60) return null;
  const sign = hemisphere === "S" || hemisphere === "W" ? -1 : 1;
  if (!(longitude ? hemisphere === "E" || hemisphere === "W" : hemisphere === "N" || hemisphere === "S")) {
    return null;
  }
  return sign * (degrees + minutes / 60);
}

function decodeNmeaField(parts: readonly string[], definition: NmeaFieldDefinition): DecodedField {
  const raw = parts[definition.index] ?? "";
  if (raw === "") return field(definition.name, raw, null, definition.unit, "unavailable");

  let value: number | string | boolean | null;
  let quality: DecodedField["quality"] = "valid";
  if (definition.type === "string") {
    value = raw;
  } else if (definition.type === "enum") {
    const mapped = definition.enum?.[raw];
    value = mapped ?? `Unknown (${raw})`;
    if (mapped == null) quality = "out-of-range";
  } else if (definition.type === "latitude" || definition.type === "longitude") {
    const hemisphere = definition.companionIndex == null ? "" : (parts[definition.companionIndex] ?? "");
    value = nmeaCoordinate(raw, hemisphere, definition.type === "longitude");
  } else {
    const parsed = definition.type === "integer" && !/^[+-]?\d+$/.test(raw) ? Number.NaN : Number(raw);
    value = Number.isFinite(parsed) ? parsed * (definition.scale ?? 1) : null;
  }

  if (value == null) return field(definition.name, raw, null, definition.unit, "out-of-range");
  if (typeof value === "number" && definition.bounds != null
    && (value < definition.bounds[0] || value > definition.bounds[1])
  ) quality = "out-of-range";
  return field(definition.name, raw, value, definition.unit, quality);
}

function nmeaSentenceType(identifier: string): string {
  return identifier.length >= 3 ? identifier.slice(-3) : identifier;
}

function nmeaChecksum(body: string): number {
  let checksum = 0;
  for (let index = 0; index < body.length; index += 1) checksum ^= body.charCodeAt(index);
  return checksum;
}

function decodeNmea0183Record(
  record: SourceRecord,
  ordinal: number,
  pack: DecoderPackDocument,
): DecodedFrame {
  const bytes = hexToBytes(record.dataHex);
  const base = {
    id: `frame-${record.id}`,
    ordinal,
    offsetUs: record.offsetUs,
    sourceRecord: record,
    familyName: "NMEA Unknown",
    fields: [] as DecodedField[],
    payloadLength: bytes.byteLength,
  };
  const framing = pack.framing;
  if (framing.kind !== "delimited-text") {
    return {
      ...base,
      integrity: { status: "unsupported-version", reason: "The selected decoder pack does not declare NMEA line framing." },
      status: "invalid",
    };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > framing.maxRecordBytes) {
    return {
      ...base,
      integrity: { status: "invalid-length", reason: `NMEA sentence has ${bytes.byteLength} bytes; maximum is ${framing.maxRecordBytes}.` },
      status: "invalid",
    };
  }
  for (const byte of bytes) {
    if (byte !== 0x0a && byte !== 0x0d && (byte < 0x20 || byte > 0x7e)) {
      return {
        ...base,
        integrity: { status: "truncated", reason: "NMEA records must contain printable ASCII plus line endings." },
        status: "partial",
      };
    }
  }

  const line = new TextDecoder().decode(bytes).replace(/\r?\n$/, "");
  if (!line.startsWith(framing.prefix)) {
    return {
      ...base,
      integrity: { status: "truncated", reason: `NMEA sentence prefix ${JSON.stringify(framing.prefix)} is missing.` },
      status: "partial",
    };
  }
  const delimiterIndex = line.lastIndexOf(framing.checksumDelimiter);
  const body = delimiterIndex > 0 ? line.slice(1, delimiterIndex) : line.slice(1);
  const identifier = body.split(",", 1)[0] ?? "";
  const sentenceType = nmeaSentenceType(identifier);
  const schema = pack.schema as NmeaSchema;
  const sentence = schema.sentences[sentenceType];
  const familyName = sentence == null
    ? `NMEA ${sentenceType || "Unknown"}`
    : `NMEA ${sentenceType} · ${sentence.name}`;
  const header = { familyName };

  if (delimiterIndex < 0 || delimiterIndex + 3 !== line.length) {
    return {
      ...base,
      ...header,
      integrity: { status: "invalid-length", reason: "NMEA sentence must end with '*' and two hexadecimal checksum characters." },
      status: "invalid",
    };
  }
  const actualText = line.slice(delimiterIndex + 1);
  if (!/^[0-9A-Fa-f]{2}$/.test(actualText)) {
    return {
      ...base,
      ...header,
      integrity: { status: "invalid-length", reason: "NMEA checksum must contain exactly two hexadecimal characters." },
      status: "invalid",
    };
  }
  const expected = nmeaChecksum(body);
  const actual = Number.parseInt(actualText, 16);
  if (expected !== actual) {
    return {
      ...base,
      ...header,
      integrity: { status: "checksum-failed", algorithm: "XOR-8", expected, actual },
      status: "invalid",
    };
  }
  if (!sentence) {
    return {
      ...base,
      ...header,
      integrity: { status: "unknown-family", reason: `No sentence definition is registered for ${sentenceType || identifier}.` },
      status: "invalid",
    };
  }

  const parts = body.split(",");
  return {
    ...base,
    ...header,
    integrity: { status: "valid", checksum: actual },
    status: "complete",
    fields: sentence.fields.map((definition) => decodeNmeaField(parts, definition)),
  };
}

export function decodeRecord(
  record: SourceRecord,
  ordinal: number,
  pack: DecoderPackDocument = NSL01_DECODER_PACK,
): DecodedFrame {
  if (pack.runtime.id === "nsl01-binary-v1") return decodeNsl01Record(record, ordinal);
  if (pack.runtime.id === "nmea0183-line-v1") return decodeNmea0183Record(record, ordinal, pack);
  return {
    id: `frame-${record.id}`,
    ordinal,
    offsetUs: record.offsetUs,
    sourceRecord: record,
    familyName: "Unknown",
    fields: [],
    integrity: { status: "unsupported-version", reason: `Decoder runtime ${pack.runtime.id} is not supported.` },
    status: "invalid",
  };
}

export interface EncodedFrameInput {
  familyId: FamilyId;
  sequence: number;
  deviceTimeMs: number;
  payload: Uint8Array;
  corruptChecksum?: boolean;
  omitSync?: boolean;
}

export function encodeFrame(input: EncodedFrameInput): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES + input.payload.length + CHECKSUM_BYTES);
  const view = new DataView(bytes.buffer);
  bytes[0] = input.omitSync ? 0 : SYNC_A;
  bytes[1] = input.omitSync ? 0 : SYNC_B;
  view.setUint8(2, PROTOCOL_VERSION);
  view.setUint8(3, input.familyId);
  view.setUint16(4, input.sequence & 0xffff, true);
  view.setUint16(6, input.payload.length, true);
  view.setUint32(8, input.deviceTimeMs >>> 0, true);
  bytes.set(input.payload, HEADER_BYTES);
  const checksum = crc16CcittFalse(bytes, 2, bytes.length - CHECKSUM_BYTES);
  view.setUint16(bytes.length - CHECKSUM_BYTES, input.corruptChecksum ? checksum ^ 0xffff : checksum, true);
  return bytes;
}

export function getNumericField(frame: DecodedFrame, name: string): number | null {
  const value = frame.fields.find((candidate) => candidate.name === name)?.value;
  return typeof value === "number" ? value : null;
}
