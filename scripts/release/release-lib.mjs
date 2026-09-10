import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OPERATOR_README_TEMPLATE = join(
  REPOSITORY_ROOT,
  "scripts",
  "release",
  "templates",
  "README.md",
);
const RELEASE_MANIFEST_FORMAT = "replaycase/release-manifest";
const RELEASE_MANIFEST_VERSION = 1;
const SOURCE_REPOSITORY = "https://github.com/zrack/replaycase";
const MANIFEST_SELF_PATH = "release-manifest.json";
const CLI_PATHS = new Set(["bin/replaycase.mjs", "bin/narrowslink.mjs"]);

function fail(message) {
  throw new Error(message);
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    fail(`${commandName} ${args.join(" ")} failed with exit ${String(result.status)}${detail ? `:\n${detail}` : "."}`);
  }
  return result.stdout.trim();
}

function npmCommand(args, options = {}) {
  if (process.env.npm_execpath) {
    return command(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return command(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

function git(args) {
  return command("git", args, { cwd: REPOSITORY_ROOT });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path));
}

function uuidV5(name) {
  const dnsNamespace = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
  const digest = createHash("sha1")
    .update(dnsNamespace)
    .update(Buffer.from(name, "utf8"))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), "en");
}

function sortProperties(value) {
  if (!Array.isArray(value)) return value;
  return [...value].sort((left, right) => compareText(
    `${left?.name ?? ""}\u0000${left?.value ?? ""}`,
    `${right?.name ?? ""}\u0000${right?.value ?? ""}`,
  ));
}

export function assertCycloneDxReferences(document) {
  const rootReference = document?.metadata?.component?.["bom-ref"];
  if (typeof rootReference !== "string" || rootReference.length === 0) {
    fail("CycloneDX metadata.component is missing a bounded bom-ref.");
  }
  if (!Array.isArray(document.components) || !Array.isArray(document.dependencies)) {
    fail("CycloneDX components and dependencies must be arrays.");
  }

  const componentReferences = new Set([rootReference]);
  for (const component of document.components) {
    const reference = component?.["bom-ref"];
    if (typeof reference !== "string" || reference.length === 0) {
      fail("CycloneDX component is missing a bounded bom-ref.");
    }
    if (componentReferences.has(reference)) {
      fail(`CycloneDX component bom-ref is duplicated: ${reference}.`);
    }
    componentReferences.add(reference);
  }

  const dependencyReferences = new Set();
  for (const dependency of document.dependencies) {
    const reference = dependency?.ref;
    if (typeof reference !== "string" || !componentReferences.has(reference)) {
      fail(`CycloneDX dependency ref does not resolve to a component: ${String(reference)}.`);
    }
    if (dependencyReferences.has(reference)) {
      fail(`CycloneDX dependency ref is duplicated: ${reference}.`);
    }
    dependencyReferences.add(reference);
    if (!Array.isArray(dependency.dependsOn)) {
      fail(`CycloneDX dependency ${reference} does not declare a dependsOn array.`);
    }
    for (const target of dependency.dependsOn) {
      if (typeof target !== "string" || !componentReferences.has(target)) {
        fail(`CycloneDX dependency target does not resolve to a component: ${String(target)}.`);
      }
    }
  }
  if (!dependencyReferences.has(rootReference)) {
    fail(`CycloneDX dependency graph does not contain the root component ${rootReference}.`);
  }
}

