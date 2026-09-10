import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { preview } from "vite";

const host = "127.0.0.1";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function requestedPort() {
  const raw = process.env.REPLAYCASE_E2E_PORT?.trim() || process.env.NARROWSLINK_E2E_PORT?.trim();
  if (!raw) return 0;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(
      "REPLAYCASE_E2E_PORT must be an integer between 1 and 65535.",
    );
  }
  return value;
}

const server = await preview({
  root: repositoryRoot,
  preview: {
    host,
    port: requestedPort(),
    strictPort: true,
    open: false,
  },
});

try {
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine the source-test preview port.");
  }

  const baseUrl = `http://${host}:${address.port}`;
  const playwrightCli =
    createRequire(import.meta.url).resolve("@playwright/test/cli");

  process.stdout.write(`Source-test preview ready at ${baseUrl}\n`);

  const child = spawn(
    process.execPath,
    [playwrightCli, "test", ...process.argv.slice(2)],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        REPLAYCASE_E2E_BASE_URL: baseUrl,
      },
      stdio: "inherit",
    },
  );

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });

  process.exitCode = exitCode;
} finally {
  await server.close();
}
