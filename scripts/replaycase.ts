import { realpathSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { verifyDecoderPackConformance } from "../src/domain/decoder-conformance";
import {
  DecoderPackValidationError,
  MAX_DECODER_PACK_BYTES,
  parseBoundedDecoderPackJson,
  sealDecoderPack,
  serializeDecoderPack,
  type DecoderPackDocument,
} from "../src/domain/decoder-pack";
import {
  EvidenceVerificationError,
  type EvidenceVerificationReport,
} from "../verifier/evidence-verifier";
import { verifyEvidenceBundleFile } from "../verifier/evidence-verifier-file";
import {
  openOperatorUrl,
  parseServeArguments,
  ServeArgumentError,
  startOperatorRuntime,
  type OperatorRuntime,
  type ReleaseIdentity,
} from "./operator-runtime";

declare const __REPLAYCASE_VERSION__: string;
declare const __REPLAYCASE_COMMIT__: string;

export const REPLAYCASE_RELEASE: ReleaseIdentity = Object.freeze({
  version: typeof __REPLAYCASE_VERSION__ === "string" ? __REPLAYCASE_VERSION__ : "0.4.0",
  commit: typeof __REPLAYCASE_COMMIT__ === "string" ? __REPLAYCASE_COMMIT__ : "unknown",
});

interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface ShutdownController {
  once(event: string, listener: (...arguments_: unknown[]) => void): unknown;
  off(event: string, listener: (...arguments_: unknown[]) => void): unknown;
}

interface FailedVerificationReport {
  format: "narrowslink/bundle-verification-report";
  formatVersion: 1;
  integrity: "failed";
  authenticity: "not-established";
  error: {
    code: string;
    message: string;
    path?: string;
  };
}

interface DecoderPackPassReport {
  format: "narrowslink/decoder-pack-report";
  formatVersion: 1;
  status: "pass";
  action: "validated" | "sealed";
  pack: {
    id: string;
    revision: string;
    displayName: string;
    sha256: string;
    runtimeId: string;
    runtimeRevision: string;
    fixtureCount: number;
  };
  outputPath?: string;
}

const DEFAULT_IO: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function cleanTerminalText(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu,
    (character) => `\\u${character.codePointAt(0)?.toString(16).padStart(4, "0") ?? "fffd"}`,
  );
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu,
    (character) => `\\u${character.codePointAt(0)?.toString(16).padStart(4, "0") ?? "fffd"}`,
  );
}

export function renderVerificationReport(report: EvidenceVerificationReport): string {
  const warnings = report.warnings.length === 0
    ? "Warnings: none"
    : ["Warnings:", ...report.warnings.map((warning) => `  - ${cleanTerminalText(warning)}`)].join("\n");
  return [
    "ReplayCase evidence verification: PASS",
    `Integrity: ${report.integrity}`,
    `Evidence: ${report.evidence} (capture: ${report.captureEvidence}; provenance: ${report.provenanceEvidence})`,
    `Authenticity: ${report.authenticity} (bundle is unsigned)`,
    `Bundle SHA-256: ${report.bundle.sha256}`,
    `Bundle bytes: ${report.bundle.bytes}`,
    `Session: ${cleanTerminalText(report.session.title)} [${cleanTerminalText(report.session.id)}]`,
    `Source: ${cleanTerminalText(report.session.sourceId)}; session format: v${report.session.formatVersion}`,
    `Decoder: ${cleanTerminalText(report.session.decoderId)} ${cleanTerminalText(report.session.decoderRevision)}; schema ${report.session.schemaHash}`,
    `Pack: ${report.session.packHash ?? "legacy descriptor"}${report.session.runtimeId == null ? "" : `; runtime ${report.session.runtimeId} r${report.session.runtimeRevision}`}`,
    `Selection: [${report.selection.startUs}, ${report.selection.endUs}) microseconds`,
    `Artifacts: ${report.artifacts.count}`,
    warnings,
    "",
  ].join("\n");
}

function failureReport(error: EvidenceVerificationError): FailedVerificationReport {
  return {
    format: "narrowslink/bundle-verification-report",
    formatVersion: 1,
    integrity: "failed",
    authenticity: "not-established",
    error: {
      code: error.code,
      message: error.message,
      ...(error.path ? { path: error.path } : {}),
    },
  };
}

function rootUsage(): string {
  return [
    "Usage: replaycase <command> [options]",
    "",
    "Commands:",
    "  serve                 Start the self-contained local operator application",
    "  verify <bundle.nlb>   Verify a ReplayCase evidence bundle",
    "  decoder <command>     Seal or validate a bounded decoder pack",
    "  version               Print the release identity",
    "",
    "Run `replaycase <command> --help` for command-specific options.",
    "",
  ].join("\n");
}

