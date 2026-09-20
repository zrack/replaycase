import { buildEvidenceBundle } from "../../src/domain/bundle";
import { sha256Hex } from "../../src/domain/canonical";
import { newCaseContent } from "../../src/domain/case";
import {
  bytesToHex,
  encodeFrame,
  SUPPORTED_DECODER,
} from "../../src/domain/decoder";
import { parseSession } from "../../src/domain/session";
import type { SessionDocumentV1 } from "../../src/domain/types";

export const CASE_TEST_TIME = "2026-09-19T12:00:00.000Z";
export const CASE_TEST_ID = "155a668b-e850-4bfc-9bd8-95a83f53c280";
export async function caseFixture(recordCount = 3) {
  const bundles = await Promise.all(
    ["Baseline", "Failure", "Post-fix"].map(async (title, variant) => {
      const document: SessionDocumentV1 = {
        format: "narrowslink/session",
        formatVersion: 1,
        id: `case-${variant}`,
        title,
        startedAt: CASE_TEST_TIME,
        displayTimeZone: "UTC",
        durationUs: recordCount * 1_000_000,
        source: {
          id: "case-source",
          kind: "file",
          label: "Controlled test fixture",
        },
        decoder: { ...SUPPORTED_DECODER },
        records: Array.from({ length: recordCount }, (_, index) => {
          const bytes = encodeFrame({
            familyId: 0x02,
            sequence: index,
            deviceTimeMs: index * 1000,
            payload: new Uint8Array(8),
            corruptChecksum: variant === 1 && index === 1,
          });
          return {
            id: `record-${index}`,
            index,
            sourceId: "case-source",
            offsetUs: index * 1_000_000,
            dataHex: bytesToHex(bytes),
            captureBytes: bytes.length,
            wireBytes: bytes.length,
            transport: { kind: "file" as const },
          };
        }),
        incidents: [],
      };
      const bundle = await buildEvidenceBundle({
        session: parseSession(document),
        range: {
          title: `${title} range`,
          startUs: 0,
          endUs: recordCount * 1_000_000,
        },
        generatedAt: CASE_TEST_TIME,
      });
      return bundle;
    }),
  );
  const content = newCaseContent(
    "Radio reset investigation",
    CASE_TEST_ID,
    CASE_TEST_TIME,
  );
  content.bundles = bundles.map((bytes, index) => ({
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
    label: ["Baseline", "Failure", "Post-fix"][index]!,
    fileName: `run-${index}.nlb`,
  }));
  return { content, bundles };
}
