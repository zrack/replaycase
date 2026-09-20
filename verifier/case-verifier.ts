import { zipSync } from "fflate";

import { canonicalJson, sha256Hex } from "../src/domain/canonical";
import {
  CASE_LIMITS,
  caseIdentity,
  caseManifestSchema,
  resolveCaseCitation,
  sealCase,
  type CaseContent,
  type CaseManifest,
  type VerifiedCase,
} from "../src/domain/case";
import {
  buildComparisonFinding,
  compareSources,
  createReceiverComparisonSource,
  validateComparisonFinding,
} from "../src/domain/comparison";
import { buildReceiverDocument } from "../src/receiver/receiver-document";
import { verifyEvidenceBundleBytes } from "./evidence-verifier";
import { inspectZip, readBoundedZip, type ZipReadPolicy } from "./evidence-zip";

export const CASE_ZIP_POLICY: ZipReadPolicy = Object.freeze({
  archiveBytes: CASE_LIMITS.archiveBytes,
  entries: CASE_LIMITS.bundles + 1,
  entryBytes: CASE_LIMITS.bundleBytes,
  totalUncompressedBytes: CASE_LIMITS.bundleBytes + CASE_LIMITS.manifestBytes,
  allowsPath: (path: string) =>
    path === "case.json" || /^bundles\/[0-9a-f]{64}\.nlb$/.test(path),
});

type Progress = (percent: number, message: string) => void;
const encode = (value: unknown) =>
  new TextEncoder().encode(canonicalJson(value));
const bundlePath = (hash: string) => `bundles/${hash}.nlb`;

function validateCaseContent(
  manifest: CaseManifest,
  bundles: VerifiedCase["bundles"],
): void {
  const byHash = new Map(
    bundles.map((bundle) => [bundle.document.bundle.sha256, bundle.document]),
  );
  if (
    new Set(manifest.findings.map((finding) => finding.id)).size !==
    manifest.findings.length
  )
    throw new Error("Duplicate finding identity.");
  if (Date.parse(manifest.updatedAt) < Date.parse(manifest.createdAt))
    throw new Error("Case update precedes its creation.");
  for (const finding of manifest.findings) {
    if (Date.parse(finding.updatedAt) < Date.parse(finding.createdAt))
      throw new Error("Finding update precedes its creation.");
    for (const citation of finding.citations) {
      const document = byHash.get(citation.bundleHash);
      if (!document) throw new Error("Citation references a missing bundle.");
      resolveCaseCitation(citation, document);
    }
  }
  const comparisons = new Set<string>();
  for (const input of manifest.comparisons) {
    const finding = validateComparisonFinding(input);
    if (comparisons.has(finding.identity.canonicalSha256))
      throw new Error("Duplicate comparison finding.");
    comparisons.add(finding.identity.canonicalSha256);
    const sources = [finding.inputs.baseline, finding.inputs.candidate].map(
      (source) => {
        if (
          source.kind !== "evidence-bundle" ||
          !source.identity.startsWith("sha256:")
        )
          throw new Error("Case comparisons require included bundles.");
        const document = byHash.get(source.identity.slice(7));
        if (!document)
          throw new Error("Comparison references a missing bundle.");
        return createReceiverComparisonSource(document);
      },
    );
    const [baseline, candidate] = sources;
    if (!baseline || !candidate || baseline.identity === candidate.identity)
      throw new Error("Comparison requires two distinct bundles.");
    const model = compareSources(baseline, candidate, finding.alignment);
    const expected = buildComparisonFinding(
      model,
      finding.conclusion,
      finding.generatedAt,
    );
    if (canonicalJson(expected) !== canonicalJson(finding))
      throw new Error(
        "Comparison finding does not reproduce from the included evidence.",
      );
  }
}

