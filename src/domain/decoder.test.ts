import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { bytesToHex, crc16CcittFalse, DECODER_SCHEMA, decodeRecord, encodeFrame, SUPPORTED_DECODER } from "./decoder";
import type { SourceRecord } from "./types";

function recordFor(bytes: Uint8Array): SourceRecord {
  return {
    id: "record-1",
    index: 0,
    sourceId: "source-1",
    offsetUs: 125_000,
    dataHex: bytesToHex(bytes),
    captureBytes: bytes.length,
    wireBytes: bytes.length,
    transport: { kind: "udp", kernelDropCounter: 0 },
    signal: { rssiDbm: -72, snrDb: 19, provenance: "gateway-sidecar" },
  };
}

describe("ReplayCase frame decoder", () => {
  it("binds the supported decoder descriptor to the canonical byte-level schema", () => {
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonicalize(item)]));
      }
      return value;
    };
    const canonicalJson = JSON.stringify(canonicalize(DECODER_SCHEMA));
    expect(createHash("sha256").update(canonicalJson).digest("hex")).toBe(SUPPORTED_DECODER.schemaHash);
  });

  it("matches the CCITT-FALSE reference vector", () => {
    expect(crc16CcittFalse(new TextEncoder().encode("123456789"))).toBe(0x29b1);
  });

  it("decodes a complete power frame while retaining source provenance", () => {
    const payload = new Uint8Array(9);
    const view = new DataView(payload.buffer);
    view.setUint16(0, 12_420, true);
    view.setInt16(2, -850, true);
    view.setUint8(4, 81);
    view.setInt16(5, 3_215, true);
    view.setUint16(7, 13_800, true);
    const source = recordFor(encodeFrame({ familyId: 0x17, sequence: 42, deviceTimeMs: 124, payload }));

    const decoded = decodeRecord(source, 0);

    expect(decoded.status).toBe("complete");
    expect(decoded.familyName).toBe("Power");
    expect(decoded.sequence).toBe(42);
    expect(decoded.fields.find((field) => field.name === "busVoltage")?.value).toBe(12.42);
    expect(decoded.sourceRecord).toBe(source);
  });

  it("keeps checksum failures available for forensic inspection", () => {
    const bytes = encodeFrame({
      familyId: 0x02,
      sequence: 43,
      deviceTimeMs: 250,
      payload: new Uint8Array(8),
      corruptChecksum: true,
    });

    const decoded = decodeRecord(recordFor(bytes), 1);

    expect(decoded.status).toBe("invalid");
    expect(decoded.integrity.status).toBe("crc-failed");
    expect(decoded.sourceRecord.dataHex).toHaveLength(bytes.length * 2);
  });

  it("rejects a CRC-valid frame that declares an unsupported protocol version", () => {
    const bytes = encodeFrame({
      familyId: 0x02,
      sequence: 44,
      deviceTimeMs: 300,
      payload: new Uint8Array(8),
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint8(2, 2);
    view.setUint16(bytes.length - 2, crc16CcittFalse(bytes, 2, bytes.length - 2), true);

    const decoded = decodeRecord(recordFor(bytes), 2);

    expect(decoded.status).toBe("invalid");
    expect(decoded.protocolVersion).toBe(2);
    expect(decoded.integrity).toMatchObject({
      status: "unsupported-version",
      reason: "Protocol version 2 is not supported; expected 1",
    });
    expect(decoded.fields).toEqual([]);
  });

  it.each([
    { description: "short", payloadLength: 7 },
    { description: "overlong", payloadLength: 9 },
  ])("rejects a CRC-valid known-family payload that is $description", ({ payloadLength }) => {
    const bytes = encodeFrame({
      familyId: 0x02,
      sequence: 45,
      deviceTimeMs: 325,
      payload: new Uint8Array(payloadLength),
    });

    const decoded = decodeRecord(recordFor(bytes), 3);

    expect(decoded.status).toBe("invalid");
    expect(decoded.payloadLength).toBe(payloadLength);
    expect(decoded.integrity).toMatchObject({
      status: "invalid-length",
      reason: `Heartbeat payload declares ${payloadLength} bytes; schema requires 8`,
    });
    expect(decoded.fields).toEqual([]);
  });

  it("retains frames whose sync word is missing", () => {
    const bytes = encodeFrame({
      familyId: 0x44,
      sequence: 44,
      deviceTimeMs: 375,
      payload: new Uint8Array(10),
      omitSync: true,
    });

    const decoded = decodeRecord(recordFor(bytes), 4);

    expect(decoded.status).toBe("partial");
    expect(decoded.integrity).toMatchObject({ status: "truncated", reason: "Sync word A55A is missing" });
  });
});
