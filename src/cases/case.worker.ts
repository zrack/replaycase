/// <reference lib="webworker" />
import {
  buildCaseArchive,
  verifyCaseArchive,
} from "../../verifier/case-verifier";
import { sha256Hex } from "../domain/canonical";
import { CASE_LIMITS } from "../domain/case";
import {
  CASE_ARRAY_KEYS,
  emptyEvidenceArrays,
  type CaseArrayKey,
  type CaseRequest,
  type CaseResponse,
} from "./case-processing";

const worker = self as DedicatedWorkerGlobalScope;
const send = (response: CaseResponse, transfer: Transferable[] = []) =>
  worker.postMessage(response, transfer);
worker.onmessage = (event: MessageEvent<CaseRequest>) => {
  try {
    const request = event.data;
    const progress = (percent: number, message: string) =>
      send({ type: "progress", percent, message });
    if (
      request.kind === "import" &&
      request.expectedHash &&
      sha256Hex(request.archive) !== request.expectedHash
    )
      throw new Error(
        "Stored case checksum mismatch. Evidence was not repaired or replaced.",
      );
    if (request.kind === "build") {
      for (const addition of request.additions ?? []) {
        const sha256 = sha256Hex(addition.bytes);
        if (request.content.bundles.some((bundle) => bundle.sha256 === sha256))
          continue;
        if (request.bundles.length >= CASE_LIMITS.bundles)
          throw new Error("A case supports at most 16 distinct bundles.");
        request.content.bundles.push({
          sha256,
          bytes: addition.bytes.byteLength,
          label: addition.fileName.replace(/\.nlb$/i, ""),
          fileName: addition.fileName,
        });
        request.bundles.push(addition.bytes);
      }
    }
    const value =
      request.kind === "import"
        ? verifyCaseArchive(request.archive, progress)
        : buildCaseArchive(request.content, request.bundles, progress);
    for (const [index, bundle] of value.bundles.entries()) {
      const counts = Object.fromEntries(
        CASE_ARRAY_KEYS.map((key) => [
          key,
          bundle.document.evidence[key].length,
        ]),
      ) as Record<CaseArrayKey, number>;
      send(
        {
          type: "bundle",
          index,
          counts,
          bundle: {
            bytes: bundle.bytes,
            document: emptyEvidenceArrays(bundle.document),
          },
        },
        [bundle.bytes.buffer as ArrayBuffer],
      );
      for (const key of CASE_ARRAY_KEYS) {
        const values = bundle.document.evidence[key];
        for (let offset = 0; offset < values.length; offset += 1_000)
          send({
            type: "chunk",
            index,
            key,
            offset,
            values: values.slice(offset, offset + 1_000),
          });
      }
    }
    send({ type: "progress", percent: 100, message: "Case verified" });
    const { bundles: _bundles, ...result } = value;
    send({ type: "complete", value: result }, [
      result.archive.buffer as ArrayBuffer,
    ]);
  } catch (error) {
    send({
      type: "error",
      message:
        error instanceof Error
          ? error.message
          : "The case could not be verified.",
    });
  }
};