export function normalizeCycloneDx(raw, identity) {
  if (
    raw?.bomFormat !== "CycloneDX"
    || typeof raw?.metadata !== "object"
    || raw.metadata === null
    || typeof raw.metadata.component?.["bom-ref"] !== "string"
  ) {
    fail("npm sbom did not return a CycloneDX document.");
  }

  const originalRootReference = raw.metadata.component["bom-ref"];
  const purl = `pkg:npm/replaycase@${identity.version}`;
  const component = {
    ...(raw.metadata.component ?? {}),
    "bom-ref": purl,
    type: "application",
    name: "replaycase",
    version: identity.version,
    purl,
    properties: sortProperties([
      ...((raw.metadata.component?.properties ?? []).filter(
        (property) => property?.name !== "replaycase:distribution"
          && property?.name !== "replaycase:source-commit",
      )),
      { name: "replaycase:distribution", value: "bundled" },
      { name: "replaycase:source-commit", value: identity.commit },
    ]),
  };

  const components = [...(raw.components ?? [])]
    .map((entry) => ({
      ...entry,
      ...(entry.properties ? { properties: sortProperties(entry.properties) } : {}),
      ...(entry.externalReferences
        ? {
            externalReferences: [...entry.externalReferences].sort((left, right) => compareText(
              `${left?.type ?? ""}\u0000${left?.url ?? ""}`,
              `${right?.type ?? ""}\u0000${right?.url ?? ""}`,
            )),
          }
        : {}),
    }))
    .sort((left, right) => compareText(
      left?.["bom-ref"] ?? left?.purl ?? `${left?.name ?? ""}@${left?.version ?? ""}`,
      right?.["bom-ref"] ?? right?.purl ?? `${right?.name ?? ""}@${right?.version ?? ""}`,
    ));

  const dependencies = [...(raw.dependencies ?? [])]
    .map((entry) => ({
      ...entry,
      ref: entry.ref === originalRootReference ? purl : entry.ref,
      dependsOn: [...(entry.dependsOn ?? [])]
        .map((reference) => reference === originalRootReference ? purl : reference)
        .sort(compareText),
    }))
    .sort((left, right) => compareText(left?.ref ?? "", right?.ref ?? ""));

  const normalized = {
    ...raw,
    serialNumber: `urn:uuid:${uuidV5(`replaycase:${identity.version}:${identity.commit}`)}`,
    version: 1,
    metadata: {
      ...raw.metadata,
      timestamp: new Date(identity.sourceDateEpoch * 1_000).toISOString(),
      component,
      tools: [...(raw.metadata.tools ?? [])].sort((left, right) => compareText(
        `${left?.vendor ?? ""}\u0000${left?.name ?? ""}\u0000${left?.version ?? ""}`,
        `${right?.vendor ?? ""}\u0000${right?.name ?? ""}\u0000${right?.version ?? ""}`,
      )),
    },
    components,
    dependencies,
  };
  assertCycloneDxReferences(normalized);
  return normalized;
}

async function generateSbom(identity) {
  const output = npmCommand(
    [
      "sbom",
      "--omit=dev",
      "--package-lock-only",
      "--sbom-format=cyclonedx",
      "--sbom-type=application",
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        LANG: "C",
        LC_ALL: "C",
        SOURCE_DATE_EPOCH: String(identity.sourceDateEpoch),
        TZ: "UTC",
      },
    },
  );
  return normalizeCycloneDx(JSON.parse(output), identity);
}

async function assertRegularTree(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const currentStat = await lstat(current);
    if (currentStat.isSymbolicLink()) fail(`Release input may not contain symbolic links: ${current}`);
    if (currentStat.isDirectory()) {
      for (const name of await readdir(current)) pending.push(join(current, name));
    } else if (!currentStat.isFile()) {
      fail(`Release input must contain only regular files and directories: ${current}`);
    }
  }
}

async function collectFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const names = (await readdir(current)).sort(compareText);
    for (const name of names) {
      const path = join(current, name);
      const pathStat = await lstat(path);
      if (pathStat.isSymbolicLink()) fail(`Release package may not contain symbolic links: ${path}`);
      if (pathStat.isDirectory()) pending.push(path);
      else if (pathStat.isFile()) files.push(path);
      else fail(`Release package contains an unsupported filesystem entry: ${path}`);
    }
  }
  return files.sort((left, right) => compareText(relative(root, left), relative(root, right)));
}

function portablePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function normalizeFilesystem(root, sourceDateEpoch) {
  const timestamp = new Date(sourceDateEpoch * 1_000);
  const visit = async (path) => {
    const pathStat = await lstat(path);
    if (pathStat.isDirectory()) {
      const names = (await readdir(path)).sort(compareText);
      for (const name of names) await visit(join(path, name));
      await chmod(path, 0o755);
    } else {
      await chmod(path, CLI_PATHS.has(portablePath(root, path)) ? 0o755 : 0o644);
    }
    await utimes(path, timestamp, timestamp);
  };
  await visit(root);
}

async function payloadFiles(stagingRoot) {
  const entries = [];
  for (const path of await collectFiles(stagingRoot)) {
    const relativePath = portablePath(stagingRoot, path);
    if (relativePath === MANIFEST_SELF_PATH) continue;
    const pathStat = await stat(path);
    entries.push({
      path: relativePath,
      bytes: pathStat.size,
      mode: CLI_PATHS.has(relativePath) ? "0755" : "0644",
      sha256: await sha256File(path),
    });
  }
  return entries.sort((left, right) => compareText(left.path, right.path));
}

function toolVersion(lockfile, packageName) {
  return lockfile.packages?.[`node_modules/${packageName}`]?.version ?? null;
}

