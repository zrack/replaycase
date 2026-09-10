import { EventEmitter } from "node:events";
import { request } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCaptureBridge } from "./capture-bridge.mjs";
import { waitForShutdown } from "./replaycase.ts";
import {
  parseServeArguments,
  ServeArgumentError,
  startOperatorRuntime,
} from "./operator-runtime.ts";

const release = Object.freeze({
  version: "0.1.0-test",
  commit: "0123456789abcdef0123456789abcdef01234567",
});

let runtime = null;
let applicationRoot = null;

afterEach(async () => {
  await runtime?.close();
  runtime = null;
  if (applicationRoot) await rm(applicationRoot, { recursive: true, force: true });
  applicationRoot = null;
});

async function makeApplication() {
  applicationRoot = await mkdtemp(join(tmpdir(), "replaycase-operator-runtime-"));
  await mkdir(join(applicationRoot, "assets"));
  await writeFile(
    join(applicationRoot, "index.html"),
    "<!doctype html><html><body><div id=\"root\"></div><script src=\"/assets/app.js\"></script></body></html>",
  );
  await writeFile(join(applicationRoot, "assets", "app.js"), "globalThis.__narrowslinkTest = true;\n");
  return applicationRoot;
}

function rawRequest(baseUrl, path, headers = {}) {
  const base = new URL(baseUrl);
  return new Promise((resolvePromise, reject) => {
    const client = request({
      hostname: base.hostname,
      port: base.port,
      path,
      method: "GET",
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolvePromise({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    client.once("error", reject);
    client.end();
  });
}

function options(overrides = {}) {
  return {
    appPort: 0,
    bridgePort: 0,
    udpHost: "127.0.0.1",
    udpPort: 0,
    openBrowser: false,
    jsonReady: true,
    ...overrides,
  };
}

describe("operator serve arguments", () => {
  it("uses a stable application port and an ephemeral bridge by default", () => {
    expect(parseServeArguments([])).toEqual({
      appPort: 47_890,
      bridgePort: 0,
      udpHost: "127.0.0.1",
      udpPort: 9_104,
      openBrowser: true,
      jsonReady: false,
    });
  });

  it("parses the packaged-release acceptance options without accepting a token", () => {
    expect(parseServeArguments([
      "--app-port", "0",
      "--bridge-port", "0",
      "--udp-port", "0",
      "--udp-host", "0.0.0.0",
      "--no-open",
      "--json-ready",
    ])).toMatchObject({
      appPort: 0,
      bridgePort: 0,
      udpPort: 0,
      udpHost: "0.0.0.0",
      openBrowser: false,
      jsonReady: true,
    });
    expect(() => parseServeArguments(["--token", "not-allowed-here"]))
      .toThrow(ServeArgumentError);
  });
});

describe("operator shutdown coordination", () => {
  it("treats SIGHUP as an orderly, idempotent evidence shutdown", async () => {
    const controller = new EventEmitter();
    const close = vi.fn(async () => undefined);
    const forceExit = vi.fn();
    const pending = waitForShutdown(
      { close },
      { stdout: vi.fn(), stderr: vi.fn() },
      controller,
      100,
      forceExit,
    );

    controller.emit("SIGHUP");
    await expect(pending).resolves.toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(forceExit).not.toHaveBeenCalled();
  });

  it("force-exits when an ordinary signal cannot finish evidence shutdown within the bound", async () => {
    const controller = new EventEmitter();
    const close = vi.fn(() => new Promise(() => undefined));
    const stderr = vi.fn();
    const forceExit = vi.fn();
    const pending = waitForShutdown(
      { close },
      { stdout: vi.fn(), stderr },
      controller,
      10,
      forceExit,
    );

    controller.emit("SIGTERM");
    await expect(pending).resolves.toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("within 10 ms"));
  });

  it("bounds fatal shutdown and does not close twice when fatal events race", async () => {
    const controller = new EventEmitter();
    const close = vi.fn(async () => undefined);
    const stderr = vi.fn();
    const forceExit = vi.fn();
    const pending = waitForShutdown(
      { close },
      { stdout: vi.fn(), stderr },
      controller,
      100,
      forceExit,
    );

    controller.emit("uncaughtException", new Error("fatal test"));
    controller.emit("unhandledRejection", new Error("second fatal test"));
    await expect(pending).resolves.toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalled();
  });
});

describe("bridge shutdown admission", () => {
  it("rejects new capture starts after close begins and shares one close operation", async () => {
    const bridge = createCaptureBridge({
      controlPort: 0,
      udpHost: "127.0.0.1",
      udpPort: 0,
      token: "shutdown-admission-test-token-1234",
    });
    await bridge.listen();

    const firstClose = bridge.close();
    const secondClose = bridge.close();
    expect(secondClose).toBe(firstClose);
    await expect(bridge.startCapture({
      host: "127.0.0.1",
      port: 0,
      requestNonce: "shutdown-admission-request-nonce",
    })).rejects.toMatchObject({
      code: "bridge-shutting-down",
      status: 503,
    });
    await firstClose;
    expect(bridge.status().state).toBe("idle");
  });
});

describe("managed operator runtime", () => {
  it("serves only the release app and provisions a secret-free managed bridge", async () => {
    runtime = await startOperatorRuntime({
      options: options(),
      release,
      applicationRoot: await makeApplication(),
    });

    const root = await fetch(runtime.appUrl);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(root.headers.get("content-security-policy")).not.toContain(runtime.bridgeUrl);
    expect(root.headers.get("set-cookie")).toBeNull();

    const runtimeResponse = await fetch(`${runtime.appUrl}/replaycase-runtime.json`);
    expect(runtimeResponse.headers.get("cache-control")).toBe("no-store");
    const document = await runtimeResponse.json();
    expect(document).toEqual({
      format: "narrowslink/operator-runtime",
      formatVersion: 1,
      mode: "managed",
      bridge: {
        baseUrl: runtime.appUrl,
        authentication: "same-origin-proxy",
      },
      defaults: runtime.udpDefaults,
      release,
    });
    expect(JSON.stringify(document)).not.toContain(runtime.bridgeUrl);
    const legacyResponse = await fetch(`${runtime.appUrl}/narrowslink-runtime.json`);
    expect(legacyResponse.headers.get("cache-control")).toBe("no-store");
    expect(await legacyResponse.json()).toEqual(document);

    const directBridgeRequest = await fetch(`${runtime.bridgeUrl}/v1/status`, {
      headers: { Origin: runtime.appUrl },
    });
    expect(directBridgeRequest.status).toBe(401);

    const relayed = await fetch(`${runtime.appUrl}/v1/status`);
    expect(relayed.status).toBe(200);
    await expect(relayed.json()).resolves.toMatchObject({
      state: "idle",
      control: { host: "127.0.0.1" },
    });

    const originlessStart = await fetch(`${runtime.appUrl}/v1/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: "127.0.0.1",
        port: 0,
        requestNonce: "operator-runtime-originless-start",
      }),
    });
    expect(originlessStart.status).toBe(403);

    const wrongOrigin = await fetch(`${runtime.appUrl}/v1/status`, {
      headers: { Origin: "http://127.0.0.1:1" },
    });
    expect(wrongOrigin.status).toBe(403);

    const tokenQuery = await fetch(`${runtime.appUrl}/v1/events?token=must-not-be-used`);
    expect(tokenQuery.status).toBe(400);

    const asset = await fetch(`${runtime.appUrl}/assets/app.js`);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

    const traversal = await rawRequest(runtime.appUrl, "/%2e%2e%2foutside.txt");
    expect(traversal.status).toBe(404);
    const wrongHost = await rawRequest(runtime.appUrl, "/", { Host: "terminal.invalid" });
    expect(wrongHost.status).toBe(403);
  });

  it("records an active runtime shutdown as incomplete bridge evidence", async () => {
    runtime = await startOperatorRuntime({
      options: options(),
      release,
      applicationRoot: await makeApplication(),
    });
    const events = await fetch(`${runtime.appUrl}/v1/events`);
    expect(events.status).toBe(200);
    const started = await fetch(`${runtime.appUrl}/v1/start`, {
      method: "POST",
      headers: {
        Origin: runtime.appUrl,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        host: "127.0.0.1",
        port: 0,
        requestNonce: "operator-runtime-shutdown-test-nonce",
      }),
    });
    expect(started.status).toBe(200);

    const streamedEvidencePromise = events.text();
    await runtime.close();
    const streamedEvidence = await streamedEvidencePromise;
    expect(streamedEvidence).toContain('"state":"stopped"');
    expect(streamedEvidence).toContain('"code":"bridge-shutdown"');
    const status = runtime.bridgeStatus();
    expect(status.state).toBe("stopped");
    expect(status.captureJournal?.state).toBe("incomplete");
    expect(status.captureJournal?.entries.at(-1)).toMatchObject({
      type: "capture-stopped",
      code: "bridge-shutdown",
    });
  });
});