function decoderUsage(): string {
  return [
    "Usage:",
    "  replaycase decoder validate <pack.nldecoder> [--json]",
    "  replaycase decoder seal <draft.json> --out <pack.nldecoder> [--json]",
    "",
    "Validates pack identity, runtime compatibility, and bundled conformance fixtures.",
    "Sealing replaces any draft integrity field, validates the result, and refuses to overwrite the output path.",
    "",
  ].join("\n");
}

function verifyUsage(): string {
  return [
    "Usage: replaycase verify <bundle.nlb> [--json]",
    "",
    "Verifies a ReplayCase v3 or v4 evidence bundle locally without network access.",
    "Exit 0: internally consistent; exit 1: invalid or tampered; exit 2: usage or file I/O failure.",
    "",
  ].join("\n");
}

function serveUsage(): string {
  return [
    "Usage: replaycase serve [options]",
    "",
    "Starts the production ReplayCase UI and authenticated UDP bridge locally.",
    "",
    "Options:",
    "  --app-port <port>            Stable UI port (default 47890; 0 selects a free port)",
    "  --bridge-port <port>         Loopback bridge port (default 0 selects a free port)",
    "  --udp-host <host>            Default UDP bind host (default 127.0.0.1)",
    "  --udp-port <port>            Default UDP bind port (default 9104; 0 selects a free port)",
    "  --multicast-group <ip>       Default IPv4 or IPv6 multicast group",
    "  --multicast-interface <ip>   Default local multicast interface address",
    "  --no-open                    Do not open the operator UI in a browser",
    "  --json-ready                 Emit one machine-readable readiness line",
    "  --help                       Show this message",
    "",
  ].join("\n");
}

function versionText(json: boolean): string {
  return json
    ? `${safeJson({ name: "replaycase", ...REPLAYCASE_RELEASE })}\n`
    : `ReplayCase ${REPLAYCASE_RELEASE.version} (${REPLAYCASE_RELEASE.commit})\n`;
}

function decoderPackReport(
  action: "validated" | "sealed",
  pack: DecoderPackDocument,
  fixtureCount: number,
  outputPath?: string,
): DecoderPackPassReport {
  return {
    format: "narrowslink/decoder-pack-report",
    formatVersion: 1,
    status: "pass",
    action,
    pack: {
      id: pack.id,
      revision: pack.revision,
      displayName: pack.displayName,
      sha256: pack.integrity.canonicalSha256,
      runtimeId: pack.runtime.id,
      runtimeRevision: pack.runtime.revision,
      fixtureCount,
    },
    ...(outputPath == null ? {} : { outputPath }),
  };
}

function renderDecoderPackReport(report: ReturnType<typeof decoderPackReport>): string {
  const pack = report.pack;
  return [
    `ReplayCase decoder pack: PASS (${report.action})`,
    `Pack: ${cleanTerminalText(pack.displayName)} [${cleanTerminalText(pack.id)} ${cleanTerminalText(pack.revision)}]`,
    `Pack SHA-256: ${pack.sha256}`,
    `Runtime: ${pack.runtimeId} r${pack.runtimeRevision}`,
    `Fixtures: ${pack.fixtureCount}`,
    ...("outputPath" in report ? [`Output: ${cleanTerminalText(String(report.outputPath))}`] : []),
    "",
  ].join("\n");
}

async function readDecoderPackInput(path: string): Promise<unknown> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Decoder pack input must be a regular file.");
  if (metadata.size > MAX_DECODER_PACK_BYTES) {
    throw new DecoderPackValidationError(
      `Decoder pack input exceeds the ${MAX_DECODER_PACK_BYTES}-byte file limit.`,
    );
  }
  return parseBoundedDecoderPackJson(await readFile(path, "utf8"));
}

function decoderFailureText(error: DecoderPackValidationError): string {
  const details = error.details.length > 0
    ? `\n${error.details.map((detail) => `  - ${cleanTerminalText(detail)}`).join("\n")}`
    : "";
  return `ReplayCase decoder pack: FAIL\n${cleanTerminalText(error.message)}${details}\n`;
}

