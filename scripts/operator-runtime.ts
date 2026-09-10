import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  createServer,
  request as createHttpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createCaptureBridge, type CaptureBridgeStatus } from "./capture-bridge.mjs";

const APP_HOST = "127.0.0.1";
const DEFAULT_APP_PORT = 47_890;
const DEFAULT_BRIDGE_PORT = 0;
const DEFAULT_UDP_HOST = "127.0.0.1";
const DEFAULT_UDP_PORT = 9_104;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_PROXY_REQUEST_BYTES = 4_096;
const MAX_REQUEST_URL_LENGTH = 2_048;
const RUNTIME_PATH = "/replaycase-runtime.json";
const LEGACY_RUNTIME_PATH = "/narrowslink-runtime.json";
const BRIDGE_PROXY_PATHS = new Set(["/v1/status", "/v1/events", "/v1/start", "/v1/stop"]);

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

export interface ReleaseIdentity {
  version: string;
  commit: string;
}

export interface ServeOptions {
  appPort: number;
  bridgePort: number;
  udpHost: string;
  udpPort: number;
  multicastGroup?: string;
  multicastInterface?: string;
  openBrowser: boolean;
  jsonReady: boolean;
}

export interface OperatorRuntime {
  appUrl: string;
  bridgeUrl: string;
  udpDefaults: {
    host: string;
    port: number;
    multicastGroup: string | null;
    multicastInterface: string | null;
  };
  release: ReleaseIdentity;
  bridgeStatus(): CaptureBridgeStatus;
  close(): Promise<void>;
}

export class ServeArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeArgumentError";
  }
}

function parsePort(value: string, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ServeArgumentError(`${label} must be an integer between 0 and 65535.`);
  }
  return port;
}

function nextValue(argv: readonly string[], index: number, argument: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new ServeArgumentError(`Missing value for ${argument}.`);
  }
  return value;
}

export function parseServeArguments(argv: readonly string[]): ServeOptions {
  const options: ServeOptions = {
    appPort: DEFAULT_APP_PORT,
    bridgePort: DEFAULT_BRIDGE_PORT,
    udpHost: DEFAULT_UDP_HOST,
    udpPort: DEFAULT_UDP_PORT,
    openBrowser: true,
    jsonReady: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-open") {
      options.openBrowser = false;
      continue;
    }
    if (argument === "--json-ready") {
      options.jsonReady = true;
      continue;
    }

    const value = nextValue(argv, index, argument ?? "");
    if (argument === "--app-port") options.appPort = parsePort(value, "Application port");
    else if (argument === "--bridge-port") options.bridgePort = parsePort(value, "Bridge port");
    else if (argument === "--udp-host") options.udpHost = value;
    else if (argument === "--udp-port") options.udpPort = parsePort(value, "UDP port");
    else if (argument === "--multicast-group") options.multicastGroup = value;
    else if (argument === "--multicast-interface") options.multicastInterface = value;
    else throw new ServeArgumentError(`Unknown serve option ${argument}.`);
    index += 1;
  }

  return options;
}

export function resolveApplicationRoot(moduleUrl: string): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(moduleDirectory, "..", "app"),
    resolve(moduleDirectory, "..", "dist"),
  ];
  const selected = candidates.find((candidate) => existsSync(resolve(candidate, "index.html")));
  if (!selected) {
    throw new Error("ReplayCase application assets are missing from the release.");
  }
  return selected;
}

