import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createSocket } from "node:dgram";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BRIDGE_SCRIPT = join(REPOSITORY_ROOT, "scripts", "capture-bridge.mjs");
const FIXTURE_PATH = join(REPOSITORY_ROOT, "public", "fixtures", "harbor-relay-session.json");
const DEFAULT_TOKEN = "replaycase-playwright-loopback-token";

interface BridgeReadyMessage {
  type: "narrowslink-bridge-ready";
  controlUrl: string;
}

export interface BridgeCaptureStatus {
  id: string;
  startedAt: string;
  endedAt?: string;
  datagrams: number;
  bytes: number;
  durationUs: number;
}

export interface BridgeCaptureJournalEntry {
  sequence: number;
  type: "capture-started" | "bridge-error" | "subscriber-backpressure" | "capture-stopped";
  at: string;
  offsetUs: number;
  datagrams: number;
  bytes: number;
  code?: string;
  message?: string;
  fatal?: boolean;
}

export interface BridgeCaptureJournal {
  captureId: string;
  startedAt: string;
  endedAt: string | null;
  state: "active" | "clean" | "incomplete";
  bind: {
    requestedHost: string;
    requestedPort: number;
    host: string;
    port: number;
    family: "IPv4" | "IPv6";
  };
  multicast: {
    group: string;
    interface: string | null;
    family: "IPv4" | "IPv6";
  } | null;
  datagrams: number;
  bytes: number;
  kernelDroppedDatagrams: number | null;
  kernelDroppedDatagramsSource:
    | "linux-proc-net-udp-socket"
    | "unavailable"
    | "unavailable-capture-active"
    | "unavailable-unsupported-platform"
    | "unavailable-procfs"
    | "unavailable-socket-identity"
    | "unavailable-counter-regression";
  entriesComplete: boolean;
  omittedEntries: number;
  entries: BridgeCaptureJournalEntry[];
}

export interface BridgeStatus {
  state: "idle" | "starting" | "capturing" | "stopping" | "stopped" | "error";
  udp: { host: string; port: number; family?: "IPv4" | "IPv6" } | null;
  capture: BridgeCaptureStatus | null;
  captureJournal: BridgeCaptureJournal | null;
}

export interface SentFixtureDatagram {
  dataHex: string;
  byteLength: number;
}

export interface LoopbackBridge {
  readonly controlUrl: string;
  readonly token: string;
  status(): Promise<BridgeStatus>;
  waitForStatus(
    predicate: (status: BridgeStatus) => boolean,
    options?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<BridgeStatus>;
  sendFixtureDatagrams(options: {
    count: number;
    startIndex?: number;
    intervalMs?: number;
  }): Promise<SentFixtureDatagram[]>;
  sendDatagrams(dataHex: readonly string[], options?: { intervalMs?: number }): Promise<SentFixtureDatagram[]>;
  close(): Promise<void>;
}

interface FixtureDocument {
  records?: Array<{ dataHex?: unknown }>;
}

function parseReadyMessage(line: string): BridgeReadyMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (
    typeof value !== "object"
    || value === null
    || !("type" in value)
    || value.type !== "narrowslink-bridge-ready"
    || !("controlUrl" in value)
    || typeof value.controlUrl !== "string"
  ) {
    return null;
  }
  return { type: "narrowslink-bridge-ready", controlUrl: value.controlUrl };
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`Loopback bridge did not exit within ${timeoutMs} ms.`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, 5_000);
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, 2_000);
  }
}

function validStatus(value: unknown): value is BridgeStatus {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BridgeStatus>;
  const journal = candidate.captureJournal;
  const kernelDropSources = new Set([
    "linux-proc-net-udp-socket",
    "unavailable",
    "unavailable-capture-active",
    "unavailable-unsupported-platform",
    "unavailable-procfs",
    "unavailable-socket-identity",
    "unavailable-counter-regression",
  ]);
  const kernelDropEvidenceValid = journal === null || journal === undefined || (
    kernelDropSources.has(journal.kernelDroppedDatagramsSource)
    && (journal.kernelDroppedDatagramsSource === "linux-proc-net-udp-socket"
      ? Number.isSafeInteger(journal.kernelDroppedDatagrams) && (journal.kernelDroppedDatagrams ?? -1) >= 0
      : journal.kernelDroppedDatagrams === null)
  );
  return typeof candidate.state === "string"
    && (candidate.udp === null || (
      typeof candidate.udp === "object"
      && candidate.udp !== null
      && typeof candidate.udp.host === "string"
      && Number.isInteger(candidate.udp.port)
    ))
    && (candidate.capture === null || (
      typeof candidate.capture === "object"
      && candidate.capture !== null
      && typeof candidate.capture.id === "string"
      && Number.isInteger(candidate.capture.datagrams)
      && Number.isInteger(candidate.capture.bytes)
      && Number.isInteger(candidate.capture.durationUs)
    ))
    && (candidate.captureJournal === null || (
      typeof candidate.captureJournal === "object"
      && candidate.captureJournal !== null
      && typeof candidate.captureJournal.captureId === "string"
      && typeof candidate.captureJournal.state === "string"
      && Number.isInteger(candidate.captureJournal.datagrams)
      && Number.isInteger(candidate.captureJournal.bytes)
      && kernelDropEvidenceValid
      && Array.isArray(candidate.captureJournal.entries)
    ));
}

