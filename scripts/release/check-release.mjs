#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  buildReproducibleRelease,
  REPOSITORY_ROOT,
  stableJson,
} from "./release-lib.mjs";

const outputRoot = join(REPOSITORY_ROOT, "output", "release");
const build = await buildReproducibleRelease({ outputRoot });
process.stdout.write(stableJson(build));

const npmArguments = ["run", "test:release"];
const command = process.env.npm_execpath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const args = process.env.npm_execpath
  ? [process.env.npm_execpath, ...npmArguments]
  : npmArguments;
const acceptance = spawnSync(command, args, {
  cwd: REPOSITORY_ROOT,
  env: {
    ...process.env,
    REPLAYCASE_RELEASE_ARCHIVE: build.archive,
  },
  stdio: "inherit",
});
if (acceptance.error) throw acceptance.error;
if (acceptance.status !== 0) {
  throw new Error(`Unpacked ReplayCase release acceptance failed with exit ${String(acceptance.status)}.`);
}

process.stdout.write(`ReplayCase ${build.version} release bytes passed reproducibility and unpacked acceptance.\n`);
