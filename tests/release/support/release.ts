import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

const READY_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 8_000;
const COMMAND_TIMEOUT_MS = 30_000;
const PROCESS_OUTPUT_LIMIT = 256 * 1024;
const RELEASE_METADATA_LIMIT = 1024 * 1024;
const releaseVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const commitPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const releaseManifestSelfPath = "release-manifest.json";

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ReleaseReadyDocument {
  readonly type: "narrowslink-serve-ready";
  readonly formatVersion: 1;
  readonly version: string;
  readonly commit: string;
  readonly appUrl: string;
  readonly bridgeUrl: string;
  readonly udpDefaults: {
    readonly host: string;
    readonly port: number;
    readonly multicastGroup: string | null;
    readonly multicastInterface: string | null;
  };
}

export interface ReleaseIdentity {
  readonly version: string;
  readonly commit: string;
}

interface ReleasePayloadFile {
  readonly path: string;
  readonly bytes: number;
  readonly mode: "0644" | "0755";
  readonly sha256: string;
}

interface ParsedReleaseManifest {
  readonly identity: ReleaseIdentity;
  readonly sourceDateEpoch: number;
  readonly mode: "preview" | "release";
  readonly payloadFiles: readonly ReleasePayloadFile[];
}

export interface ReleaseInstallation {
  readonly temporaryRoot: string;
  readonly packageRoot: string;
  readonly executablePath: string;
  readonly appRoot: string;
  readonly fixturePath: string;
  readonly operatorWorkingDirectory: string;
  readonly identity: ReleaseIdentity;
  remove(): Promise<void>;
}

export interface RunningRelease {
  readonly ready: ReleaseReadyDocument;
  readonly executablePath: string;
  readonly operatorWorkingDirectory: string;
  stop(): Promise<void>;
}

export interface VerificationReport {
  readonly integrity: string;
  readonly evidence: string;
  readonly captureEvidence: string;
  readonly provenanceEvidence: string;
  readonly authenticity: string;
  readonly bundle: {
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly session: {
    readonly id: string;
    readonly title: string;
  };
  readonly selection: {
    readonly startUs: number;
    readonly endUs: number;
  };
  readonly artifacts: {
    readonly count: number;
  };
  readonly warnings: readonly string[];
}

function boundedAppend(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= PROCESS_OUTPUT_LIMIT
    ? next
    : next.slice(next.length - PROCESS_OUTPUT_LIMIT);
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.NODE_PATH;
  return environment;
}

function runProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio = {},
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, [...args], {
      ...options,
      env: options.env ?? childEnvironment(),
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(
          `${command} did not exit within ${timeoutMs} ms.`
          + `${stdout ? `\nstdout:\n${stdout}` : ""}`
          + `${stderr ? `\nstderr:\n${stderr}` : ""}`,
        ));
      } else {
        resolveProcess({ code, signal, stdout, stderr });
      }
    });
  });
}

