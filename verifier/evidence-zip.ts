import { Inflate } from "fflate";

export const EVIDENCE_ZIP_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const EVIDENCE_ZIP_MAX_ENTRIES = 16;
export const EVIDENCE_ZIP_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const EVIDENCE_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;

export const EVIDENCE_ZIP_ALLOWED_PATHS = [
  "manifest.json",
  "SHA256SUMS",
  "transport/events.json",
  "transport/integrity-receipt.json",
  "transport/provenance.json",
  "transport/journal.json",
  "raw/source-records.ndjson",
  "decoded/packets.csv",
  "diagnostics/diagnostics.json",
  "diagnostics/diagnostics.csv",
  "markers/markers.json",
  "notes/notes.json",
  "schema/schema.json",
] as const;

export type EvidenceZipPath = (typeof EVIDENCE_ZIP_ALLOWED_PATHS)[number];

export const evidenceZipErrorCodes = [
  "invalid-input",
  "archive-empty",
  "archive-too-large",
  "eocd-not-found",
  "eocd-ambiguous",
  "zip64-unsupported",
  "multi-disk-unsupported",
  "entry-count-exceeded",
  "central-directory-invalid",
  "filename-invalid",
  "unsafe-path",
  "unknown-path",
  "directory-entry",
  "duplicate-path",
  "encrypted-entry",
  "data-descriptor-unsupported",
  "unsupported-flags",
  "unsupported-compression",
  "entry-too-large",
  "total-size-exceeded",
  "local-header-invalid",
  "central-local-mismatch",
  "entry-overlap",
  "unaccounted-data",
  "decompression-failed",
  "compressed-input-not-consumed",
  "size-mismatch",
  "crc32-mismatch",
] as const;

export type EvidenceZipErrorCode = (typeof evidenceZipErrorCodes)[number];

export class EvidenceZipError extends Error {
  readonly code: EvidenceZipErrorCode;
  readonly entryPath?: string;

  constructor(code: EvidenceZipErrorCode, message: string, entryPath?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvidenceZipError";
    this.code = code;
    if (entryPath !== undefined) this.entryPath = entryPath;
  }
}

const ALLOWED_PATHS = new Set<string>(EVIDENCE_ZIP_ALLOWED_PATHS);

export interface ZipReadPolicy {
  archiveBytes: number;
  entries: number;
  entryBytes: number;
  totalUncompressedBytes: number;
  allowsPath(path: string): boolean;
}

export const EVIDENCE_ZIP_POLICY: ZipReadPolicy = Object.freeze({
  archiveBytes: EVIDENCE_ZIP_MAX_ARCHIVE_BYTES,
  entries: EVIDENCE_ZIP_MAX_ENTRIES,
  entryBytes: EVIDENCE_ZIP_MAX_ENTRY_BYTES,
  totalUncompressedBytes: EVIDENCE_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES,
  allowsPath: (path: string) => ALLOWED_PATHS.has(path),
});

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;

const LOCAL_FILE_HEADER_BYTES = 30;
const CENTRAL_DIRECTORY_HEADER_BYTES = 46;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const MAX_ZIP_COMMENT_BYTES = 0xffff;

const FLAG_ENCRYPTED = 1 << 0;
const FLAG_DEFLATE_OPTION_MASK = (1 << 1) | (1 << 2);
const FLAG_DATA_DESCRIPTOR = 1 << 3;
const FLAG_STRONG_ENCRYPTION = 1 << 6;
const FLAG_UTF8 = 1 << 11;
const FLAG_MASKED_HEADER = 1 << 13;
const ALLOWED_GENERAL_PURPOSE_FLAGS = FLAG_DEFLATE_OPTION_MASK | FLAG_UTF8;

interface EndOfCentralDirectory {
  offset: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  entryCount: number;
}