async function runDecoder(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(decoderUsage());
    return 0;
  }
  const command = argv[0];
  const json = argv.includes("--json");

  if (command === "validate") {
    const positional = argv.slice(1).filter((argument) => argument !== "--json");
    if (positional.length !== 1 || positional[0] === "") {
      io.stderr(decoderUsage());
      return 2;
    }
    try {
      const result = verifyDecoderPackConformance(await readDecoderPackInput(positional[0] ?? ""));
      const report = decoderPackReport("validated", result.pack, result.fixtureIds.length);
      io.stdout(json ? `${safeJson(report)}\n` : renderDecoderPackReport(report));
      return 0;
    } catch (error) {
      if (error instanceof DecoderPackValidationError) {
        if (json) {
          io.stdout(`${safeJson({
            format: "narrowslink/decoder-pack-report",
            formatVersion: 1,
            status: "fail",
            error: { message: error.message, details: error.details },
          })}\n`);
        } else io.stderr(decoderFailureText(error));
        return 1;
      }
      io.stderr(`ReplayCase could not read the decoder pack: ${cleanTerminalText(error instanceof Error ? error.message : String(error))}\n`);
      return 2;
    }
  }

  if (command === "seal") {
    const argumentsWithoutJson = argv.slice(1).filter((argument) => argument !== "--json");
    const outputIndex = argumentsWithoutJson.indexOf("--out");
    const input = argumentsWithoutJson[0];
    const output = outputIndex >= 0 ? argumentsWithoutJson[outputIndex + 1] : undefined;
    const validShape = input != null
      && input !== ""
      && outputIndex === 1
      && output != null
      && output !== ""
      && argumentsWithoutJson.length === 3;
    if (!validShape) {
      io.stderr(decoderUsage());
      return 2;
    }
    try {
      const pack = sealDecoderPack(await readDecoderPackInput(input));
      const result = verifyDecoderPackConformance(pack);
      await writeFile(output, serializeDecoderPack(result.pack), { encoding: "utf8", flag: "wx" });
      const report = decoderPackReport("sealed", result.pack, result.fixtureIds.length, output);
      io.stdout(json ? `${safeJson(report)}\n` : renderDecoderPackReport(report));
      return 0;
    } catch (error) {
      if (error instanceof DecoderPackValidationError) {
        if (json) {
          io.stdout(`${safeJson({
            format: "narrowslink/decoder-pack-report",
            formatVersion: 1,
            status: "fail",
            error: { message: error.message, details: error.details },
          })}\n`);
        } else io.stderr(decoderFailureText(error));
        return 1;
      }
      io.stderr(`ReplayCase could not seal the decoder pack: ${cleanTerminalText(error instanceof Error ? error.message : String(error))}\n`);
      return 2;
    }
  }

  io.stderr(decoderUsage());
  return 2;
}

function readyDocument(runtime: OperatorRuntime): object {
  return {
    type: "narrowslink-serve-ready",
    formatVersion: 1,
    version: runtime.release.version,
    commit: runtime.release.commit,
    appUrl: runtime.appUrl,
    bridgeUrl: runtime.bridgeUrl,
    udpDefaults: runtime.udpDefaults,
  };
}

