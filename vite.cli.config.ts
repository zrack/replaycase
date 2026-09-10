import { readFileSync } from "node:fs";

import { defineConfig } from "vite";

const packageDocument = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version?: unknown;
};
const packageVersion = typeof packageDocument.version === "string" ? packageDocument.version : "0.0.0";
const releaseVersion = process.env.REPLAYCASE_BUILD_VERSION?.trim() || process.env.NARROWSLINK_BUILD_VERSION?.trim() || packageVersion;
const releaseCommit = process.env.REPLAYCASE_BUILD_COMMIT?.trim() || process.env.NARROWSLINK_BUILD_COMMIT?.trim() || "unknown";
const cliOutDir = process.env.REPLAYCASE_CLI_OUT_DIR?.trim() || process.env.NARROWSLINK_CLI_OUT_DIR?.trim() || "dist-cli";

export default defineConfig({
  plugins: [{
    name: "legacy-cli-alias",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "narrowslink.mjs",
        source: '#!/usr/bin/env node\nimport { runCli } from "./replaycase.mjs";\nprocess.exitCode = await runCli(process.argv.slice(2));\n',
      });
    },
  }],
  define: {
    __REPLAYCASE_COMMIT__: JSON.stringify(releaseCommit),
    __REPLAYCASE_VERSION__: JSON.stringify(releaseVersion),
  },
  publicDir: false,
  build: {
    emptyOutDir: true,
    lib: {
      entry: "scripts/replaycase.ts",
      formats: ["es"],
      fileName: () => "replaycase.mjs",
    },
    minify: false,
    outDir: cliOutDir,
    rollupOptions: {
      external: [/^node:/],
      output: {
        banner: "#!/usr/bin/env node",
      },
    },
    sourcemap: false,
    target: "node20",
  },
});