interface CentralDirectoryEntry {
  path: string;
  versionNeeded: number;
  flags: number;
  compressionMethod: 0 | 8;
  modifiedTime: number;
  modifiedDate: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface LocalEntryRange {
  path: string;
  start: number;
  dataStart: number;
  end: number;
}

interface InspectableInflate {
  p?: Uint8Array;
  s?: {
    f?: number;
    p?: number;
  };
}

function fail(
  code: EvidenceZipErrorCode,
  message: string,
  entryPath?: string,
  options?: ErrorOptions,
): never {
  throw new EvidenceZipError(code, message, entryPath, options);
}

function ensureRange(
  offset: number,
  length: number,
  limit: number,
  code: "central-directory-invalid" | "local-header-invalid",
  message: string,
  entryPath?: string,
): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > limit - length) {
    fail(code, message, entryPath);
  }
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function findEndOfCentralDirectory(view: DataView, archiveLength: number, policy: ZipReadPolicy): EndOfCentralDirectory {
  if (archiveLength < END_OF_CENTRAL_DIRECTORY_BYTES) {
    fail("eocd-not-found", "The archive does not contain a complete ZIP end-of-central-directory record.");
  }

  const minimumOffset = Math.max(
    0,
    archiveLength - END_OF_CENTRAL_DIRECTORY_BYTES - MAX_ZIP_COMMENT_BYTES,
  );
  const candidates: number[] = [];
  for (let offset = archiveLength - END_OF_CENTRAL_DIRECTORY_BYTES; offset >= minimumOffset; offset -= 1) {
    if (u32(view, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = u16(view, offset + 20);
    if (offset + END_OF_CENTRAL_DIRECTORY_BYTES + commentLength === archiveLength) candidates.push(offset);
  }

  if (candidates.length === 0) fail("eocd-not-found", "The ZIP end-of-central-directory record is absent or truncated.");
  if (candidates.length !== 1) fail("eocd-ambiguous", "The archive contains ambiguous ZIP end-of-central-directory records.");
  const offset = candidates[0];
  if (offset === undefined) fail("eocd-not-found", "The ZIP end-of-central-directory record is absent.");
  if (u16(view, offset + 20) !== 0) fail("central-directory-invalid", "ZIP archive comments are not permitted.");

  if (
    (offset >= 20 && u32(view, offset - 20) === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE)
    || (offset >= 4 && u32(view, offset - 4) === ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE)
  ) {
    fail("zip64-unsupported", "ZIP64 evidence archives are not supported.");
  }

  const diskNumber = u16(view, offset + 4);
  const centralDirectoryDisk = u16(view, offset + 6);
  const entriesOnDisk = u16(view, offset + 8);
  const entryCount = u16(view, offset + 10);
  const centralDirectorySize = u32(view, offset + 12);
  const centralDirectoryOffset = u32(view, offset + 16);

  if (
    entriesOnDisk === 0xffff
    || entryCount === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
  ) {
    fail("zip64-unsupported", "ZIP64 sentinel values are not supported in evidence archives.");
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    fail("multi-disk-unsupported", "Multi-disk ZIP evidence archives are not supported.");
  }
  if (entryCount > policy.entries) {
    fail(
      "entry-count-exceeded",
      `The archive declares ${entryCount} entries; at most ${policy.entries} are allowed.`,
    );
  }
  if (centralDirectoryOffset > offset || centralDirectorySize > offset - centralDirectoryOffset) {
    fail("central-directory-invalid", "The ZIP central directory lies outside the archive bounds.");
  }
  if (centralDirectoryOffset + centralDirectorySize !== offset) {
    fail("unaccounted-data", "Unexpected data appears between the ZIP central directory and its terminal record.");
  }

  return { offset, centralDirectoryOffset, centralDirectorySize, entryCount };
}

function validateExtraFields(
  bytes: Uint8Array,
  code: "central-directory-invalid" | "local-header-invalid",
  entryPath?: string,
): void {
  let cursor = 0;
  while (cursor < bytes.byteLength) {
    if (bytes.byteLength - cursor < 4) fail(code, "A ZIP extra field header is truncated.", entryPath);
    const fieldId = (bytes[cursor] ?? 0) | ((bytes[cursor + 1] ?? 0) << 8);
    const fieldLength = (bytes[cursor + 2] ?? 0) | ((bytes[cursor + 3] ?? 0) << 8);
    cursor += 4;
    if (fieldLength > bytes.byteLength - cursor) fail(code, "A ZIP extra field payload is truncated.", entryPath);
    if (fieldId === ZIP64_EXTRA_FIELD_ID) fail("zip64-unsupported", "ZIP64 extra fields are not supported.", entryPath);
    cursor += fieldLength;
  }
}

function decodeEvidencePath(filenameBytes: Uint8Array, policy: ZipReadPolicy): string {
  if (filenameBytes.byteLength === 0 || filenameBytes.byteLength > 255) {
    fail("filename-invalid", "ZIP entry names must contain between 1 and 255 ASCII bytes.");
  }
  let path = "";
  for (const byte of filenameBytes) {
    if (byte < 0x20 || byte > 0x7e) {
      fail("filename-invalid", "ZIP entry names must use printable ASCII characters only.");
    }
    path += String.fromCharCode(byte);
  }

  if (path.endsWith("/")) fail("directory-entry", "Directory entries are not permitted in an evidence archive.", path);
  const segments = path.split("/");
  if (
    path.startsWith("/")
    || path.startsWith("\\")
    || path.includes("\\")
    || /^[A-Za-z]:/.test(path)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("unsafe-path", "The archive contains a non-canonical or traversing entry path.", path);
  }
  if (!policy.allowsPath(path)) fail("unknown-path", `The archive entry ${JSON.stringify(path)} is not part of the archive format.`, path);
  return path;
}

function validateFlags(flags: number, compressionMethod: number, entryPath: string): void {
  if ((flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADER)) !== 0) {
    fail("encrypted-entry", "Encrypted ZIP entries are not permitted.", entryPath);
  }
  if ((flags & FLAG_DATA_DESCRIPTOR) !== 0) {
    fail("data-descriptor-unsupported", "ZIP data descriptors are not permitted.", entryPath);
  }
  if ((flags & ~ALLOWED_GENERAL_PURPOSE_FLAGS) !== 0) {
    fail("unsupported-flags", `ZIP entry ${JSON.stringify(entryPath)} uses unsupported general-purpose flags.`, entryPath);
  }
  if (compressionMethod === 0 && (flags & FLAG_DEFLATE_OPTION_MASK) !== 0) {
    fail("unsupported-flags", "Stored ZIP entries cannot declare DEFLATE compression options.", entryPath);
  }
}

function isDirectoryAttribute(versionMadeBy: number, externalAttributes: number): boolean {
  const platform = versionMadeBy >>> 8;
  const unixMode = externalAttributes >>> 16;
  const unixFileType = unixMode & 0xf000;
  const dosAttributes = externalAttributes & 0xff;
  return dosAttributes === 0x10 || (dosAttributes & 0x10) !== 0 || (platform === 3 && unixFileType === 0x4000);
}

function isSpecialUnixAttribute(versionMadeBy: number, externalAttributes: number): boolean {
  const platform = versionMadeBy >>> 8;
  if (platform !== 3) return false;
  const unixFileType = (externalAttributes >>> 16) & 0xf000;
  return unixFileType !== 0 && unixFileType !== 0x8000;
}

function parseCentralDirectory(
  archive: Uint8Array,
  view: DataView,
  end: EndOfCentralDirectory,
  policy: ZipReadPolicy,
): CentralDirectoryEntry[] {
  const entries: CentralDirectoryEntry[] = [];
  const paths = new Set<string>();
  const centralEnd = end.centralDirectoryOffset + end.centralDirectorySize;
  let cursor = end.centralDirectoryOffset;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < end.entryCount; index += 1) {
    ensureRange(
      cursor,
      CENTRAL_DIRECTORY_HEADER_BYTES,
      centralEnd,
      "central-directory-invalid",
      `Central-directory entry ${index} is truncated.`,
    );
    if (u32(view, cursor) !== CENTRAL_DIRECTORY_HEADER_SIGNATURE) {
      fail("central-directory-invalid", `Central-directory entry ${index} has an invalid signature.`);
    }

    const versionMadeBy = u16(view, cursor + 4);
    const versionNeeded = u16(view, cursor + 6);
    const flags = u16(view, cursor + 8);
    const compressionMethod = u16(view, cursor + 10);
    const modifiedTime = u16(view, cursor + 12);
    const modifiedDate = u16(view, cursor + 14);
    const entryCrc32 = u32(view, cursor + 16);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    const filenameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const diskStart = u16(view, cursor + 34);
    const externalAttributes = u32(view, cursor + 38);
    const localHeaderOffset = u32(view, cursor + 42);
    const variableLength = filenameLength + extraLength + commentLength;
    ensureRange(
      cursor + CENTRAL_DIRECTORY_HEADER_BYTES,
      variableLength,
      centralEnd,
      "central-directory-invalid",
      `Central-directory entry ${index} metadata is truncated.`,
    );

    if (
      versionNeeded >= 45
      || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localHeaderOffset === 0xffffffff
      || diskStart === 0xffff
    ) {
      fail("zip64-unsupported", "ZIP64 entry metadata is not supported.");
    }
    if (diskStart !== 0) fail("multi-disk-unsupported", "A ZIP entry starts on a different disk.");
    if (extraLength !== 0 || commentLength !== 0) {
      fail("central-directory-invalid", "ZIP entry extras and comments are not permitted.");
    }

    const filenameStart = cursor + CENTRAL_DIRECTORY_HEADER_BYTES;
    const filenameBytes = archive.subarray(filenameStart, filenameStart + filenameLength);
    const path = decodeEvidencePath(filenameBytes, policy);
    if (paths.has(path)) fail("duplicate-path", `The archive contains duplicate entry ${JSON.stringify(path)}.`, path);
    paths.add(path);

    if (isDirectoryAttribute(versionMadeBy, externalAttributes)) {
      fail("directory-entry", `ZIP entry ${JSON.stringify(path)} is marked as a directory.`, path);
    }
    if (isSpecialUnixAttribute(versionMadeBy, externalAttributes)) {
      fail("unsafe-path", `ZIP entry ${JSON.stringify(path)} is not a regular file.`, path);
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      fail("unsupported-compression", `ZIP entry ${JSON.stringify(path)} uses compression method ${compressionMethod}.`, path);
    }
    validateFlags(flags, compressionMethod, path);
    if (compressedSize > policy.entryBytes || uncompressedSize > policy.entryBytes) {
      fail(
        "entry-too-large",
        `ZIP entry ${JSON.stringify(path)} exceeds the ${policy.entryBytes}-byte per-entry limit.`,
        path,
      );
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > policy.totalUncompressedBytes) {
      fail(
        "total-size-exceeded",
        `The archive exceeds the ${policy.totalUncompressedBytes}-byte uncompressed limit.`,
      );
    }

    const extraStart = filenameStart + filenameLength;
    validateExtraFields(
      archive.subarray(extraStart, extraStart + extraLength),
      "central-directory-invalid",
      path,
    );
    entries.push({
      path,
      versionNeeded,
      flags,
      compressionMethod,
      modifiedTime,
      modifiedDate,
      crc32: entryCrc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor += CENTRAL_DIRECTORY_HEADER_BYTES + variableLength;
  }

  if (cursor !== centralEnd) {
    fail("central-directory-invalid", "The ZIP central-directory size does not match its parsed entries.");
  }
  return entries;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function parseLocalEntryRange(
  archive: Uint8Array,
  view: DataView,
  entry: CentralDirectoryEntry,
  centralDirectoryOffset: number,
): LocalEntryRange {
  const offset = entry.localHeaderOffset;
  ensureRange(
    offset,
    LOCAL_FILE_HEADER_BYTES,
    centralDirectoryOffset,
    "local-header-invalid",
    `The local header for ${JSON.stringify(entry.path)} is truncated.`,
    entry.path,
  );
  if (u32(view, offset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    fail("local-header-invalid", `The local header for ${JSON.stringify(entry.path)} has an invalid signature.`, entry.path);
  }

  const versionNeeded = u16(view, offset + 4);
  const flags = u16(view, offset + 6);
  const compressionMethod = u16(view, offset + 8);
  const modifiedTime = u16(view, offset + 10);
  const modifiedDate = u16(view, offset + 12);
  const entryCrc32 = u32(view, offset + 14);
  const compressedSize = u32(view, offset + 18);
  const uncompressedSize = u32(view, offset + 22);
  const filenameLength = u16(view, offset + 26);
  const extraLength = u16(view, offset + 28);
  const variableLength = filenameLength + extraLength;
  ensureRange(
    offset + LOCAL_FILE_HEADER_BYTES,
    variableLength,
    centralDirectoryOffset,
    "local-header-invalid",
    `The local-header metadata for ${JSON.stringify(entry.path)} is truncated.`,
    entry.path,
  );
  if (versionNeeded >= 45 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
    fail("zip64-unsupported", "ZIP64 local-entry metadata is not supported.", entry.path);
  }
  if (extraLength !== 0) fail("local-header-invalid", "ZIP local-entry extras are not permitted.", entry.path);

  const filenameStart = offset + LOCAL_FILE_HEADER_BYTES;
  const localFilenameBytes = archive.subarray(filenameStart, filenameStart + filenameLength);
  const centralFilenameBytes = Uint8Array.from(entry.path, (character) => character.charCodeAt(0));
  if (!equalBytes(localFilenameBytes, centralFilenameBytes)) {
    fail("central-local-mismatch", "The local and central ZIP entry names do not match.", entry.path);
  }
  const extraStart = filenameStart + filenameLength;
  validateExtraFields(
    archive.subarray(extraStart, extraStart + extraLength),
    "local-header-invalid",
    entry.path,
  );

  if (
    versionNeeded !== entry.versionNeeded
    || flags !== entry.flags
    || compressionMethod !== entry.compressionMethod
    || modifiedTime !== entry.modifiedTime
    || modifiedDate !== entry.modifiedDate
    || entryCrc32 !== entry.crc32
    || compressedSize !== entry.compressedSize
    || uncompressedSize !== entry.uncompressedSize
  ) {
    fail("central-local-mismatch", `The local and central metadata for ${JSON.stringify(entry.path)} do not match.`, entry.path);
  }
  validateFlags(flags, compressionMethod, entry.path);

  const dataStart = offset + LOCAL_FILE_HEADER_BYTES + variableLength;
  ensureRange(
    dataStart,
    compressedSize,
    centralDirectoryOffset,
    "local-header-invalid",
    `The compressed payload for ${JSON.stringify(entry.path)} is truncated or overlaps the central directory.`,
    entry.path,
  );
  return { path: entry.path, start: offset, dataStart, end: dataStart + compressedSize };
}

function validateLocalRanges(ranges: readonly LocalEntryRange[], centralDirectoryOffset: number): void {
  if (ranges.length === 0) {
    if (centralDirectoryOffset !== 0) fail("unaccounted-data", "An empty ZIP archive contains unaccounted data.");
    return;
  }
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  let expectedStart = 0;
  for (const range of sorted) {
    if (range.start < expectedStart) {
      fail("entry-overlap", `ZIP entry ${JSON.stringify(range.path)} overlaps another local entry.`, range.path);
    }
    if (range.start !== expectedStart) {
      fail("unaccounted-data", `Unexpected data appears before ZIP entry ${JSON.stringify(range.path)}.`, range.path);
    }
    expectedStart = range.end;
  }
  if (expectedStart !== centralDirectoryOffset) {
    fail("unaccounted-data", "Unexpected data appears between the local ZIP entries and central directory.");
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) checksum = (CRC32_TABLE[(checksum ^ byte) & 0xff] ?? 0) ^ (checksum >>> 8);
  return (checksum ^ 0xffffffff) >>> 0;
}

function inflateRawExact(
  compressed: Uint8Array,
  expectedBytes: number,
  entryPath: string,
): Uint8Array {
  const output = new Uint8Array(expectedBytes);
  let written = 0;
  const inflater = new Inflate((chunk) => {
    if (chunk.byteLength > expectedBytes - written) {
      fail(
        "size-mismatch",
        `DEFLATE entry ${JSON.stringify(entryPath)} exceeds its declared uncompressed size.`,
        entryPath,
      );
    }
    output.set(chunk, written);
    written += chunk.byteLength;
  });

  const chunkBytes = 4 * 1024;
  if (compressed.byteLength === 0) {
    inflater.push(compressed, true);
  } else {
    for (let offset = 0; offset < compressed.byteLength; offset += chunkBytes) {
      const end = Math.min(compressed.byteLength, offset + chunkBytes);
      inflater.push(compressed.subarray(offset, end), end === compressed.byteLength);
    }
  }

  const state = inflater as unknown as InspectableInflate;
  if (state.s?.f !== 1) {
    fail(
      "decompression-failed",
      `DEFLATE entry ${JSON.stringify(entryPath)} does not contain a complete terminal block.`,
      entryPath,
    );
  }
  const bufferedBytes = state.p?.byteLength ?? 0;
  const partialByte = (state.s?.p ?? 0) > 0 ? 1 : 0;
  if (bufferedBytes - partialByte !== 0) {
    fail(
      "compressed-input-not-consumed",
      `DEFLATE entry ${JSON.stringify(entryPath)} contains trailing compressed input.`,
      entryPath,
    );
  }
  return output.subarray(0, written);
}

function extractEntry(archive: Uint8Array, entry: CentralDirectoryEntry, range: LocalEntryRange): Uint8Array {
  const compressed = archive.subarray(range.dataStart, range.end);
  let output: Uint8Array;
  if (entry.compressionMethod === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      fail("size-mismatch", `Stored ZIP entry ${JSON.stringify(entry.path)} has conflicting sizes.`, entry.path);
    }
    output = Uint8Array.from(compressed);
  } else {
    try {
      output = inflateRawExact(compressed, entry.uncompressedSize, entry.path);
    } catch (cause) {
      if (cause instanceof EvidenceZipError) throw cause;
      fail(
        "decompression-failed",
        `DEFLATE entry ${JSON.stringify(entry.path)} could not be decompressed within its declared limit.`,
        entry.path,
        { cause },
      );
    }
  }

  if (output.byteLength !== entry.uncompressedSize) {
    fail(
      "size-mismatch",
      `ZIP entry ${JSON.stringify(entry.path)} produced ${output.byteLength} bytes; ${entry.uncompressedSize} were declared.`,
      entry.path,
    );
  }
  if (crc32(output) !== entry.crc32) {
    fail("crc32-mismatch", `ZIP entry ${JSON.stringify(entry.path)} failed CRC-32 verification.`, entry.path);
  }
  return output;
}

/**
 * Reads a ReplayCase evidence ZIP without touching the filesystem.
 *
 * Validate the complete container structure against a fixed format policy
 * before inflating any entry.
 */
function preflightZip(input: Uint8Array, policy: ZipReadPolicy) {
  if (!(input instanceof Uint8Array)) fail("invalid-input", "Evidence ZIP input must be a Uint8Array.");
  if (input.byteLength === 0) fail("archive-empty", "The evidence archive is empty.");
  if (input.byteLength > policy.archiveBytes) {
    fail(
      "archive-too-large",
      `The archive exceeds the ${policy.archiveBytes}-byte compressed limit.`,
    );
  }

  const archive = Uint8Array.from(input);
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = findEndOfCentralDirectory(view, archive.byteLength, policy);
  const entries = parseCentralDirectory(archive, view, end, policy);
  const ranges = entries.map((entry) => parseLocalEntryRange(archive, view, entry, end.centralDirectoryOffset));
  validateLocalRanges(ranges, end.centralDirectoryOffset);
  return { archive, entries, ranges };
}

/** Structural preflight only; callers must still verify CRCs and content. */
export function inspectZip(input: Uint8Array, policy: ZipReadPolicy = EVIDENCE_ZIP_POLICY) {
  const { entries } = preflightZip(input, policy);
  return {
    entries: entries.map(({ path, uncompressedSize }) => ({ path, uncompressedSize })),
    totalUncompressedBytes: entries.reduce((total, entry) => total + entry.uncompressedSize, 0),
  };
}

export function readBoundedZip(input: Uint8Array, policy: ZipReadPolicy): Map<string, Uint8Array> {
  const { archive, entries, ranges } = preflightZip(input, policy);

  const rangesByPath = new Map(ranges.map((range) => [range.path, range]));
  const extracted = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const range = rangesByPath.get(entry.path);
    if (!range) fail("local-header-invalid", `The local ZIP payload for ${JSON.stringify(entry.path)} is absent.`, entry.path);
    extracted.set(entry.path, extractEntry(archive, entry, range));
  }
  return extracted;
}

export function readEvidenceZip(input: Uint8Array): Map<string, Uint8Array> {
  return readBoundedZip(input, EVIDENCE_ZIP_POLICY);
}