export function verifyCaseArchive(
  input: Uint8Array,
  progress: Progress = () => {},
): VerifiedCase {
  progress(5, "Preflighting case archive");
  const outer = inspectZip(input, CASE_ZIP_POLICY);
  const manifestEntry = outer.entries.find(
    (entry) => entry.path === "case.json",
  );
  if (
    !manifestEntry ||
    manifestEntry.uncompressedSize > CASE_LIMITS.manifestBytes
  )
    throw new Error("Case manifest is missing or exceeds 1 MiB.");
  const entries = readBoundedZip(input, CASE_ZIP_POLICY);
  const manifestBytes = entries.get("case.json")!;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  const parsed = caseManifestSchema.parse(JSON.parse(text));
  if (canonicalJson(parsed) !== text)
    throw new Error("Case manifest is not canonical.");
  const { identity, ...content } = parsed;
  if (caseIdentity(content) !== identity.canonicalSha256)
    throw new Error("Case manifest identity does not match its contents.");
  if (
    new Set(parsed.bundles.map((bundle) => bundle.sha256)).size !==
    parsed.bundles.length
  )
    throw new Error("Duplicate bundle identity.");
  if (entries.size !== parsed.bundles.length + 1)
    throw new Error("Case archive has missing or undeclared bundles.");
  let expanded = 0;
  let compressed = 0;
  // Bound aggregate nested expansion before decompressing even the first bundle.
  const raw = parsed.bundles.map((descriptor) => {
    const bytes = entries.get(bundlePath(descriptor.sha256));
    if (!bytes) throw new Error(`Missing bundle: ${descriptor.sha256}`);
    if (
      bytes.byteLength !== descriptor.bytes ||
      sha256Hex(bytes) !== descriptor.sha256
    )
      throw new Error(`Bundle checksum mismatch: ${descriptor.label}`);
    compressed += bytes.byteLength;
    expanded += inspectZip(bytes).totalUncompressedBytes;
    if (
      compressed > CASE_LIMITS.bundleBytes ||
      expanded > CASE_LIMITS.expandedBundleBytes
    )
      throw new Error(
        "Case exceeds aggregate bundle size limits (48 MiB stored / 64 MiB expanded).",
      );
    return bytes;
  });
  const bundles = raw.map((bytes, index) => {
    progress(
      15 + Math.floor((65 * index) / Math.max(1, raw.length)),
      `Verifying bundle ${index + 1} of ${raw.length}`,
    );
    return {
      bytes,
      document: buildReceiverDocument(verifyEvidenceBundleBytes(bytes)),
    };
  });
  progress(85, "Resolving citations and reproducing comparisons");
  const manifest = parsed as CaseManifest;
  validateCaseContent(manifest, bundles);
  progress(95, "Hashing verified case");
  return {
    manifest,
    bundles,
    archive: Uint8Array.from(input),
    archiveHash: sha256Hex(input),
  };
}

export function buildCaseArchive(
  content: CaseContent,
  bundleBytes: readonly Uint8Array[],
  progress?: Progress,
): VerifiedCase {
  const manifest = sealCase(content);
  const encoded = encode(manifest);
  if (encoded.byteLength > CASE_LIMITS.manifestBytes)
    throw new Error("Case manifest exceeds 1 MiB.");
  if (bundleBytes.length !== manifest.bundles.length)
    throw new Error("Bundle count does not match the case manifest.");
  let total = 0;
  const entries: Record<string, Uint8Array> = { "case.json": encoded };
  for (const [index, bytes] of bundleBytes.entries()) {
    total += bytes.byteLength;
    if (total > CASE_LIMITS.bundleBytes)
      throw new Error("Case exceeds the 48 MiB stored bundle limit.");
    const descriptor = manifest.bundles[index]!;
    if (sha256Hex(bytes) !== descriptor.sha256)
      throw new Error("Bundle identity does not match the supplied bytes.");
    entries[bundlePath(descriptor.sha256)] = bytes;
  }
  const archive = zipSync(entries, { level: 0, mtime: new Date(1980, 0, 1) });
  return verifyCaseArchive(archive, progress);
}