export function isAnnotatedTagAtHead(tagVerified, tagObjectType) {
  return tagVerified === true && tagObjectType === "tag";
}

export async function inspectReleaseIdentity({ strict = false } = {}) {
  const packageJson = await readJson(join(REPOSITORY_ROOT, "package.json"));
  const packageLock = await readJson(join(REPOSITORY_ROOT, "package-lock.json"));
  const version = packageJson.version;
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`package.json version is not a supported semantic version: ${String(version)}`);
  }
  if (packageLock.name !== packageJson.name || packageLock.version !== version) {
    fail("package-lock.json root name/version does not match package.json.");
  }

  const commit = git(["rev-parse", "HEAD"]);
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  const sourceDateEpoch = Number(git(["show", "-s", "--format=%ct", "HEAD"]));
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0) {
    fail("Git did not return a valid commit timestamp.");
  }
  if (
    process.env.SOURCE_DATE_EPOCH
    && Number(process.env.SOURCE_DATE_EPOCH) !== sourceDateEpoch
  ) {
    fail(`SOURCE_DATE_EPOCH must equal the Git commit timestamp ${sourceDateEpoch}.`);
  }

  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const dirty = status.length > 0;
  const expectedTag = `v${version}`;
  const tags = git(["tag", "--points-at", "HEAD"]).split(/\r?\n/).filter(Boolean);
  const tagVerified = tags.includes(expectedTag);
  const tagObjectType = git([
    "for-each-ref",
    "--format=%(objecttype)",
    `refs/tags/${expectedTag}`,
  ]);
  const tagAnnotated = isAnnotatedTagAtHead(tagVerified, tagObjectType);
  if (strict && dirty) fail("Strict release mode requires a clean Git worktree.");
  if (strict && !tagVerified) {
    fail(`Strict release mode requires ${expectedTag} to point at HEAD.`);
  }
  if (strict && !tagAnnotated) {
    fail(`Strict release mode requires ${expectedTag} to be an annotated Git tag object.`);
  }
  if (strict && process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== expectedTag) {
    fail(`GitHub tag ${process.env.GITHUB_REF_NAME} does not match package version tag ${expectedTag}.`);
  }

  return {
    version,
    commit,
    tree,
    tag: expectedTag,
    tagVerified,
    tagAnnotated,
    sourceDateEpoch,
    dirty,
    mode: strict ? "release" : "preview",
    buildId: `${version}+g${commit.slice(0, 12)}${dirty ? ".dirty" : ""}`,
    packageLockSha256: await sha256File(join(REPOSITORY_ROOT, "package-lock.json")),
    toolchain: {
      node: process.versions.node,
      npm: npmCommand(["--version"], { cwd: REPOSITORY_ROOT }),
      vite: toolVersion(packageLock, "vite"),
      typescript: toolVersion(packageLock, "typescript"),
    },
    runtimeNode: packageJson.engines?.node ?? ">=20.19",
  };
}

function releaseManifest(identity, files) {
  return {
    format: RELEASE_MANIFEST_FORMAT,
    formatVersion: RELEASE_MANIFEST_VERSION,
    product: "ReplayCase",
    packageName: "replaycase",
    version: identity.version,
    tag: identity.tag,
    commit: identity.commit,
    tree: identity.tree,
    sourceDateEpoch: identity.sourceDateEpoch,
    buildId: identity.buildId,
    mode: identity.mode,
    dirty: identity.dirty,
    tagVerified: identity.tagVerified,
    tagAnnotated: identity.tagAnnotated,
    source: {
      repository: SOURCE_REPOSITORY,
      commit: identity.commit,
      tree: identity.tree,
      tag: identity.tag,
      tagAnnotated: identity.tagAnnotated,
      sourceDateEpoch: identity.sourceDateEpoch,
      dirty: identity.dirty,
    },
    toolchain: identity.toolchain,
    runtime: {
      node: identity.runtimeNode,
      npmDependencies: 0,
      networkRequired: false,
    },
    inputs: {
      packageLock: {
        path: "package-lock.json",
        sha256: identity.packageLockSha256,
      },
    },
    payload: {
      root: "package",
      hashAlgorithm: "sha256",
      excludes: [MANIFEST_SELF_PATH],
      files,
    },
  };
}

async function renderOperatorReadme(identity) {
  const template = await readFile(OPERATOR_README_TEMPLATE, "utf8");
  return template
    .replaceAll("{{VERSION}}", identity.version)
    .replaceAll("{{TAG}}", identity.tag)
    .replaceAll("{{COMMIT}}", identity.commit);
}

