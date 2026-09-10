#!/usr/bin/env node

import { buildReproducibleRelease, buildUsage, parseBuildArguments, stableJson } from "./release-lib.mjs";

async function main() {
  const options = parseBuildArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(buildUsage());
    return;
  }
  const result = await buildReproducibleRelease({
    outputRoot: options.outputRoot,
    strict: options.strict,
  });
  process.stdout.write(stableJson(result));
}

main().catch((error) => {
  process.stderr.write(`ReplayCase release build failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
