import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");
const packageDocument = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const expectedVersion = packageDocument.version;
const outputDirectory = join(projectRoot, "dist-cli");
const cliPath = join(outputDirectory, "replaycase.mjs");
const legacyPath = join(outputDirectory, "narrowslink.mjs");
const outputFiles = readdirSync(outputDirectory).sort();
if (outputFiles.some((path) => !["replaycase.mjs", "narrowslink.mjs"].includes(path))) {
  throw new Error(`CLI build contains unrelated public assets: ${outputFiles.join(", ")}`);
}
if (!readFileSync(cliPath, "utf8").startsWith("#!/usr/bin/env node\n")) {
  throw new Error("CLI build is missing its Node shebang.");
}

const directory = mkdtempSync(join(tmpdir(), "replaycase-cli-smoke-"));
const symlinkPath = join(directory, "replaycase-bin.mjs");
try {
  symlinkSync(cliPath, symlinkPath);
  if (realpathSync(symlinkPath) !== realpathSync(cliPath)) throw new Error("CLI smoke symlink did not resolve to the build.");

  for (const invokedPath of [cliPath, legacyPath, symlinkPath]) {
    const result = spawnSync(process.execPath, [invokedPath, "--help"], { encoding: "utf8" });
    if (
      result.status !== 0
      || !result.stdout.includes("Usage: replaycase <command>")
      || !result.stdout.includes("serve")
      || !result.stdout.includes("verify")
      || !result.stdout.includes("decoder")
    ) {
      throw new Error(`CLI entry smoke failed for ${invokedPath}: ${result.stderr || result.stdout}`);
    }
  }

  const usage = spawnSync(process.execPath, [symlinkPath, "verify", "--json"], { encoding: "utf8" });
  if (usage.status !== 2) throw new Error(`CLI JSON usage exit was ${usage.status}; expected 2.`);
  const report = JSON.parse(usage.stdout);
  if (report.integrity !== "failed" || report.error?.code !== "USAGE_ERROR") {
    throw new Error("CLI JSON usage report is not stable.");
  }

  const version = spawnSync(process.execPath, [symlinkPath, "version", "--json"], { encoding: "utf8" });
  if (version.status !== 0) throw new Error(`CLI version exit was ${version.status}; expected 0.`);
  const identity = JSON.parse(version.stdout);
  if (identity.name !== "replaycase" || identity.version !== expectedVersion || typeof identity.commit !== "string") {
    throw new Error("CLI release identity is not stable.");
  }
  const legacyVersion = spawnSync(process.execPath, [legacyPath, "version", "--json"], { encoding: "utf8" });
  if (legacyVersion.status !== 0 || legacyVersion.stdout !== version.stdout) {
    throw new Error("The legacy CLI alias does not identify the same ReplayCase build.");
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("ReplayCase receiver CLI build smoke passed.");