async function closeWithin(runtime: OperatorRuntime, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      runtime.close().then(() => true, () => false),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function waitForShutdown(
  runtime: OperatorRuntime,
  io: CliIo = DEFAULT_IO,
  controller: ShutdownController = process,
  timeoutMs = 5_000,
  forceExit: (code: number) => void = (code) => process.exit(code),
): Promise<number> {
  return await new Promise<number>((resolve) => {
    let stopping = false;
    let fatal = false;
    let exitCode = 0;

    const cleanup = () => {
      controller.off("SIGINT", onSigint);
      controller.off("SIGTERM", onSigterm);
      controller.off("SIGHUP", onSighup);
      controller.off("uncaughtException", onUncaughtException);
      controller.off("unhandledRejection", onUnhandledRejection);
    };
    const shutdown = (code: number, error?: unknown) => {
      exitCode = Math.max(exitCode, code);
      if (error !== undefined) {
        fatal = true;
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        io.stderr(`ReplayCase encountered a fatal runtime error: ${cleanTerminalText(message)}\n`);
      }
      if (stopping) return;
      stopping = true;
      void closeWithin(runtime, timeoutMs).then((closed) => {
        if (!closed) {
          exitCode = 1;
          io.stderr(`ReplayCase could not complete local evidence shutdown within ${timeoutMs} ms.\n`);
        }
        cleanup();
        if (!closed || fatal) {
          forceExit(Math.max(1, exitCode));
        }
        resolve(exitCode);
      });
    };
    const onSigint = () => shutdown(0);
    const onSigterm = () => shutdown(0);
    const onSighup = () => shutdown(0);
    const onUncaughtException = (error: unknown) => shutdown(1, error);
    const onUnhandledRejection = (reason: unknown) => shutdown(1, reason);
    controller.once("SIGINT", onSigint);
    controller.once("SIGTERM", onSigterm);
    controller.once("SIGHUP", onSighup);
    controller.once("uncaughtException", onUncaughtException);
    controller.once("unhandledRejection", onUnhandledRejection);
  });
}

async function runServe(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(serveUsage());
    return 0;
  }
  let options;
  try {
    options = parseServeArguments(argv);
  } catch (error) {
    const message = error instanceof ServeArgumentError ? error.message : "The serve options are invalid.";
    io.stderr(`${message}\n\n${serveUsage()}`);
    return 2;
  }

  let runtime: OperatorRuntime;
  try {
    runtime = await startOperatorRuntime({
      options,
      release: REPLAYCASE_RELEASE,
      moduleUrl: import.meta.url,
    });
  } catch (error) {
    io.stderr(`ReplayCase could not start: ${cleanTerminalText(error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }

  if (options.jsonReady) {
    io.stdout(`${safeJson(readyDocument(runtime)).replace(/\n/g, "")}\n`);
  } else {
    io.stdout(`ReplayCase ${runtime.release.version} is ready at ${runtime.appUrl}\n`);
  }
  if (options.openBrowser && !openOperatorUrl(runtime.appUrl)) {
    io.stderr(`Could not open a browser automatically. Open ${runtime.appUrl}\n`);
  }
  return await waitForShutdown(runtime, io);
}

async function runVerify(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(verifyUsage());
    return 0;
  }
  const json = argv.includes("--json");
  const positional = argv.filter((argument) => argument !== "--json");
  if (positional.length !== 1 || positional[0] === "") {
    if (json) {
      io.stdout(`${safeJson({
        format: "narrowslink/bundle-verification-report",
        formatVersion: 1,
        integrity: "failed",
        authenticity: "not-established",
        error: { code: "USAGE_ERROR", message: "Expected: replaycase verify <bundle.nlb> [--json]" },
      } satisfies FailedVerificationReport)}\n`);
    } else {
      io.stderr(verifyUsage());
    }
    return 2;
  }

  try {
    const verified = await verifyEvidenceBundleFile(positional[0] ?? "");
    io.stdout(json ? `${safeJson(verified.report)}\n` : renderVerificationReport(verified.report));
    return 0;
  } catch (error) {
    const verificationError = error instanceof EvidenceVerificationError
      ? error
      : new EvidenceVerificationError("CONTENT_INVALID", "Evidence verification failed unexpectedly.", undefined, { cause: error });
    const exitCode = verificationError.code === "ARCHIVE_IO_ERROR" ? 2 : 1;
    if (json) io.stdout(`${safeJson(failureReport(verificationError))}\n`);
    else io.stderr(`ReplayCase evidence verification: FAIL\n${verificationError.code}: ${cleanTerminalText(verificationError.message)}${verificationError.path ? `\nPath: ${cleanTerminalText(verificationError.path)}` : ""}\n`);
    return exitCode;
  }
}

export async function runCli(argv: readonly string[], io: CliIo = DEFAULT_IO): Promise<number> {
  if (argv.length === 1 && argv[0] === "--json") {
    io.stdout(`${safeJson({
      format: "narrowslink/bundle-verification-report",
      formatVersion: 1,
      integrity: "failed",
      authenticity: "not-established",
      error: { code: "USAGE_ERROR", message: "Expected a ReplayCase command." },
    } satisfies FailedVerificationReport)}\n`);
    return 2;
  }
  if (argv.length === 1 && argv[0] === "--version") {
    io.stdout(`${REPLAYCASE_RELEASE.version}\n`);
    return 0;
  }
  if (argv[0] === "version") {
    if (argv.length === 1) {
      io.stdout(versionText(false));
      return 0;
    }
    if (argv.length === 2 && argv[1] === "--json") {
      io.stdout(versionText(true));
      return 0;
    }
    io.stderr(rootUsage());
    return 2;
  }
  if (argv[0] === "serve") return runServe(argv.slice(1), io);
  if (argv[0] === "verify") return runVerify(argv.slice(1), io);
  if (argv[0] === "decoder") return runDecoder(argv.slice(1), io);
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    io.stdout(rootUsage());
    return 0;
  }
  io.stderr(rootUsage());
  return 2;
}

export function isCliEntry(moduleUrl: string, entryPath: string): boolean {
  try {
    return moduleUrl === pathToFileURL(realpathSync(entryPath)).href;
  } catch {
    return moduleUrl === pathToFileURL(entryPath).href;
  }
}

const entryPath = process.argv[1];
if (entryPath && isCliEntry(import.meta.url, entryPath)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