function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'self'",
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
    ].join("; "),
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  text: string,
  headers: Record<string, string> = {},
  headOnly = false,
): void {
  const body = Buffer.from(text, "utf8");
  response.writeHead(statusCode, {
    ...securityHeaders(),
    "Cache-Control": "no-store",
    "Content-Length": String(body.byteLength),
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(headOnly ? undefined : body);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function resolveAsset(root: string, rawPathname: string): Promise<string | null> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  if (pathname === "/") pathname = "/index.html";
  if (
    !pathname.startsWith("/")
    || pathname.includes("\0")
    || pathname.includes("\\")
    || pathname.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  const candidate = resolve(root, `.${pathname}`);
  if (!isWithinRoot(root, candidate)) return null;
  try {
    const resolved = await realpath(candidate);
    if (!isWithinRoot(root, resolved)) return null;
    const details = await stat(resolved);
    if (!details.isFile() || details.size > MAX_ASSET_BYTES) return null;
    return resolved;
  } catch {
    return null;
  }
}

class ProxyRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProxyRequestError";
  }
}

function sendProxyError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  const body = Buffer.from(JSON.stringify({ code, message }), "utf8");
  response.writeHead(status, {
    ...securityHeaders(),
    "Cache-Control": "no-store",
    "Content-Length": String(body.byteLength),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function readProxyBody(request: IncomingMessage): Promise<Buffer> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ProxyRequestError(415, "unsupported-content-type", "Requests with a body must use application/json.");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PROXY_REQUEST_BYTES) {
      throw new ProxyRequestError(413, "request-too-large", "The bridge request exceeds 4096 bytes.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function relayBridgeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    appUrl: string;
    bridgeUrl: string;
    token: string;
    url: URL;
  },
): Promise<void> {
  const expectedMethod = options.url.pathname === "/v1/status" || options.url.pathname === "/v1/events"
    ? "GET"
    : "POST";
  if (request.method !== expectedMethod) {
    throw new ProxyRequestError(405, "method-not-allowed", `This endpoint requires ${expectedMethod}.`);
  }
  if (options.url.search || options.url.hash) {
    throw new ProxyRequestError(400, "unknown-query", "The managed bridge proxy does not accept query parameters.");
  }
  if (request.headers.origin !== undefined && request.headers.origin !== options.appUrl) {
    throw new ProxyRequestError(403, "origin-not-allowed", "This browser origin is not allowed to access the local bridge.");
  }
  if (expectedMethod === "POST" && request.headers.origin !== options.appUrl) {
    throw new ProxyRequestError(403, "origin-required", "Managed bridge changes require the ReplayCase application origin.");
  }

  const body = expectedMethod === "POST" ? await readProxyBody(request) : undefined;
  const target = new URL(options.url.pathname, options.bridgeUrl);

  await new Promise<void>((resolvePromise) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    const upstream = createHttpRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: expectedMethod,
      headers: {
        Accept: options.url.pathname === "/v1/events"
          ? "text/event-stream"
          : "application/json",
        Authorization: `Bearer ${options.token}`,
        ...(body
          ? {
              "Content-Length": String(body.byteLength),
              "Content-Type": "application/json",
            }
          : {}),
      },
    }, (upstreamResponse) => {
      if (response.destroyed || response.writableEnded) {
        upstreamResponse.destroy();
        settle();
        return;
      }
      const contentType = upstreamResponse.headers["content-type"];
      const cacheControl = upstreamResponse.headers["cache-control"];
      response.writeHead(upstreamResponse.statusCode ?? 502, {
        ...securityHeaders(),
        "Cache-Control": typeof cacheControl === "string" ? cacheControl : "no-store",
        ...(typeof contentType === "string" ? { "Content-Type": contentType } : {}),
        ...(options.url.pathname === "/v1/events"
          ? {
              Connection: "close",
              "X-Accel-Buffering": "no",
            }
          : {}),
        "X-Content-Type-Options": "nosniff",
      });
      upstreamResponse.pipe(response);
      upstreamResponse.once("end", settle);
      const endFailedStream = () => {
        if (!response.writableEnded) response.end();
        settle();
      };
      upstreamResponse.once("aborted", endFailedStream);
      upstreamResponse.once("error", endFailedStream);
    });
    upstream.once("error", () => {
      if (!response.headersSent && !response.destroyed) {
        sendProxyError(response, 502, "bridge-unreachable", "The internal capture bridge is unavailable.");
      } else if (!response.writableEnded) {
        response.end();
      }
      settle();
    });
    request.once("aborted", () => upstream.destroy());
    response.once("close", () => {
      if (!response.writableEnded) upstream.destroy();
      settle();
    });
    upstream.end(body);
  });
}

function runtimeDocument(
  appUrl: string,
  defaults: OperatorRuntime["udpDefaults"],
  release: ReleaseIdentity,
): object {
  return {
    format: "narrowslink/operator-runtime",
    formatVersion: 1,
    mode: "managed",
    bridge: {
      baseUrl: appUrl,
      authentication: "same-origin-proxy",
    },
    defaults,
    release,
  };
}

interface AssetHandlerOptions {
  applicationRoot: string;
  appUrl: string;
  bridgeUrl: () => string | null;
  token: string;
  defaults: () => OperatorRuntime["udpDefaults"] | null;
  release: ReleaseIdentity;
}

