import { z } from "zod";

import { canonicalJson, sha256Hex } from "./canonical";
import type { ComparisonFinding } from "./comparison";
import type { ReceiverDocument } from "../receiver/receiver-document";

export const CASE_LIMITS = Object.freeze({
  archiveBytes: 64 * 1024 * 1024,
  bundleBytes: 48 * 1024 * 1024,
  expandedBundleBytes: 64 * 1024 * 1024,
  manifestBytes: 1024 * 1024,
  bundles: 16,
  findings: 200,
  citations: 16,
  comparisons: 16,
});

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const offset = z.number().int().nonnegative().safe();
const id = z.string().uuid();
const timestamp = z.string().datetime();

export const caseCitationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("range"),
      bundleHash: hash,
      startUs: offset,
      endUs: offset,
    })
    .strict(),
  z
    .object({
      kind: z.literal("record"),
      bundleHash: hash,
      recordId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("diagnostic"),
      bundleHash: hash,
      diagnosticId: z.string().min(1).max(192),
    })
    .strict(),
]);
export type CaseCitation = z.infer<typeof caseCitationSchema>;

export const caseFindingSchema = z
  .object({
    id,
    kind: z.enum(["finding", "question"]),
    body: z.string().trim().min(1).max(4_000),
    citations: z.array(caseCitationSchema).min(1).max(CASE_LIMITS.citations),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type CaseFinding = z.infer<typeof caseFindingSchema>;

const caseContentSchema = z
  .object({
    format: z.literal("replaycase/case"),
    formatVersion: z.literal(1),
    id,
    title: z.string().trim().min(1).max(240),
    summary: z.string().max(4_000),
    createdAt: timestamp,
    updatedAt: timestamp,
    bundles: z
      .array(
        z
          .object({
            sha256: hash,
            bytes: z.number().int().positive().max(CASE_LIMITS.bundleBytes),
            label: z.string().trim().min(1).max(240),
            fileName: z.string().min(1).max(240),
          })
          .strict(),
      )
      .max(CASE_LIMITS.bundles),
    findings: z.array(caseFindingSchema).max(CASE_LIMITS.findings),
    comparisons: z.array(z.unknown()).max(CASE_LIMITS.comparisons),
  })
  .strict();

export const caseManifestSchema = caseContentSchema
  .extend({
    identity: z
      .object({ algorithm: z.literal("SHA-256"), canonicalSha256: hash })
      .strict(),
  })
  .strict();

export type CaseContent = Omit<
  z.infer<typeof caseContentSchema>,
  "comparisons"
> & { comparisons: ComparisonFinding[] };
export type CaseManifest = CaseContent & {
  identity: { algorithm: "SHA-256"; canonicalSha256: string };
};
export interface CaseBundle {
  bytes: Uint8Array;
  document: ReceiverDocument;
}
export interface VerifiedCase {
  manifest: CaseManifest;
  bundles: CaseBundle[];
  archive: Uint8Array;
  archiveHash: string;
}

export function caseIdentity(
  content: Omit<CaseContent, "comparisons"> & { comparisons: unknown[] },
): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(content)));
}

export function sealCase(content: CaseContent): CaseManifest {
  const parsed = caseContentSchema.parse(content);
  return {
    ...parsed,
    comparisons: content.comparisons,
    identity: { algorithm: "SHA-256", canonicalSha256: caseIdentity(parsed) },
  };
}

export function newCaseContent(
  title: string,
  caseId: string,
  now: string,
): CaseContent {
  return {
    format: "replaycase/case",
    formatVersion: 1,
    id: caseId,
    title,
    summary: "",
    createdAt: now,
    updatedAt: now,
    bundles: [],
    findings: [],
    comparisons: [],
  };
}

export function caseContent(manifest: CaseManifest): CaseContent {
  const { identity: _identity, ...content } = manifest;
  return content;
}

export function resolveCaseCitation(
  citation: CaseCitation,
  document: ReceiverDocument,
): unknown {
  if (citation.bundleHash !== document.bundle.sha256)
    throw new Error("Citation bundle identity does not match.");
  if (citation.kind === "range") {
    if (
      !Number.isSafeInteger(citation.startUs) ||
      !Number.isSafeInteger(citation.endUs) ||
      citation.startUs < document.incident.startUs ||
      citation.endUs > document.incident.endUs ||
      citation.startUs >= citation.endUs
    ) {
      throw new Error(
        "Citation range is outside the included half-open incident range.",
      );
    }
    return {
      startUs: citation.startUs,
      endUs: citation.endUs,
      sessionId: document.sourceSession.id,
    };
  }
  const evidence =
    citation.kind === "record"
      ? document.evidence.rawRecords.find(
          (record) => record.id === citation.recordId,
        )
      : document.evidence.diagnostics.find(
          (diagnostic) => diagnostic.id === citation.diagnosticId,
        );
  if (!evidence)
    throw new Error(
      `Citation ${citation.kind} is missing from the included evidence.`,
    );
  return evidence;
}