async function sendDatagram(
  socket: ReturnType<typeof createSocket>,
  bytes: Buffer,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(bytes, port, "127.0.0.1", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function startLoopbackBridge(token = DEFAULT_TOKEN): Promise<LoopbackBridge> {
  const child = spawn(
    process.execPath,
    [
      BRIDGE_SCRIPT,
      "--control-port",
      "0",
      "--udp-host",
      "127.0.0.1",
      "--udp-port",
      "0",
      "--token",
      token,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env },
      stdio: "pipe",
    },
  );

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });

  const ready = await new Promise<BridgeReadyMessage>((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      callback();
    };
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        const message = parseReadyMessage(line.trim());
        if (message) {
          finish(() => resolve(message));
          return;
        }
      }
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() => reject(new Error(
        `Loopback bridge exited before readiness (code ${String(code)}, signal ${String(signal)}).${stderr ? `\n${stderr}` : ""}`,
      )));
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Loopback bridge did not become ready.${stderr ? `\n${stderr}` : ""}`)));
    }, 10_000);
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  }).catch(async (error: unknown) => {
    await stopChild(child).catch(() => undefined);
    throw error;
  });

  let closed = false;
  const status = async (): Promise<BridgeStatus> => {
    const response = await fetch(new URL("/v1/status", ready.controlUrl), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4_000),
    });
    const value = await response.json() as unknown;
    if (!response.ok || !validStatus(value)) {
      throw new Error(`Loopback bridge returned an invalid status (${response.status}).`);
    }
    return value;
  };

  const sendHexDatagrams = async (
    dataHex: readonly string[],
    intervalMs: number,
  ): Promise<SentFixtureDatagram[]> => {
    const bridgeStatus = await status();
    const port = bridgeStatus.udp?.port;
    if (bridgeStatus.state !== "capturing" || port == null || port <= 0) {
      throw new Error("Loopback bridge does not have an active UDP socket.");
    }
    const datagrams = dataHex.map((value, index) => {
      if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) {
        throw new Error(`Datagram ${index} has invalid hexadecimal bytes.`);
      }
      return { dataHex: value.toLowerCase(), byteLength: value.length / 2 };
    });
    const socket = createSocket("udp4");
    try {
      for (const [index, datagram] of datagrams.entries()) {
        await sendDatagram(socket, Buffer.from(datagram.dataHex, "hex"), port);
        if (index + 1 < datagrams.length && intervalMs > 0) await delay(intervalMs);
      }
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
    return datagrams;
  };

  return {
    controlUrl: ready.controlUrl,
    token,
    status,
    async waitForStatus(predicate, options = {}) {
      const timeoutMs = options.timeoutMs ?? 8_000;
      const intervalMs = options.intervalMs ?? 25;
      const deadline = Date.now() + timeoutMs;
      let lastStatus: BridgeStatus | null = null;
      let lastError: unknown;
      while (Date.now() <= deadline) {
        try {
          lastStatus = await status();
          if (predicate(lastStatus)) return lastStatus;
        } catch (error) {
          lastError = error;
        }
        await delay(intervalMs);
      }
      const detail = lastStatus ? JSON.stringify(lastStatus) : String(lastError ?? "no status received");
      throw new Error(`Loopback bridge did not reach the expected status: ${detail}`);
    },
    async sendFixtureDatagrams(options) {
      const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as FixtureDocument;
      if (!Array.isArray(fixture.records)) throw new Error("Bundled fixture records are unavailable.");
      const startIndex = options.startIndex ?? 0;
      const selected = fixture.records.slice(startIndex, startIndex + options.count);
      if (selected.length !== options.count) {
        throw new Error(`Fixture contains only ${selected.length} of ${options.count} requested records.`);
      }
      const dataHex = selected.map((record, index) => {
        if (typeof record.dataHex !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(record.dataHex)) {
          throw new Error(`Fixture record ${startIndex + index} has invalid hexadecimal bytes.`);
        }
        return record.dataHex;
      });
      return sendHexDatagrams(dataHex, options.intervalMs ?? 8);
    },
    async sendDatagrams(dataHex, options = {}) {
      if (dataHex.length === 0) throw new Error("At least one datagram is required.");
      return sendHexDatagrams(dataHex, options.intervalMs ?? 8);
    },
    async close() {
      if (closed) return;
      closed = true;
      await stopChild(child);
    },
  };
}