function minimalPackageJson(identity) {
  return {
    name: "replaycase",
    version: identity.version,
    private: true,
    description: "Local-first telemetry capture, replay, incident investigation, and evidence verification.",
    license: "MIT",
    type: "module",
    bin: {
      replaycase: "bin/replaycase.mjs",
      narrowslink: "bin/narrowslink.mjs",
    },
    engines: {
      node: identity.runtimeNode,
    },
    files: [
      "app",
      "bin/replaycase.mjs",
      "bin/narrowslink.mjs",
      "LICENSE",
      "README.md",
      "release-manifest.json",
      "SBOM.cdx.json",
    ],
  };
}

function validatePackedFiles(packResult) {
  if (!Array.isArray(packResult?.files) || packResult.files.length === 0) {
    fail("npm pack did not report its package contents.");
  }
  const allowedExact = new Set([
    "LICENSE",
    "README.md",
    "SBOM.cdx.json",
    "bin/replaycase.mjs",
    "bin/narrowslink.mjs",
    "package.json",
    "release-manifest.json",
  ]);
  const unexpected = packResult.files
    .map((entry) => entry.path)
    .filter((path) => !allowedExact.has(path) && !path.startsWith("app/"));
  if (unexpected.length > 0) {
    fail(`npm pack included files outside the release whitelist: ${unexpected.join(", ")}`);
  }
  for (const required of allowedExact) {
    if (!packResult.files.some((entry) => entry.path === required)) {
      fail(`npm pack omitted required release file ${required}.`);
    }
  }
}

async function buildReleaseOnce(identity, outputRoot, stagingRoot) {
  const buildRoot = join(dirname(stagingRoot), "compiled");
  const appBuild = join(buildRoot, "app");
  const cliOutput = join(buildRoot, "cli");
  const cliBuild = join(cliOutput, "replaycase.mjs");
  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  npmCommand(
    ["run", "build"],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        LANG: "C",
        LC_ALL: "C",
        REPLAYCASE_APP_OUT_DIR: appBuild,
        REPLAYCASE_BUILD_COMMIT: identity.commit,
        REPLAYCASE_BUILD_VERSION: identity.version,
        REPLAYCASE_CLI_OUT_DIR: cliOutput,
        SOURCE_DATE_EPOCH: String(identity.sourceDateEpoch),
        TZ: "UTC",
      },
    },
  );
  await assertRegularTree(appBuild).catch((error) => {
    fail(`Production app build is unavailable or invalid at ${appBuild}: ${error.message}`);
  });
  const cliStat = await lstat(cliBuild).catch(() => null);
  if (!cliStat?.isFile() || cliStat.isSymbolicLink()) {
    fail(`Production CLI build is unavailable or invalid at ${cliBuild}.`);
  }
  const cliText = await readFile(cliBuild, "utf8");
  if (!cliText.startsWith("#!/usr/bin/env node\n")) {
    fail("Production CLI build is missing its Node shebang.");
  }
  if (!cliText.includes(identity.version) || !cliText.includes(identity.commit)) {
    fail("Production CLI build does not contain the requested version and commit identity.");
  }

  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(join(stagingRoot, "bin"), { recursive: true });
  await cp(appBuild, join(stagingRoot, "app"), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  await copyFile(cliBuild, join(stagingRoot, "bin", "replaycase.mjs"));
  await copyFile(join(cliOutput, "narrowslink.mjs"), join(stagingRoot, "bin", "narrowslink.mjs"));
  await copyFile(join(REPOSITORY_ROOT, "LICENSE"), join(stagingRoot, "LICENSE"));
  await writeFile(join(stagingRoot, "README.md"), await renderOperatorReadme(identity), "utf8");
  await writeFile(join(stagingRoot, "package.json"), stableJson(minimalPackageJson(identity)), "utf8");
  await writeFile(join(stagingRoot, "SBOM.cdx.json"), stableJson(await generateSbom(identity)), "utf8");

  await normalizeFilesystem(stagingRoot, identity.sourceDateEpoch);
  const files = await payloadFiles(stagingRoot);
  const manifest = releaseManifest(identity, files);
  await writeFile(join(stagingRoot, MANIFEST_SELF_PATH), stableJson(manifest), "utf8");
  await normalizeFilesystem(stagingRoot, identity.sourceDateEpoch);

  await mkdir(outputRoot, { recursive: true });
  const packOutput = npmCommand(
    [
      "pack",
      stagingRoot,
      "--pack-destination",
      outputRoot,
      "--json",
      "--ignore-scripts",
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        LANG: "C",
        LC_ALL: "C",
        SOURCE_DATE_EPOCH: String(identity.sourceDateEpoch),
        TZ: "UTC",
      },
    },
  );
  const [packResult] = JSON.parse(packOutput);
  validatePackedFiles(packResult);
  const archiveName = `replaycase-${identity.version}.tgz`;
  if (packResult.filename !== archiveName) {
    fail(`npm pack produced ${String(packResult.filename)} instead of ${archiveName}.`);
  }
  const archivePath = join(outputRoot, archiveName);
  const externalManifestName = `replaycase-${identity.version}.release.json`;
  const externalSbomName = `replaycase-${identity.version}.cdx.json`;
  await copyFile(join(stagingRoot, MANIFEST_SELF_PATH), join(outputRoot, externalManifestName));
  await copyFile(join(stagingRoot, "SBOM.cdx.json"), join(outputRoot, externalSbomName));

  const hashedNames = [archiveName, externalManifestName, externalSbomName].sort(compareText);
  const checksumLines = [];
  for (const name of hashedNames) {
    checksumLines.push(`${await sha256File(join(outputRoot, name))}  ${name}`);
  }
  await writeFile(join(outputRoot, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, "utf8");
  await chmod(join(outputRoot, "SHA256SUMS"), 0o644);

  return {
    archiveName,
    externalManifestName,
    externalSbomName,
    publicFiles: [...hashedNames, "SHA256SUMS"].sort(compareText),
  };
}

