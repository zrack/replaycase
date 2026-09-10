#!/usr/bin/env node

import { createSocket } from "node:dgram";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createUdpKernelDropCounter } from "./udp-kernel-drop-counter.mjs";

const PROTOCOL_VERSION = 1;
const CONTROL_HOST = "127.0.0.1";
const DEFAULT_CONTROL_PORT = 47_891;
const DEFAULT_UDP_HOST = "127.0.0.1";
const DEFAULT_UDP_PORT = 9_104;
const MAX_REQUEST_BYTES = 4_096;
const MAX_SSE_QUEUE_EVENTS = 256;
const MAX_SSE_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 256;
export const MAX_CAPTURE_JOURNAL_ENTRIES = 128;

const CAPTURE_JOURNAL_ERROR_TYPES = new Set(["bridge-error", "subscriber-backpressure"]);

class BridgeRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "BridgeRequestError";
    this.status = status;
    this.code = code;
  }
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${label} must be an integer between 0 and 65535.`);
  }
  return port;
}

function validateBindHost(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 253 || /[^A-Za-z0-9.:%_-]/.test(value)) {
    throw new BridgeRequestError(400, "invalid-bind-host", "UDP host must be a local interface address or hostname.");
  }
  return value;
}

function validateUdpPort(value) {
  if (typeof value !== "number") {
    throw new BridgeRequestError(400, "invalid-bind-port", "UDP port must be a JSON integer between 0 and 65535.");
  }
  try {
    return parsePort(value, "UDP port");
  } catch (error) {
    throw new BridgeRequestError(400, "invalid-bind-port", error instanceof Error ? error.message : "UDP port is invalid.");
  }
}

function validateToken(value) {
  if (typeof value !== "string" || value.length < 16 || value.length > MAX_TOKEN_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Bridge token must contain 16 to 256 printable characters.");
  }
  return value;
}

function usage() {
  return `ReplayCase local UDP capture bridge

Usage: node scripts/capture-bridge.mjs [options]

Options:
  --control-port <port>  Loopback HTTP port (default ${DEFAULT_CONTROL_PORT}; 0 selects a free port)
  --udp-host <host>      Default UDP bind host (default ${DEFAULT_UDP_HOST})
  --udp-port <port>      Default UDP bind port (default ${DEFAULT_UDP_PORT}; 0 selects a free port)
  --multicast-group <ip> Default IPv4 or IPv6 multicast group
  --multicast-interface <ip>
                         Default local interface address for group membership
  --token <token>        Browser authentication token (or set REPLAYCASE_BRIDGE_TOKEN)
  --help                 Show this message