export function createOperatorAssetHandler(options: AssetHandlerOptions) {
  const expectedHost = new URL(options.appUrl).host;

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const bridgeUrl = options.bridgeUrl();
    if (!bridgeUrl) {
      sendText(response, 503, "ReplayCase is still starting.\n");
      return;
    }
    if (request.headers.host !== expectedHost) {
      sendText(response, 403, "Host not allowed.\n");
      return;
    }
    if ((request.url?.length ?? 0) > MAX_REQUEST_URL_LENGTH) {
      sendText(response, 414, "Request URL is too long.\n");
      return;
    }
    const url = new URL(request.url ?? "/", options.appUrl);

    if (BRIDGE_PROXY_PATHS.has(url.pathname)) {
      try {
        await relayBridgeRequest(request, response, {
          appUrl: options.appUrl,
          bridgeUrl,
          token: options.token,
          url,
        });
      } catch (error) {
        const proxyError = error instanceof ProxyRequestError
          ? error
          : new ProxyRequestError(500, "proxy-internal-error", "The managed bridge proxy failed unexpectedly.");
        if (!response.headersSent) {
          sendProxyError(response, proxyError.status, proxyError.code, proxyError.message);
        } else if (!response.writableEnded) {
          response.end();
        }
      }
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "Method not allowed.\n", { Allow: "GET, HEAD" });
      return;
    }
    const headOnly = request.method === "HEAD";

    if (url.pathname === RUNTIME_PATH || url.pathname === LEGACY_RUNTIME_PATH) {
      const defaults = options.defaults();
      if (!defaults) {
        sendText(response, 503, "ReplayCase runtime defaults are unavailable.\n");
        return;
      }
      const body = Buffer.from(JSON.stringify(runtimeDocument(options.appUrl, defaults, options.release)), "utf8");
      response.writeHead(200, {
        ...securityHeaders(),
        "Cache-Control": "no-store",
        "Content-Length": String(body.byteLength),
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(headOnly ? undefined : body);
      return;
    }

    const assetPath = await resolveAsset(options.applicationRoot, url.pathname);
    if (!assetPath) {
      sendText(response, 404, "Not found.\n");
      return;
    }
    const body = await readFile(assetPath);
    const extension = extname(assetPath).toLowerCase();
    const contentType = CONTENT_TYPES.get(extension) ?? "application/octet-stream";
    response.writeHead(200, {
      ...securityHeaders(),
      "Cache-Control": url.pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "Content-Length": String(body.byteLength),
      "Content-Type": contentType,
    });
    response.end(headOnly ? undefined : body);
  };
}

async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, APP_HOST);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("ReplayCase application server did not expose a TCP address.");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

export async function startOperatorRuntime(input: {
  options: ServeOptions;
  release: ReleaseIdentity;
  moduleUrl?: string;
  applicationRoot?: string;
}): Promise<OperatorRuntime> {
  const token = randomBytes(32).toString("base64url");
  let bridgeUrl: string | null = null;
  let udpDefaults: OperatorRuntime["udpDefaults"] | null = null;
  let appUrl = `http://${APP_HOST}:${input.options.appPort}`;
  const applicationRoot = await realpath(
    input.applicationRoot ?? resolveApplicationRoot(input.moduleUrl ?? import.meta.url),
  );

  let handler: ReturnType<typeof createOperatorAssetHandler> | null = null;
  const appServer = createServer((request, response) => {
    void (handler
      ? handler(request, response)
      : Promise.resolve(sendText(response, 503, "ReplayCase is still starting.\n"))
    ).catch(() => {
      if (!response.headersSent) sendText(response, 500, "Internal server error.\n");
      else if (!response.writableEnded) response.end();
    });
  });
  appServer.requestTimeout = 10_000;
  appServer.headersTimeout = 10_000;
  appServer.keepAliveTimeout = 5_000;
  appServer.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  const appPort = await listen(appServer, input.options.appPort);
  appUrl = `http://${APP_HOST}:${appPort}`;
  let bridge: ReturnType<typeof createCaptureBridge> | null = null;
  try {
    bridge = createCaptureBridge({
      controlPort: input.options.bridgePort,
      udpHost: input.options.udpHost,
      udpPort: input.options.udpPort,
      multicastGroup: input.options.multicastGroup,
      multicastInterface: input.options.multicastInterface,
      token,
    });
    const status = await bridge.listen();
    bridgeUrl = `http://${status.control.host}:${status.control.port}`;
    udpDefaults = { ...status.defaults };
  } catch (error) {
    await bridge?.close().catch(() => undefined);
    await closeServer(appServer);
    throw error;
  }
  if (!bridge || !bridgeUrl || !udpDefaults) {
    await closeServer(appServer);
    throw new Error("ReplayCase bridge readiness was incomplete.");
  }
  const activeBridge = bridge;
  const activeBridgeUrl = bridgeUrl;
  const activeUdpDefaults = udpDefaults;

  handler = createOperatorAssetHandler({
    applicationRoot,
    appUrl,
    bridgeUrl: () => activeBridgeUrl,
    token,
    defaults: () => activeUdpDefaults,
    release: input.release,
  });

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      const appServerClose = closeServer(appServer);
      await activeBridge.close({
        code: "bridge-shutdown",
        message: "The ReplayCase operator runtime shut down before the operator completed the capture.",
      });
      appServer.closeIdleConnections();
      await appServerClose;
    })();
    return closePromise;
  };

  return {
    appUrl,
    bridgeUrl: activeBridgeUrl,
    udpDefaults: activeUdpDefaults,
    release: input.release,
    bridgeStatus: () => activeBridge.status(),
    close,
  };
}

type SpawnImplementation = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export function openOperatorUrl(
  url: string,
  platform = process.platform,
  spawnImplementation: SpawnImplementation = spawn,
): boolean {
  let command: string;
  let args: readonly string[];
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd.exe";
    args = ["/d", "/s", "/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawnImplementation(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