async function assertIdenticalBuilds(firstRoot, secondRoot, names) {
  const comparisons = [];
  for (const name of names) {
    const firstHash = await sha256File(join(firstRoot, name));
    const secondHash = await sha256File(join(secondRoot, name));
    if (firstHash !== secondHash) {
      fail(`Release reproducibility failed for ${name}: ${firstHash} != ${secondHash}.`);
    }
    comparisons.push({ name, sha256: firstHash });
  }
  return comparisons;
}

export async function buildReproducibleRelease({
  outputRoot = join(REPOSITORY_ROOT, "build", "release"),
  strict = false,
} = {}) {
  const resolvedOutputRoot = resolve(REPOSITORY_ROOT, outputRoot);
  const identity = await inspectReleaseIdentity({ strict });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "replaycase-release-"));
  try {
    const firstOutput = join(temporaryRoot, "build-a", "output");
    const secondOutput = join(temporaryRoot, "build-b", "output");
    const first = await buildReleaseOnce(
      identity,
      firstOutput,
      join(temporaryRoot, "build-a", "stage"),
    );
    const second = await buildReleaseOnce(
      identity,
      secondOutput,
      join(temporaryRoot, "build-b", "stage"),
    );
    if (first.publicFiles.join("\n") !== second.publicFiles.join("\n")) {
      fail("Independent release builds produced different public file sets.");
    }
    const reproducibility = await assertIdenticalBuilds(
      firstOutput,
      secondOutput,
      first.publicFiles,
    );

    await mkdir(resolvedOutputRoot, { recursive: true });
    for (const name of first.publicFiles) {
      await copyFile(join(firstOutput, name), join(resolvedOutputRoot, name));
      await chmod(join(resolvedOutputRoot, name), 0o644);
    }

    return {
      format: "replaycase/release-build-result",
      formatVersion: 1,
      outputRoot: resolvedOutputRoot,
      archive: join(resolvedOutputRoot, first.archiveName),
      version: identity.version,
      tag: identity.tag,
      commit: identity.commit,
      tree: identity.tree,
      sourceDateEpoch: identity.sourceDateEpoch,
      strict,
      dirty: identity.dirty,
      tagVerified: identity.tagVerified,
      tagAnnotated: identity.tagAnnotated,
      reproducibility,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function parseBuildArguments(argv) {
  const options = {
    outputRoot: join(REPOSITORY_ROOT, "build", "release"),
    strict: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict") {
      options.strict = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("--output requires a directory path.");
      options.outputRoot = resolve(REPOSITORY_ROOT, value);
      index += 1;
      continue;
    }
    fail(`Unknown release-build argument: ${argument}`);
  }
  return options;
}

export function buildUsage() {
  return [
    "Usage: node scripts/release/build-release.mjs [--strict] [--output <directory>]",
    "",
    "Builds the ReplayCase operator package twice from distinct staging paths,",
    "requires byte-identical release assets, and copies the verified assets to",
    "the output directory. --strict additionally requires a clean worktree and",
    "an exact v<package-version> Git tag at HEAD.",
    "",
  ].join("\n");
}