`;
}

export function parseArguments(argv) {
  const options = {
    controlPort: DEFAULT_CONTROL_PORT,
    udpHost: DEFAULT_UDP_HOST,
    udpPort: DEFAULT_UDP_PORT,
    multicastGroup: undefined,
    multicastInterface: undefined,
    token: process.env.REPLAYCASE_BRIDGE_TOKEN || process.env.NARROWSLINK_BRIDGE_TOKEN,
    tokenWasGenerated: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    if (argument === "--control-port") options.controlPort = parsePort(value, "Control port");
    else if (argument === "--udp-host") options.udpHost = validateBindHost(value);
    else if (argument === "--udp-port") options.udpPort = parsePort(value, "UDP port");
    else if (argument === "--multicast-group") options.multicastGroup = value;
    else if (argument === "--multicast-interface") options.multicastInterface = value;
    else if (argument === "--token") options.token = value;
    else throw new Error(`Unknown option ${argument}.`);
    index += 1;
  }
  if (!options.token) {
    options.token = randomBytes(24).toString("base64url");
    options.tokenWasGenerated = true;
  }
  options.token = validateToken(options.token);
  options.udpHost = validateBindHost(options.udpHost);
  const multicast = validateMulticast(options.udpHost, options.multicastGroup, options.multicastInterface);
  options.multicastGroup = multicast?.group;
  options.multicastInterface = multicast?.interface ?? undefined;
  return options;
}

function multicastFamily(address) {
  const family = isIP(address);
  if (family === 4) {
    const firstOctet = Number(address.split(".", 1)[0]);
    return firstOctet >= 224 && firstOctet <= 239 ? 4 : 0;
  }
  if (family === 6) {
    return address.toLowerCase().startsWith("ff") ? 6 : 0;
  }
  return 0;
}

function validateMulticast(bindHost, group, interfaceAddress) {
  if (group === undefined || group === null || group === "") {
    if (interfaceAddress !== undefined && interfaceAddress !== null && interfaceAddress !== "") {
      throw new BridgeRequestError(400, "multicast-group-required", "A multicast interface requires a multicast group.");
    }
    return null;
  }
  if (typeof group !== "string" || group.length > 253) {
    throw new BridgeRequestError(400, "invalid-multicast-group", "The multicast group must be a bounded IP address.");
  }
  const family = multicastFamily(group);
  if (family === 0) {
    throw new BridgeRequestError(400, "invalid-multicast-group", "The multicast group must be an IPv4 or IPv6 multicast address.");
  }
  if (interfaceAddress !== undefined && interfaceAddress !== null) {
    if (typeof interfaceAddress !== "string" || interfaceAddress.length === 0 || interfaceAddress.length > 253 || isIP(interfaceAddress) !== family) {
      throw new BridgeRequestError(400, "multicast-family-mismatch", "The multicast interface must be an IP address in the same family as the group.");
    }
  }
  const explicitBindFamily = isIP(bindHost);
  const socketFamily = explicitBindFamily === 0 ? (bindHost.includes(":") ? 6 : 4) : explicitBindFamily;
  if (socketFamily !== family) {
    throw new BridgeRequestError(400, "multicast-family-mismatch", "The UDP bind host and multicast group must use the same IP family.");
  }
  return {
    group,
    interface: interfaceAddress ?? null,
    family: family === 4 ? "IPv4" : "IPv6",
  };
}

function allowedLoopbackOrigin(origin) {
  if (origin === undefined) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "terminal.local" || hostname === "[::1]" || hostname === "::1") return true;
  const octets = hostname.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function tokenMatches(expected, received) {
  if (typeof received !== "string" || received.length > MAX_TOKEN_LENGTH) return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
  return authorization.slice(7);
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  return origin && allowedLoopbackOrigin(origin)
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
    : {};
}

function jsonResponse(request, response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...corsHeaders(request),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function readJson(request) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new BridgeRequestError(415, "unsupported-content-type", "Requests with a body must use application/json.");
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_REQUEST_BYTES) {
      throw new BridgeRequestError(413, "request-too-large", "The bridge request exceeds 4096 bytes.");
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
    return value;
  } catch {
    throw new BridgeRequestError(400, "invalid-json", "The bridge request body must be a JSON object.");
  }
}

function formatSse(event, value, id) {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

export function createCaptureBridge(options) {
  const udpHost = validateBindHost(options.udpHost ?? DEFAULT_UDP_HOST);
  const configuredMulticast = validateMulticast(udpHost, options.multicastGroup, options.multicastInterface);
  const config = {
    controlPort: parsePort(options.controlPort ?? DEFAULT_CONTROL_PORT, "Control port"),
    udpHost,
    udpPort: parsePort(options.udpPort ?? DEFAULT_UDP_PORT, "UDP port"),
    multicastGroup: configuredMulticast?.group,
    multicastInterface: configuredMulticast?.interface ?? undefined,
    token: validateToken(options.token),
  };
  const udpKernelDropCounterFactory = options.udpKernelDropCounterFactory ?? createUdpKernelDropCounter;
  const subscribers = new Set();
  let controlPort = config.controlPort;
  let state = "idle";
  let udpSocket = null;
  let udpAddress = null;
  let multicastMembership = null;
  let capture = null;
  let captureJournal = null;
  let captureLease = null;
  let captureRequestNonce = null;
  let captureRequestKey = null;
  let captureStartMonotonicNs = null;
  let udpKernelDropCounter = null;
  let kernelDropEvidence = {
    kernelDroppedDatagrams: null,
    kernelDroppedDatagramsSource: "unavailable",
  };
  let lastError = null;
  let startPromise = null;
  let activeStartNonce = null;
  let activeStartKey = null;
  let shuttingDown = false;
  let closePromise = null;

  function captureDurationUs() {
    if (!capture) return 0;
    if (capture.endedAt) return capture.durationUs;
    if (captureStartMonotonicNs === null) return capture.durationUs;
    return Number((process.hrtime.bigint() - captureStartMonotonicNs) / 1_000n);
  }

  function createCaptureJournal(request, startedAt) {
    if (!capture || !udpAddress) throw new Error("An active capture is missing its bound UDP address.");
    const journal = {
      captureId: capture.id,
      startedAt,
      endedAt: null,
      state: "active",
      bind: Object.freeze({
        requestedHost: request.host,
        requestedPort: request.port,
        host: udpAddress.host,
        port: udpAddress.port,
        family: udpAddress.family,
      }),
      multicast: request.multicast ? Object.freeze({ ...request.multicast }) : null,
      entriesComplete: true,
      omittedEntries: 0,
      entries: [],
      nextSequence: 0,
    };
    captureJournal = journal;
    appendCaptureJournalEntry("capture-started", { at: startedAt, offsetUs: 0 });
  }

  function appendCaptureJournalEntry(type, options = {}) {
    if (!captureJournal || !capture) return;
    const terminal = type === "capture-stopped";
    const sequence = captureJournal.nextSequence;
    captureJournal.nextSequence += 1;
    if (captureJournal.endedAt !== null && !terminal) {
      captureJournal.entriesComplete = false;
      captureJournal.omittedEntries += 1;
      captureJournal.state = "incomplete";
      return;
    }
    const entry = Object.freeze({
      sequence,
      type,
      at: options.at ?? new Date().toISOString(),
      offsetUs: options.offsetUs ?? captureDurationUs(),
      datagrams: capture.datagrams,
      bytes: capture.bytes,
      ...(options.code ? { code: options.code } : {}),
      ...(options.message ? { message: String(options.message).slice(0, 1_000) } : {}),
      ...(typeof options.fatal === "boolean" ? { fatal: options.fatal } : {}),
    });
    const retainedLimit = terminal ? MAX_CAPTURE_JOURNAL_ENTRIES : MAX_CAPTURE_JOURNAL_ENTRIES - 1;
    if (captureJournal.entries.length >= retainedLimit) {
      captureJournal.entriesComplete = false;
      captureJournal.omittedEntries += 1;
      captureJournal.state = "incomplete";
      return;
    }
    if (CAPTURE_JOURNAL_ERROR_TYPES.has(type)) captureJournal.state = "incomplete";
    captureJournal.entries.push(entry);
  }

  function finishCaptureJournal(options = {}) {
    if (!captureJournal || !capture || captureJournal.endedAt !== null || !capture.endedAt) return;
    captureJournal.endedAt = capture.endedAt;
    if (options.clean === false || !captureJournal.entriesComplete) captureJournal.state = "incomplete";
    else if (captureJournal.state === "active") captureJournal.state = "clean";
    appendCaptureJournalEntry("capture-stopped", {
      at: capture.endedAt,
      offsetUs: capture.durationUs,
      ...(options.code ? { code: options.code } : {}),
      ...(options.message ? { message: options.message } : {}),
    });
  }

  function captureJournalDocument() {
    if (!captureJournal || !capture) return null;
    return {
      captureId: captureJournal.captureId,
      startedAt: captureJournal.startedAt,
      endedAt: captureJournal.endedAt,
      state: captureJournal.state,
      bind: { ...captureJournal.bind },
      multicast: captureJournal.multicast ? { ...captureJournal.multicast } : null,
      datagrams: capture.datagrams,
      bytes: capture.bytes,
      ...kernelDropEvidence,
      entriesComplete: captureJournal.entriesComplete,
      omittedEntries: captureJournal.omittedEntries,
      entries: captureJournal.entries.map((entry) => ({ ...entry })),
    };
  }

  function statusDocument() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      state,
      control: { host: CONTROL_HOST, port: controlPort },
      defaults: {
        host: config.udpHost,
        port: config.udpPort,
        multicastGroup: config.multicastGroup ?? null,
        multicastInterface: config.multicastInterface ?? null,
      },
      udp: udpAddress,
      multicast: multicastMembership,
      capture: capture ? { ...capture, durationUs: captureDurationUs() } : null,
      captureJournal: captureJournalDocument(),
      subscribers: subscribers.size,
      lastError,
    };
  }

  function closeSubscriber(subscriber, finalPayload) {
    if (subscriber.closed) return;
    subscribers.delete(subscriber);
    subscriber.closed = true;
    subscriber.queue.length = 0;
    subscriber.queuedBytes = 0;
    if (!subscriber.response.destroyed) subscriber.response.end(finalPayload);
  }

  function writeSubscriber(subscriber, payload) {
    if (subscriber.closed) return;
    if (!subscriber.blocked) {
      subscriber.blocked = !subscriber.response.write(payload);
      return;
    }
    const bytes = Buffer.byteLength(payload);
    if (subscriber.queue.length >= MAX_SSE_QUEUE_EVENTS || subscriber.queuedBytes + bytes > MAX_SSE_QUEUE_BYTES) {
      const overflow = {
        protocolVersion: PROTOCOL_VERSION,
        code: "subscriber-backpressure",
        message: "The browser could not consume captured datagrams fast enough; its event stream was closed without dropping silently.",
        at: new Date().toISOString(),
        fatal: true,
      };
      lastError = overflow;
      appendCaptureJournalEntry("subscriber-backpressure", overflow);
      closeSubscriber(subscriber, formatSse("bridge-error", overflow));
      return;
    }
    subscriber.queue.push(payload);
    subscriber.queuedBytes += bytes;
  }

  function flushSubscriber(subscriber) {
    if (subscriber.closed) return;
    subscriber.blocked = false;
    while (subscriber.queue.length > 0 && !subscriber.blocked) {
      const payload = subscriber.queue.shift();
      subscriber.queuedBytes -= Buffer.byteLength(payload);
      subscriber.blocked = !subscriber.response.write(payload);
    }
  }

  function broadcast(event, value, id) {
    const payload = formatSse(event, value, id);
    for (const subscriber of subscribers) writeSubscriber(subscriber, payload);
  }

  function broadcastStatus() {
    broadcast("status", statusDocument());
  }

  function setError(code, message, fatal) {
    const at = new Date().toISOString();
    lastError = {
      protocolVersion: PROTOCOL_VERSION,
      code,
      message: String(message).slice(0, 1_000),
      at,
      fatal,
    };
    appendCaptureJournalEntry("bridge-error", { code, message, fatal, at });
    broadcast("bridge-error", lastError);
  }

  function handleDatagram(message, remote) {
    if (state !== "capturing" || !capture || captureStartMonotonicNs === null) return;
    const now = new Date();
    const offsetUs = Number((process.hrtime.bigint() - captureStartMonotonicNs) / 1_000n);
    const sequence = capture.datagrams;
    capture.datagrams += 1;
    capture.bytes += message.length;
    capture.durationUs = offsetUs;
    capture.lastDatagramAt = now.toISOString();
    broadcast("datagram", {
      protocolVersion: PROTOCOL_VERSION,
      captureId: capture.id,
      sequence,
      offsetUs,
      receivedAt: now.toISOString(),
      remoteAddress: remote.address,
      remotePort: remote.port,
      remoteFamily: remote.family,
      byteLength: message.length,
      dataBase64: message.toString("base64"),
    }, sequence);
  }

  function markSocketFailure(error) {
    if (state === "stopping" || state === "stopped" || shuttingDown) return;
    const message = error instanceof Error ? error.message : String(error);
    state = "error";
    if (capture && !capture.endedAt) {
      capture.durationUs = captureDurationUs();
      capture.endedAt = new Date().toISOString();
    }
    kernelDropEvidence = {
      kernelDroppedDatagrams: null,
      kernelDroppedDatagramsSource: "unavailable-socket-identity",
    };
    const failedSocket = udpSocket;
    udpSocket = null;
    if (failedSocket) {
      leaveMulticast(failedSocket);
      try {
        failedSocket.close();
      } catch {
        // The socket may already be closed by the runtime after a fatal error.
      }
    }
    setError("udp-socket-error", message, true);
    finishCaptureJournal({ clean: false, code: "udp-socket-error", message });
    broadcastStatus();
  }

  function leaveMulticast(socket) {
    const membership = multicastMembership;
    multicastMembership = null;
    if (!membership) return;
    try {
      socket.dropMembership(membership.group, membership.interface ?? undefined);
    } catch (error) {
      setError(
        "multicast-leave-failed",
        error instanceof Error ? error.message : "Could not leave the multicast group cleanly.",
        false,
      );
    }
  }

  function validateStartRequest(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new BridgeRequestError(400, "invalid-start-request", "Start requires a JSON object.");
    }
    const keys = Object.keys(input);
    if (keys.some((key) => !["host", "port", "multicastGroup", "multicastInterface", "requestNonce"].includes(key))) {
      throw new BridgeRequestError(
        400,
        "unknown-field",
        "Start accepts only host, port, multicastGroup, multicastInterface, and requestNonce fields.",
      );
    }
    if (
      typeof input.requestNonce !== "string"
      || input.requestNonce.length < 16
      || input.requestNonce.length > 128
      || /[\u0000-\u001f\u007f]/.test(input.requestNonce)
    ) {
      throw new BridgeRequestError(400, "invalid-request-nonce", "Start requires a 16 to 128 character requestNonce.");
    }
    const host = input.host === undefined ? config.udpHost : validateBindHost(input.host);
    const port = input.port === undefined ? config.udpPort : validateUdpPort(input.port);
    const multicast = validateMulticast(
      host,
      input.multicastGroup === undefined ? config.multicastGroup : input.multicastGroup,
      input.multicastInterface === undefined ? config.multicastInterface : input.multicastInterface,
    );
    const key = JSON.stringify({
      host,
      port,
      multicastGroup: multicast?.group ?? null,
      multicastInterface: multicast?.interface ?? null,
    });
    return { host, port, multicast, nonce: input.requestNonce, key };
  }

  function startEnvelope() {
    if (!captureLease || !capture) throw new Error("An active capture is missing its private ownership lease.");
    return {
      protocolVersion: PROTOCOL_VERSION,
      status: statusDocument(),
      lease: captureLease,
    };
  }

  function sameStartRequest(nonce, key, expectedNonce, expectedKey) {
    return Boolean(expectedNonce && expectedKey && key === expectedKey && tokenMatches(expectedNonce, nonce));
  }

  async function startCapture(input) {
    if (shuttingDown) {
      throw new BridgeRequestError(503, "bridge-shutting-down", "The local capture bridge is shutting down.");
    }
    const request = validateStartRequest(input);
    if (state === "starting") {
      if (startPromise && sameStartRequest(request.nonce, request.key, activeStartNonce, activeStartKey)) {
        return await startPromise;
      }
      throw new BridgeRequestError(409, "capture-active", "A different UDP capture is already starting.");
    }
    if (state === "capturing") {
      if (sameStartRequest(request.nonce, request.key, captureRequestNonce, captureRequestKey)) {
        return startEnvelope();
      }
      throw new BridgeRequestError(409, "capture-active", "A different UDP capture is already active.");
    }
    if (state === "stopping") {
      throw new BridgeRequestError(409, "capture-active", "A UDP capture is already active or changing state.");
    }
    state = "starting";
    lastError = null;
    multicastMembership = null;
    activeStartNonce = request.nonce;
    activeStartKey = request.key;
    broadcastStatus();

    startPromise = new Promise((resolve, reject) => {
      const socket = createSocket({
        type: request.host.includes(":") ? "udp6" : "udp4",
        reuseAddr: request.multicast !== null,
      });
      udpSocket = socket;
      const onInitialError = (error) => {
        socket.off("listening", onListening);
        udpSocket = null;
        udpAddress = null;
        multicastMembership = null;
        try {
          socket.close();
        } catch {
          // Bind failures can leave the socket in an already-closed state.
        }
        state = "error";
        setError("udp-bind-failed", error.message, true);
        broadcastStatus();
        reject(new BridgeRequestError(
          409,
          "udp-bind-failed",
          `Could not bind UDP ${request.host}:${request.port}: ${error.message}`,
        ));
      };
      const onListening = async () => {
        socket.off("error", onInitialError);
        const address = socket.address();
        udpAddress = { host: address.address, port: address.port, family: address.family };
        if (request.multicast) {
          try {
            socket.addMembership(request.multicast.group, request.multicast.interface ?? undefined);
            multicastMembership = request.multicast;
          } catch (error) {
            udpSocket = null;
            multicastMembership = null;
            state = "error";
            const message = error instanceof Error ? error.message : "Could not join the multicast group.";
            setError("multicast-membership-failed", message, true);
            broadcastStatus();
            try {
              socket.close();
            } catch {
              // The runtime may close a socket when membership setup fails.
            }
            reject(new BridgeRequestError(409, "multicast-membership-failed", message));
            return;
          }
        }
        socket.on("error", markSocketFailure);
        socket.on("message", handleDatagram);
        udpKernelDropCounter = udpKernelDropCounterFactory();
        try {
          kernelDropEvidence = await udpKernelDropCounter.start(udpAddress);
        } catch {
          kernelDropEvidence = {
            kernelDroppedDatagrams: null,
            kernelDroppedDatagramsSource: "unavailable-procfs",
          };
        }
        captureStartMonotonicNs = process.hrtime.bigint();
        const startedAt = new Date().toISOString();
        capture = {
          id: randomUUID(),
          startedAt,
          datagrams: 0,
          bytes: 0,
          durationUs: 0,
        };
        createCaptureJournal(request, startedAt);
        captureLease = randomBytes(32).toString("base64url");
        captureRequestNonce = request.nonce;
        captureRequestKey = request.key;
        state = "capturing";
        broadcastStatus();
        resolve(startEnvelope());
      };
      socket.once("error", onInitialError);
      socket.once("listening", onListening);
      socket.bind({
        address: request.host,
        port: request.port,
        exclusive: request.multicast === null,
      });
    });
    const operation = startPromise;
    try {
      return await operation;
    } finally {
      if (startPromise === operation) {
        startPromise = null;
        activeStartNonce = null;
        activeStartKey = null;
      }
    }
  }

  function validateCaptureOwnership(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new BridgeRequestError(400, "invalid-ownership", "Stop requires capture ownership credentials.");
    }
    const keys = Object.keys(input);
    if (keys.length !== 2 || keys.some((key) => key !== "captureId" && key !== "lease")) {
      throw new BridgeRequestError(400, "invalid-ownership", "Stop accepts exactly captureId and lease fields.");
    }
    if (typeof input.captureId !== "string" || input.captureId.length === 0 || input.captureId.length > 128) {
      throw new BridgeRequestError(400, "invalid-ownership", "Stop captureId is invalid.");
    }
    if (typeof input.lease !== "string" || input.lease.length < 16 || input.lease.length > MAX_TOKEN_LENGTH) {
      throw new BridgeRequestError(400, "invalid-ownership", "Stop lease is invalid.");
    }
    return { captureId: input.captureId, lease: input.lease };
  }

  function assertCaptureOwnership(ownership) {
    if (
      !capture
      || !captureLease
      || ownership.captureId !== capture.id
      || !tokenMatches(captureLease, ownership.lease)
    ) {
      throw new BridgeRequestError(409, "capture-not-owned", "The supplied lease does not own the current capture.");
    }
  }

  async function stopCapture(ownership, enforceOwnership = true, terminalOptions) {
    const validatedOwnership = enforceOwnership ? validateCaptureOwnership(ownership) : null;
    if (startPromise) {
      try {
        await startPromise;
      } catch {
        if (validatedOwnership) assertCaptureOwnership(validatedOwnership);
        return statusDocument();
      }
    }
    if (validatedOwnership) assertCaptureOwnership(validatedOwnership);
    if (!udpSocket) {
      if (state === "idle" || state === "stopped" || state === "error") return statusDocument();
      throw new BridgeRequestError(409, "capture-not-active", "No UDP capture is active.");
    }
    state = "stopping";
    broadcastStatus();
    const socket = udpSocket;
    udpSocket = null;
    leaveMulticast(socket);
    if (udpKernelDropCounter) {
      try {
        kernelDropEvidence = await udpKernelDropCounter.finish();
      } catch {
        kernelDropEvidence = {
          kernelDroppedDatagrams: null,
          kernelDroppedDatagramsSource: "unavailable-procfs",
        };
      }
    }
    await new Promise((resolve) => {
      socket.once("close", resolve);
      socket.close();
    });
    if (capture && !capture.endedAt) {
      capture.durationUs = captureDurationUs();
      capture.endedAt = new Date().toISOString();
    }
    finishCaptureJournal(terminalOptions);
    captureStartMonotonicNs = null;
    state = "stopped";
    broadcastStatus();
    return statusDocument();
  }

  const server = createServer(async (request, response) => {
    try {
      if (shuttingDown) {
        throw new BridgeRequestError(503, "bridge-shutting-down", "The local capture bridge is shutting down.");
      }
      if (!allowedLoopbackOrigin(request.headers.origin)) {
        throw new BridgeRequestError(403, "origin-not-allowed", "This browser origin is not allowed to access the local bridge.");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          ...corsHeaders(request),
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          ...(request.headers["access-control-request-private-network"] === "true"
            ? { "Access-Control-Allow-Private-Network": "true" }
            : {}),
          "Access-Control-Max-Age": "600",
          "Cache-Control": "no-store",
          Vary: "Origin, Access-Control-Request-Headers",
        });
        response.end();
        return;
      }

      const url = new URL(request.url ?? "/", `http://${CONTROL_HOST}`);
      const eventToken = url.pathname === "/v1/events" ? url.searchParams.get("token") : null;
      const receivedToken = eventToken ?? bearerToken(request);
      if (!tokenMatches(config.token, receivedToken)) {
        throw new BridgeRequestError(401, "unauthorized", "A valid ReplayCase bridge token is required.");
      }

      if (request.method === "GET" && url.pathname === "/v1/status") {
        jsonResponse(request, response, 200, statusDocument());
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        if ([...url.searchParams.keys()].some((key) => key !== "token")) {
          throw new BridgeRequestError(400, "unknown-query", "The event stream accepts only the token query parameter.");
        }
        response.writeHead(200, {
          ...corsHeaders(request),
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-store",
          Connection: "close",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        });
        const subscriber = { response, blocked: false, closed: false, queue: [], queuedBytes: 0 };
        subscribers.add(subscriber);
        response.on("drain", () => flushSubscriber(subscriber));
        response.on("close", () => closeSubscriber(subscriber));
        response.write(": ReplayCase local capture stream\n\n");
        writeSubscriber(subscriber, formatSse("hello", statusDocument()));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/start") {
        jsonResponse(request, response, 200, await startCapture(await readJson(request)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/stop") {
        jsonResponse(request, response, 200, await stopCapture(await readJson(request)));
        return;
      }
      throw new BridgeRequestError(404, "not-found", "Unknown local bridge endpoint.");
    } catch (error) {
      const requestError = error instanceof BridgeRequestError
        ? error
        : new BridgeRequestError(500, "bridge-internal-error", error instanceof Error ? error.message : "Unexpected bridge error.");
      if (!response.headersSent) {
        jsonResponse(
          request,
          response,
          requestError.status,
          { code: requestError.code, message: requestError.message },
        );
      } else if (!response.destroyed) {
        response.end();
      }
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  async function listen() {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.controlPort, CONTROL_HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Control server did not expose a TCP address.");
    controlPort = address.port;
    return statusDocument();
  }

  function close(options = {}) {
    if (closePromise) return closePromise;
    shuttingDown = true;
    const serverClose = server.listening
      ? new Promise((resolve) => server.close(resolve))
      : Promise.resolve();
    closePromise = (async () => {
      const active = state === "starting" || state === "capturing" || state === "stopping";
      await stopCapture(
        null,
        false,
        active
          ? {
              clean: false,
              code: options.code ?? "bridge-shutdown",
              message: options.message ?? "The local capture bridge shut down before the operator completed the capture.",
            }
          : undefined,
      ).catch(() => undefined);
      const terminalPayload = formatSse("status", statusDocument());
      for (const subscriber of [...subscribers]) closeSubscriber(subscriber, terminalPayload);
      server.closeIdleConnections?.();
      await serverClose;
    })();
    return closePromise;
  }

  return { listen, close, status: statusDocument, startCapture, stopCapture };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  const bridge = createCaptureBridge(options);
  const shutdown = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.on("uncaughtException", async (error) => {
    console.error(error);
    await bridge.close();
    process.exit(1);
  });
  process.on("unhandledRejection", async (error) => {
    console.error(error);
    await bridge.close();
    process.exit(1);
  });

  try {
    const status = await bridge.listen();
    console.log(JSON.stringify({
      type: "narrowslink-bridge-ready",
      controlUrl: `http://${status.control.host}:${status.control.port}`,
      token: options.tokenWasGenerated ? options.token : undefined,
      tokenSource: options.tokenWasGenerated ? "generated" : "provided",
      defaultUdp: status.defaults,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await bridge.close();
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && basename(fileURLToPath(import.meta.url)) === "capture-bridge.mjs"
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