async function requireFile(path: string, label: string): Promise<void> {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile()) {
    throw new Error(`The unpacked release is missing ${label}: ${path}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedBytes(path: string, label: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > RELEASE_METADATA_LIMIT) {
    throw new Error(`${label} is outside the release metadata size limit.`);
  }
  return readFile(path);
}

async function readBoundedJson(path: string, label: string): Promise<unknown> {
  const bytes = await readBoundedBytes(path, label);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function containsSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    /token|secret|credential|authorization/i.test(key) || containsSecretKey(child)
  ));
}

function isPortablePayloadPath(value: string): boolean {
  return (
    value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function parsePayloadFiles(payload: Record<string, unknown>): readonly ReleasePayloadFile[] {
  if (
    payload.root !== "package"
    || payload.hashAlgorithm !== "sha256"
    || !Array.isArray(payload.excludes)
    || payload.excludes.length !== 1
    || payload.excludes[0] !== releaseManifestSelfPath
    || !Array.isArray(payload.files)
    || payload.files.length === 0
  ) {
    throw new Error("The release manifest payload contract is invalid.");
  }

  const paths = new Set<string>();
  const files = payload.files.map((entry): ReleasePayloadFile => {
    if (
      !isRecord(entry)
      || typeof entry.path !== "string"
      || !isPortablePayloadPath(entry.path)
      || entry.path === releaseManifestSelfPath
      || !Number.isSafeInteger(entry.bytes)
      || (entry.bytes as number) < 0
      || (entry.mode !== "0644" && entry.mode !== "0755")
      || typeof entry.sha256 !== "string"
      || !sha256Pattern.test(entry.sha256)
    ) {
      throw new Error("The release manifest contains an invalid payload file entry.");
    }
    if (paths.has(entry.path)) {
      throw new Error(`The release manifest repeats payload path ${entry.path}.`);
    }
    paths.add(entry.path);
    const requiredMode = ["bin/replaycase.mjs", "bin/narrowslink.mjs"].includes(entry.path) ? "0755" : "0644";
    if (entry.mode !== requiredMode) {
      throw new Error(`The release manifest declares an invalid mode for ${entry.path}.`);
    }
    return {
      path: entry.path,
      bytes: entry.bytes as number,
      mode: entry.mode,
      sha256: entry.sha256,
    };
  });
  const sortedPaths = [...paths].sort((left, right) => left.localeCompare(right, "en"));
  if (files.some((file, index) => file.path !== sortedPaths[index])) {
    throw new Error("The release manifest payload files are not in canonical path order.");
  }
  return files;
}

function parseReleaseManifest(value: unknown): ParsedReleaseManifest {
  if (!isRecord(value)) {
    throw new Error("The unpacked release manifest is not a JSON object.");
  }
  const source = value.source;
  const runtime = value.runtime;
  const payload = value.payload;
  const inputs = value.inputs;
  const toolchain = value.toolchain;
  if (
    value.format !== "replaycase/release-manifest"
    || value.formatVersion !== 1
    || value.product !== "ReplayCase"
    || value.packageName !== "replaycase"
    || typeof value.version !== "string"
    || !releaseVersionPattern.test(value.version)
    || typeof value.commit !== "string"
    || !commitPattern.test(value.commit)
    || typeof value.tree !== "string"
    || !commitPattern.test(value.tree)
    || !Number.isSafeInteger(value.sourceDateEpoch)
    || (value.sourceDateEpoch as number) <= 0
    || typeof value.dirty !== "boolean"
    || (value.mode !== "preview" && value.mode !== "release")
    || typeof value.tagVerified !== "boolean"
    || typeof value.tagAnnotated !== "boolean"
    || typeof value.buildId !== "string"
    || !isRecord(source)
    || source.repository !== "https://github.com/zrack/replaycase"
    || source.commit !== value.commit
    || source.tree !== value.tree
    || source.sourceDateEpoch !== value.sourceDateEpoch
    || source.dirty !== value.dirty
    || source.tagAnnotated !== value.tagAnnotated
    || !isRecord(runtime)
    || typeof runtime.node !== "string"
    || runtime.node.length === 0
    || runtime.npmDependencies !== 0
    || runtime.networkRequired !== false
    || !isRecord(inputs)
    || !isRecord(inputs.packageLock)
    || inputs.packageLock.path !== "package-lock.json"
    || typeof inputs.packageLock.sha256 !== "string"
    || !sha256Pattern.test(inputs.packageLock.sha256)
    || !isRecord(toolchain)
    || typeof toolchain.node !== "string"
    || typeof toolchain.npm !== "string"
    || typeof toolchain.vite !== "string"
    || typeof toolchain.typescript !== "string"
    || !isRecord(payload)
  ) {
    throw new Error("The unpacked release manifest does not match the supported v1 identity contract.");
  }

  const expectedTag = `v${value.version}`;
  const expectedBuildId = `${value.version}+g${value.commit.slice(0, 12)}${value.dirty ? ".dirty" : ""}`;
  if (
    value.tag !== expectedTag
    || source.tag !== expectedTag
    || value.buildId !== expectedBuildId
    || (
      value.mode === "release"
      && (value.dirty || !value.tagVerified || !value.tagAnnotated)
    )
  ) {
    throw new Error("The unpacked release manifest contains inconsistent tag or build identity.");
  }

  return {
    identity: { version: value.version, commit: value.commit },
    sourceDateEpoch: value.sourceDateEpoch as number,
    mode: value.mode,
    payloadFiles: parsePayloadFiles(payload),
  };
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function portableRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function collectPackageFiles(
  packageRoot: string,
): Promise<Map<string, { bytes: number; mode: string; sha256: string }>> {
  const files = new Map<string, { bytes: number; mode: string; sha256: string }>();
  const pending = [packageRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const currentMetadata = await lstat(current);
    if (currentMetadata.isSymbolicLink()) {
      throw new Error(`The unpacked release contains a symbolic link: ${portableRelativePath(packageRoot, current)}.`);
    }
    if (currentMetadata.isDirectory()) {
      const names = (await readdir(current)).sort((left, right) => left.localeCompare(right, "en"));
      for (const name of names) pending.push(join(current, name));
      continue;
    }
    if (!currentMetadata.isFile()) {
      throw new Error(`The unpacked release contains an unsupported filesystem entry: ${current}.`);
    }
    const path = portableRelativePath(packageRoot, current);
    const bytes = await readFile(current);
    files.set(path, {
      bytes: currentMetadata.size,
      mode: (currentMetadata.mode & 0o777).toString(8).padStart(4, "0"),
      sha256: sha256Bytes(bytes),
    });
  }
  return files;
}

async function reconcilePayload(
  packageRoot: string,
  manifest: ParsedReleaseManifest,
): Promise<void> {
  const actual = await collectPackageFiles(packageRoot);
  const expectedPaths = [
    ...manifest.payloadFiles.map((file) => file.path),
    releaseManifestSelfPath,
  ].sort((left, right) => left.localeCompare(right, "en"));
  const actualPaths = [...actual.keys()].sort((left, right) => left.localeCompare(right, "en"));
  if (actualPaths.join("\n") !== expectedPaths.join("\n")) {
    throw new Error(
      "The unpacked release file set does not match release-manifest.json."
      + `\nExpected: ${expectedPaths.join(", ")}`
      + `\nActual: ${actualPaths.join(", ")}`,
    );
  }

  const manifestMetadata = actual.get(releaseManifestSelfPath);
  if (manifestMetadata?.mode !== "0644") {
    throw new Error("The unpacked release manifest does not have mode 0644.");
  }
  for (const expected of manifest.payloadFiles) {
    const observed = actual.get(expected.path);
    if (!observed) {
      throw new Error(`The unpacked release is missing manifest payload ${expected.path}.`);
    }
    if (
      observed.bytes !== expected.bytes
      || observed.mode !== expected.mode
      || observed.sha256 !== expected.sha256
    ) {
      throw new Error(
        `The unpacked release payload does not match release-manifest.json for ${expected.path}.`
        + ` Expected ${expected.bytes} bytes, ${expected.mode}, ${expected.sha256};`
        + ` observed ${observed.bytes} bytes, ${observed.mode}, ${observed.sha256}.`,
      );
    }
  }
}

function validateCycloneDxSbom(value: unknown, manifest: ParsedReleaseManifest): void {
  if (!isRecord(value)) {
    throw new Error("The embedded CycloneDX SBOM is not a JSON object.");
  }
  const metadata = value.metadata;
  if (
    value["$schema"] !== "http://cyclonedx.org/schema/bom-1.5.schema.json"
    || value.bomFormat !== "CycloneDX"
    || value.specVersion !== "1.5"
    || value.version !== 1
    || typeof value.serialNumber !== "string"
    || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.serialNumber)
    || !isRecord(metadata)
    || metadata.timestamp !== new Date(manifest.sourceDateEpoch * 1_000).toISOString()
    || !isRecord(metadata.component)
    || !Array.isArray(value.components)
    || !Array.isArray(value.dependencies)
  ) {
    throw new Error("The embedded CycloneDX SBOM does not match the supported 1.5 schema contract.");
  }

  const root = metadata.component;
  const rootReference = `pkg:npm/replaycase@${manifest.identity.version}`;
  if (
    root["bom-ref"] !== rootReference
    || root.purl !== rootReference
    || root.type !== "application"
    || root.name !== "replaycase"
    || root.version !== manifest.identity.version
    || !Array.isArray(root.properties)
    || !root.properties.some((property) => (
      isRecord(property)
      && property.name === "replaycase:distribution"
      && property.value === "bundled"
    ))
    || !root.properties.some((property) => (
      isRecord(property)
      && property.name === "replaycase:source-commit"
      && property.value === manifest.identity.commit
    ))
  ) {
    throw new Error("The embedded CycloneDX SBOM root identity does not match the release manifest.");
  }

  const componentReferences = new Set<string>([rootReference]);
  for (const component of value.components) {
    if (
      !isRecord(component)
      || typeof component["bom-ref"] !== "string"
      || component["bom-ref"].length === 0
      || componentReferences.has(component["bom-ref"])
    ) {
      throw new Error("The embedded CycloneDX SBOM contains an invalid or duplicate component bom-ref.");
    }
    componentReferences.add(component["bom-ref"]);
  }

  const dependencyReferences = new Set<string>();
  for (const dependency of value.dependencies) {
    if (
      !isRecord(dependency)
      || typeof dependency.ref !== "string"
      || !componentReferences.has(dependency.ref)
      || dependencyReferences.has(dependency.ref)
      || !Array.isArray(dependency.dependsOn)
    ) {
      throw new Error("The embedded CycloneDX SBOM contains an invalid dependency ref.");
    }
    dependencyReferences.add(dependency.ref);
    for (const target of dependency.dependsOn) {
      if (typeof target !== "string" || !componentReferences.has(target)) {
        throw new Error(`The embedded CycloneDX dependency target does not resolve: ${String(target)}.`);
      }
    }
  }
  if (!dependencyReferences.has(rootReference)) {
    throw new Error("The embedded CycloneDX dependency graph omits the ReplayCase root component.");
  }
}

async function validatePublishedMetadata(
  archivePath: string,
  packageRoot: string,
  manifest: ParsedReleaseManifest,
): Promise<void> {
  const releaseRoot = dirname(archivePath);
  const embeddedManifestPath = join(packageRoot, releaseManifestSelfPath);
  const embeddedSbomPath = join(packageRoot, "SBOM.cdx.json");
  const externalManifestPath = join(
    releaseRoot,
    `replaycase-${manifest.identity.version}.release.json`,
  );
  const externalSbomPath = join(
    releaseRoot,
    `replaycase-${manifest.identity.version}.cdx.json`,
  );
  const [
    embeddedManifest,
    externalManifest,
    embeddedSbom,
    externalSbom,
  ] = await Promise.all([
    readBoundedBytes(embeddedManifestPath, "The embedded release manifest"),
    readBoundedBytes(externalManifestPath, "The external release manifest"),
    readBoundedBytes(embeddedSbomPath, "The embedded CycloneDX SBOM"),
    readBoundedBytes(externalSbomPath, "The external CycloneDX SBOM"),
  ]);
  if (!embeddedManifest.equals(externalManifest)) {
    throw new Error("The embedded and external release manifest bytes differ.");
  }
  if (!embeddedSbom.equals(externalSbom)) {
    throw new Error("The embedded and external CycloneDX SBOM bytes differ.");
  }
  validateCycloneDxSbom(
    await readBoundedJson(embeddedSbomPath, "The embedded CycloneDX SBOM"),
    manifest,
  );
}

function parseVersionDocument(value: unknown): ReleaseIdentity {
  if (
    !isRecord(value)
    || value.name !== "replaycase"
    || typeof value.version !== "string"
    || !releaseVersionPattern.test(value.version)
    || typeof value.commit !== "string"
    || !commitPattern.test(value.commit)
    || containsSecretKey(value)
  ) {
    throw new Error("The artifact-local version command emitted an invalid identity document.");
  }
  return { version: value.version, commit: value.commit };
}

async function readCliIdentity(
  executablePath: string,
  workingDirectory: string,
  label: string,
): Promise<ReleaseIdentity> {
  const versionResult = await runProcess(
    executablePath,
    ["version", "--json"],
    {
      cwd: workingDirectory,
      env: childEnvironment(),
      ...(process.platform === "win32" ? { shell: true } : {}),
    },
  );
  if (versionResult.code !== 0) {
    throw new Error(
      `${label} failed (exit ${String(versionResult.code)}).`
      + `${versionResult.stdout ? `\nstdout:\n${versionResult.stdout}` : ""}`
      + `${versionResult.stderr ? `\nstderr:\n${versionResult.stderr}` : ""}`,
    );
  }
  let versionValue: unknown;
  try {
    versionValue = JSON.parse(versionResult.stdout) as unknown;
  } catch {
    throw new Error(`${label} did not emit JSON:\n${versionResult.stdout}`);
  }
  return parseVersionDocument(versionValue);
}

function npmInvocation(args: readonly string[]): { command: string; args: string[] } {
  const npmExecPath = process.env.npm_execpath?.trim();
  if (npmExecPath) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: [...args],
  };
}

async function installReleaseGlobally(
  archivePath: string,
  temporaryRoot: string,
  operatorWorkingDirectory: string,
  expectedIdentity: ReleaseIdentity,
): Promise<string> {
  const prefix = join(temporaryRoot, "global-prefix");
  const cache = join(temporaryRoot, "npm-cache");
  await Promise.all([
    mkdir(prefix, { recursive: true }),
    mkdir(cache, { recursive: true }),
  ]);
  const invocation = npmInvocation([
    "install",
    "--global",
    archivePath,
    "--ignore-scripts",
    "--prefix",
    prefix,
    "--cache",
    cache,
    "--offline",
    "--no-audit",
    "--no-fund",
  ]);
  const installation = await runProcess(
    invocation.command,
    invocation.args,
    {
      cwd: operatorWorkingDirectory,
      env: {
        ...childEnvironment(),
        npm_config_update_notifier: "false",
      },
    },
    60_000,
  );
  if (installation.code !== 0) {
    throw new Error(
      `The release could not be installed into an offline temporary global prefix (exit ${String(installation.code)}).`
      + `${installation.stdout ? `\nstdout:\n${installation.stdout}` : ""}`
      + `${installation.stderr ? `\nstderr:\n${installation.stderr}` : ""}`,
    );
  }

  const installedExecutable = process.platform === "win32"
    ? join(prefix, "replaycase.cmd")
    : join(prefix, "bin", "replaycase");
  await requireFile(installedExecutable, "the globally installed replaycase command");
  if (process.platform !== "win32") {
    await access(installedExecutable, fsConstants.X_OK);
  }
  const installedIdentity = await readCliIdentity(
    installedExecutable,
    operatorWorkingDirectory,
    "The globally installed version command",
  );
  if (
    installedIdentity.version !== expectedIdentity.version
    || installedIdentity.commit !== expectedIdentity.commit
  ) {
    throw new Error("The globally installed command identity does not match release-manifest.json.");
  }
  const legacyExecutable = process.platform === "win32"
    ? join(prefix, "narrowslink.cmd")
    : join(prefix, "bin", "narrowslink");
  const legacyIdentity = await readCliIdentity(legacyExecutable, operatorWorkingDirectory, "The legacy alias");
  if (legacyIdentity.version !== expectedIdentity.version || legacyIdentity.commit !== expectedIdentity.commit) {
    throw new Error("The legacy alias does not identify the installed ReplayCase release.");
  }
  return installedExecutable;
}

function parseReadyDocument(line: string): ReleaseReadyDocument | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(value)
    || value.type !== "narrowslink-serve-ready"
    || value.formatVersion !== 1
    || typeof value.version !== "string"
    || !releaseVersionPattern.test(value.version)
    || typeof value.commit !== "string"
    || !commitPattern.test(value.commit)
    || typeof value.appUrl !== "string"
    || typeof value.bridgeUrl !== "string"
    || !isRecord(value.udpDefaults)
    || value.udpDefaults.host !== "127.0.0.1"
    || !Number.isInteger(value.udpDefaults.port)
    || value.udpDefaults.port !== 0
    || value.udpDefaults.multicastGroup !== null
    || value.udpDefaults.multicastInterface !== null
  ) {
    return null;
  }
  if (containsSecretKey(value)) {
    throw new Error("The release readiness document exposed a credential or secret field.");
  }
  let appUrl: URL;
  let bridgeUrl: URL;
  try {
    appUrl = new URL(value.appUrl);
    bridgeUrl = new URL(value.bridgeUrl);
  } catch {
    throw new Error("The release readiness document contains an invalid URL.");
  }
  if (
    appUrl.protocol !== "http:"
    || appUrl.hostname !== "127.0.0.1"
    || appUrl.pathname !== "/"
    || appUrl.search !== ""
    || appUrl.hash !== ""
    || appUrl.port === ""
    || bridgeUrl.protocol !== "http:"
    || bridgeUrl.hostname !== "127.0.0.1"
    || bridgeUrl.pathname !== "/"
    || bridgeUrl.search !== ""
    || bridgeUrl.hash !== ""
    || bridgeUrl.port === ""
  ) {
    throw new Error("The release readiness document did not declare bounded loopback origins.");
  }
  return value as unknown as ReleaseReadyDocument;
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`Release process did not exit within ${timeoutMs} ms.`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    };
    child.once("exit", onExit);
  });
}

export function configuredReleaseArchive(): string {
  const configured = process.env.REPLAYCASE_RELEASE_ARCHIVE?.trim() || process.env.NARROWSLINK_RELEASE_ARCHIVE?.trim();
  if (!configured) {
    throw new Error(
      "REPLAYCASE_RELEASE_ARCHIVE must point to the built ReplayCase .tgz release.",
    );
  }
  return resolve(configured);
}

export async function unpackRelease(
  archivePath = configuredReleaseArchive(),
): Promise<ReleaseInstallation> {
  await requireFile(archivePath, "the configured release archive");
  if (!basename(archivePath).endsWith(".tgz")) {
    throw new Error(`REPLAYCASE_RELEASE_ARCHIVE must name a .tgz file: ${archivePath}`);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "replaycase-release-acceptance-"));
  const unpackedRoot = join(temporaryRoot, "unpacked");
  const operatorWorkingDirectory = join(temporaryRoot, "operator-cwd");
  await Promise.all([
    mkdir(unpackedRoot, { recursive: true }),
    mkdir(operatorWorkingDirectory, { recursive: true }),
  ]);

  try {
    const extraction = await runProcess("tar", ["-xzf", archivePath, "-C", unpackedRoot], {
      cwd: operatorWorkingDirectory,
    });
    if (extraction.code !== 0) {
      throw new Error(
        `Could not unpack ${archivePath} (exit ${String(extraction.code)}).`
        + `${extraction.stderr ? `\n${extraction.stderr}` : ""}`,
      );
    }

    const packageRoot = join(unpackedRoot, "package");
    const packagedExecutablePath = join(packageRoot, "bin", "replaycase.mjs");
    const appRoot = join(packageRoot, "app");
    const fixturePath = join(appRoot, "fixtures", "harbor-relay-session.json");
    await Promise.all([
      requireFile(packagedExecutablePath, "package/bin/replaycase.mjs"),
      requireFile(join(appRoot, "index.html"), "package/app/index.html"),
      requireFile(fixturePath, "the bundled replay fixture"),
      requireFile(join(packageRoot, "release-manifest.json"), "release-manifest.json"),
      requireFile(join(packageRoot, "SBOM.cdx.json"), "SBOM.cdx.json"),
      requireFile(join(packageRoot, "package.json"), "package.json"),
      access(packagedExecutablePath, fsConstants.X_OK),
    ]);

    const packageDocument = await readBoundedJson(
      join(packageRoot, "package.json"),
      "The unpacked release package.json",
    );
    if (!isRecord(packageDocument)) {
      throw new Error("The unpacked release package.json is not a JSON object.");
    }
    for (const dependencyField of ["dependencies", "devDependencies"] as const) {
      const dependencies = packageDocument[dependencyField];
      if (dependencies !== undefined && (!isRecord(dependencies) || Object.keys(dependencies).length > 0)) {
        throw new Error(`The unpacked release declares ${dependencyField}.`);
      }
    }

    const manifest = parseReleaseManifest(await readBoundedJson(
      join(packageRoot, "release-manifest.json"),
      "The unpacked release manifest",
    ));
    await reconcilePayload(packageRoot, manifest);
    await validatePublishedMetadata(archivePath, packageRoot, manifest);

    const packagedIdentity = await readCliIdentity(
      packagedExecutablePath,
      operatorWorkingDirectory,
      "The artifact-local version command",
    );
    if (
      packagedIdentity.version !== manifest.identity.version
      || packagedIdentity.commit !== manifest.identity.commit
    ) {
      throw new Error("The artifact-local version identity does not match release-manifest.json.");
    }
    const executablePath = await installReleaseGlobally(
      archivePath,
      temporaryRoot,
      operatorWorkingDirectory,
      manifest.identity,
    );

    let removed = false;
    return {
      temporaryRoot,
      packageRoot,
      executablePath,
      appRoot,
      fixturePath,
      operatorWorkingDirectory,
      identity: manifest.identity,
      async remove() {
        if (removed) return;
        removed = true;
        await rm(temporaryRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function startRelease(
  installation: ReleaseInstallation,
  appPort = 0,
): Promise<RunningRelease> {
  const args = [
    "serve",
    "--app-port",
    String(appPort),
    "--bridge-port",
    "0",
    "--udp-port",
    "0",
    "--no-open",
    "--json-ready",
  ];
  const child = spawn(installation.executablePath, args, {
    cwd: installation.operatorWorkingDirectory,
    env: childEnvironment(),
    stdio: "pipe",
  });

  let stdout = "";
  let stderr = "";
  let ready: ReleaseReadyDocument;
  try {
    ready = await new Promise<ReleaseReadyDocument>((resolveReady, reject) => {
      let pendingLine = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("error", onError);
        child.off("exit", onPrematureExit);
        callback();
      };
      const onError = (error: Error) => finish(() => reject(error));
      const onPrematureExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(() => reject(new Error(
          `Release server exited before readiness (code ${String(code)}, signal ${String(signal)}).`
          + `${stderr ? `\n${stderr}` : ""}`,
        )));
      };
      const timeout = setTimeout(() => {
        finish(() => reject(new Error(
          `Release server did not emit a valid readiness document within ${READY_TIMEOUT_MS} ms.`
          + `${stdout ? `\nstdout:\n${stdout}` : ""}`
          + `${stderr ? `\nstderr:\n${stderr}` : ""}`,
        )));
      }, READY_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = boundedAppend(stdout, chunk);
        pendingLine = boundedAppend(pendingLine, chunk);
        const lines = pendingLine.split(/\r?\n/);
        pendingLine = lines.pop() ?? "";
        for (const line of lines) {
          let parsed: ReleaseReadyDocument | null;
          try {
            parsed = parseReadyDocument(line.trim());
          } catch (error) {
            finish(() => reject(error));
            return;
          }
          if (parsed) {
            finish(() => resolveReady(parsed));
            return;
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = boundedAppend(stderr, chunk);
      });
      child.once("error", onError);
      child.once("exit", onPrematureExit);
    });
    if (
      ready.version !== installation.identity.version
      || ready.commit !== installation.identity.commit
    ) {
      throw new Error("The live readiness identity does not match the unpacked release manifest.");
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForExit(child, EXIT_TIMEOUT_MS).catch(() => {
      child.kill("SIGKILL");
    });
    throw error;
  }

  let stopped = false;
  return {
    ready,
    executablePath: installation.executablePath,
    operatorWorkingDirectory: installation.operatorWorkingDirectory,
    async stop() {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
      let exit;
      try {
        exit = await waitForExit(child, EXIT_TIMEOUT_MS);
      } catch (error) {
        child.kill("SIGKILL");
        await waitForExit(child, 2_000).catch(() => undefined);
        throw error;
      }
      if (exit.code !== 0) {
        throw new Error(
          `Release server did not shut down cleanly (code ${String(exit.code)}, signal ${String(exit.signal)}).`
          + `${stderr ? `\n${stderr}` : ""}`,
        );
      }
    },
  };
}

export async function verifyBundleWithRelease(
  installation: ReleaseInstallation,
  bundlePath: string,
): Promise<VerificationReport> {
  await requireFile(bundlePath, "the downloaded evidence bundle");
  const verification = await runProcess(
    installation.executablePath,
    ["verify", bundlePath, "--json"],
    {
      cwd: installation.operatorWorkingDirectory,
      env: childEnvironment(),
    },
  );
  if (verification.code !== 0) {
    throw new Error(
      `Artifact-local verification failed (exit ${String(verification.code)}).`
      + `${verification.stdout ? `\nstdout:\n${verification.stdout}` : ""}`
      + `${verification.stderr ? `\nstderr:\n${verification.stderr}` : ""}`,
    );
  }
  let report: unknown;
  try {
    report = JSON.parse(verification.stdout) as unknown;
  } catch {
    throw new Error(`Artifact-local verification did not emit JSON:\n${verification.stdout}`);
  }
  if (
    !isRecord(report)
    || typeof report.integrity !== "string"
    || typeof report.evidence !== "string"
    || typeof report.captureEvidence !== "string"
    || typeof report.provenanceEvidence !== "string"
    || typeof report.authenticity !== "string"
    || !isRecord(report.bundle)
    || typeof report.bundle.sha256 !== "string"
    || typeof report.bundle.bytes !== "number"
    || !isRecord(report.session)
    || typeof report.session.id !== "string"
    || typeof report.session.title !== "string"
    || !isRecord(report.selection)
    || typeof report.selection.startUs !== "number"
    || typeof report.selection.endUs !== "number"
    || !isRecord(report.artifacts)
    || typeof report.artifacts.count !== "number"
    || !Array.isArray(report.warnings)
    || !report.warnings.every((warning) => typeof warning === "string")
  ) {
    throw new Error("Artifact-local verification emitted an invalid report schema.");
  }
  return report as unknown as VerificationReport;
}
