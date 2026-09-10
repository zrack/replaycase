import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NMEA0183_DECODER_PACK } from "../src/domain/decoder";
import { runCli } from "./replaycase";

function ioCapture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    },
    output: () => ({ stdout, stderr }),
  };
}

describe("decoder pack CLI", () => {
  it("seals a draft and validates the resulting portable pack", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replaycase-decoder-cli-"));
    try {
      const draftPath = join(directory, "nmea-draft.json");
      const packPath = join(directory, "nmea.nldecoder");
      const { integrity: _integrity, ...draft } = NMEA0183_DECODER_PACK;
      await writeFile(draftPath, `${JSON.stringify(draft, null, 2)}\n`);

      const seal = ioCapture();
      expect(await runCli(["decoder", "seal", draftPath, "--out", packPath, "--json"], seal.io)).toBe(0);
      expect(JSON.parse(seal.output().stdout)).toMatchObject({
        status: "pass",
        action: "sealed",
        pack: {
          id: "NMEA-0183",
          sha256: NMEA0183_DECODER_PACK.integrity.canonicalSha256,
          fixtureCount: 4,
        },
        outputPath: packPath,
      });

      const written = JSON.parse(await readFile(packPath, "utf8"));
      expect(written.integrity.canonicalSha256).toBe(NMEA0183_DECODER_PACK.integrity.canonicalSha256);

      const validate = ioCapture();
      expect(await runCli(["decoder", "validate", packPath], validate.io)).toBe(0);
      expect(validate.output().stdout).toContain("ReplayCase decoder pack: PASS (validated)");
      expect(validate.output().stderr).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a validation failure for altered pack content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replaycase-decoder-cli-invalid-"));
    try {
      const packPath = join(directory, "altered.nldecoder");
      const altered = structuredClone(NMEA0183_DECODER_PACK);
      altered.description = "Altered without resealing";
      await writeFile(packPath, `${JSON.stringify(altered)}\n`);
      const capture = ioCapture();

      expect(await runCli(["decoder", "validate", packPath, "--json"], capture.io)).toBe(1);
      expect(JSON.parse(capture.output().stdout)).toMatchObject({
        status: "fail",
        error: { message: "The decoder pack content does not match its declared identity." },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
