import { normalizeUdpBridgeUrl } from "../capture/udp-bridge";

export const OPERATOR_RUNTIME_PATH = "/replaycase-runtime.json";
export const OPERATOR_RUNTIME_FORMAT = "narrowslink/operator-runtime" as const;
export const OPERATOR_RUNTIME_FORMAT_VERSION = 1 as const;

export interface ManagedOperatorRuntime {
  readonly mode: "managed";
  readonly format: typeof OPERATOR_RUNTIME_FORMAT;
  readonly formatVersion: typeof OPERATOR_RUNTIME_FORMAT_VERSION;
  readonly controlUrl: string;
  readonly version: string;
  readonly commit: string;
  readonly defaults: {
    readonly host: string;
    readonly port: number;
    readonly multicastGroup: string | null;
    readonly multicastInterface: string | null;
  };
}

export interface ManualOperatorRuntime {
  readonly mode: "manual";
}

export interface InvalidOperatorRuntime {
  readonly mode: "invalid";
  readonly message: string;
}

export type OperatorRuntime = ManagedOperatorRuntime | ManualOperatorRuntime | InvalidOperatorRuntime;

export const MANUAL_OPERATOR_RUNTIME: ManualOperatorRuntime = Object.freeze({ mode: "manual" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  maximumLength: number,
): string {
  const value = record[key];
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${key} is missing or invalid`);
  }
  return value;
}

function nullableString(
  record: Record<string, unknown>,
  key: string,
  maximumLength: number,
): string | null {
  const value = record[key];
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${key} is invalid`);
  }
  return value;
}

function parseManagedOperatorRuntime(value: unknown): ManagedOperatorRuntime {
  if (!isRecord(value)) throw new Error("the response is not an object");
  if (value.format !== OPERATOR_RUNTIME_FORMAT || value.formatVersion !== OPERATOR_RUNTIME_FORMAT_VERSION) {
    throw new Error("the format version is unsupported");
  }
  if (value.mode !== "managed") throw new Error("the runtime mode is unsupported");
  if (!isRecord(value.bridge)) throw new Error("the managed bridge configuration is missing");
  if (!isRecord(value.defaults)) throw new Error("the UDP defaults are missing");
  if (!isRecord(value.release)) throw new Error("the release identity is missing");
  if (value.bridge.authentication !== "same-origin-proxy") {
    throw new Error("the bridge authentication mode is unsupported");
  }

  const port = value.defaults.port;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("the default UDP port is invalid");
  }

  return {
    mode: "managed",
    format: OPERATOR_RUNTIME_FORMAT,
    formatVersion: OPERATOR_RUNTIME_FORMAT_VERSION,
    controlUrl: normalizeUdpBridgeUrl(requiredString(value.bridge, "baseUrl", 512)),
    version: requiredString(value.release, "version", 128),
    commit: requiredString(value.release, "commit", 128),
    defaults: {
      host: requiredString(value.defaults, "host", 253),
      port,
      multicastGroup: nullableString(value.defaults, "multicastGroup", 253),
      multicastInterface: nullableString(value.defaults, "multicastInterface", 253),
    },
  };
}

function parseOperatorRuntime(value: unknown): OperatorRuntime {
  if (
    isRecord(value)
    && value.format === OPERATOR_RUNTIME_FORMAT
    && value.formatVersion === OPERATOR_RUNTIME_FORMAT_VERSION
    && value.mode === "manual"
  ) {
    return MANUAL_OPERATOR_RUNTIME;
  }
  return parseManagedOperatorRuntime(value);
}

export async function loadOperatorRuntime(
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<OperatorRuntime> {
  let response: Response;
  try {
    response = await fetchImpl(OPERATOR_RUNTIME_PATH, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return MANUAL_OPERATOR_RUNTIME;
  }

  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (response.status === 404 || (response.ok && !contentType.includes("application/json"))) {
    return MANUAL_OPERATOR_RUNTIME;
  }
  if (!response.ok) {
    return {
      mode: "invalid",
      message: `The managed local runtime could not be loaded (HTTP ${response.status}).`,
    };
  }

  try {
    return parseOperatorRuntime(await response.json());
  } catch (cause) {
    return {
      mode: "invalid",
      message: `The managed local runtime response is invalid: ${cause instanceof Error ? cause.message : "unknown validation error"}.`,
    };
  }
}
