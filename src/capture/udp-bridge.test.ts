import { createSocket } from "node:dgram";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeUdpDatagram,
  normalizeUdpBridgeUrl,
  parseUdpBridgeDatagram,
  parseUdpBridgeStatus,
  UdpBridgeClient,
  type UdpBridgeDatagram,
  type UdpCaptureLifecycleJournal,
} from "./udp-bridge";

const TOKEN = "test-token-with-enough-entropy-1234";
const LOOPBACK_ORIGIN = "http://127.0.0.1:5173";
const CAPTURE_LEASE = "private-capture-lease-with-enough-entropy";

function capturePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "capture-owned-by-client-a",
    startedAt: "2026-07-16T00:00:00.000Z",
    datagrams: 0,
    bytes: 0,
    durationUs: 0,
    ...overrides,
  };
}

function captureJournalPayload(overrides: Record<string, unknown> = {}) {
  return {
    captureId: "capture-owned-by-client-a",
    startedAt: "2026-07-16T00:00:00.000Z",
    endedAt: null,
    state: "active",
    bind: {
      requestedHost: "127.0.0.1",
      requestedPort: 9_104,
      host: "127.0.0.1",
      port: 9_104,
      family: "IPv4",
    },
    multicast: null,
    datagrams: 0,
    bytes: 0,
    kernelDroppedDatagrams: null,
    kernelDroppedDatagramsSource: "unavailable",
    entriesComplete: true,
    omittedEntries: 0,
    entries: [{
      sequence: 0,
      type: "capture-started",
      at: "2026-07-16T00:00:00.000Z",
      offsetUs: 0,
      datagrams: 0,
      bytes: 0,
    }],
    ...overrides,
  };
}

function statusPayload(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    state: "idle",
    control: { host: "127.0.0.1", port: 47_891 },
    defaults: {
      host: "127.0.0.1",
      port: 9_104,
      multicastGroup: null,
      multicastInterface: null,
    },
    udp: null,
    multicast: null,
    capture: null,
    captureJournal: null,
    subscribers: 1,
    lastError: null,
    ...overrides,
  };
}

class FakeEventSource {
  readonly listeners = new Map<string, Array<(event: MessageEvent<string> | Event) => void>>();
  closed = false;

  addEventListener(type: string, listener: (event: MessageEvent<string> | Event) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, value: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(value) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("UDP bridge browser protocol", () => {
  it("accepts only loopback bridge locations", () => {
    expect(normalizeUdpBridgeUrl("http://127.0.0.1:47891/")).toBe("http://127.0.0.1:47891");
    expect(normalizeUdpBridgeUrl("http://localhost:47891/")).toBe("http://localhost:47891");
    expect(() => normalizeUdpBridgeUrl("https://127.0.0.1:47891/")).toThrow("must use HTTP on a loopback host");
    expect(() => normalizeUdpBridgeUrl("http://telemetry.example:47891/")).toThrow("must use HTTP on a loopback host");
    expect(() => normalizeUdpBridgeUrl("http://operator@127.0.0.1:47891/")).toThrow("must use HTTP on a loopback host");
  });

  it("decodes every datagram byte without text transcoding", () => {
    const bytes = Uint8Array.from([0x00, 0x7f, 0x80, 0xff, 0xa5, 0x5a]);
    const encoded = Buffer.from(bytes).toString("base64");
    expect(decodeUdpDatagram(encoded, bytes.length)).toEqual(bytes);
    expect(decodeUdpDatagram("", 0)).toEqual(new Uint8Array());
    expect(() => decodeUdpDatagram(encoded, bytes.length - 1)).toThrow("does not match");
  });

  it("rejects malformed or unsupported bridge messages", () => {
    expect(() => parseUdpBridgeStatus(statusPayload({ protocolVersion: 2 }))).toThrow("unsupported protocol");
    expect(() => parseUdpBridgeStatus(statusPayload({ control: { host: "0.0.0.0", port: 47_891 } }))).toThrow("not bound to loopback");
    expect(() => parseUdpBridgeDatagram({
      protocolVersion: 1,
      captureId: "capture-1",
      sequence: 0,
      offsetUs: 1,
      receivedAt: "2026-07-16T00:00:00.000Z",
      remoteAddress: "127.0.0.1",
      remotePort: 9_105,
      remoteFamily: "IPv4",
      byteLength: 2,
      dataBase64: "AA==",
    })).toThrow("does not match");
  });

  it("validates a bounded immutable capture lifecycle journal without losing endpoint provenance", () => {
    const endedAt = "2026-07-16T00:00:01.000Z";
    const capture = capturePayload({ endedAt, datagrams: 1, bytes: 4, durationUs: 1_000_000 });
    const journal = captureJournalPayload({
      endedAt,
      state: "clean",
      datagrams: 1,
      bytes: 4,
      entries: [
        {
          sequence: 0,
          type: "capture-started",
          at: "2026-07-16T00:00:00.000Z",
          offsetUs: 0,
          datagrams: 0,
          bytes: 0,
        },
        {
          sequence: 1,
          type: "capture-stopped",
          at: endedAt,
          offsetUs: 1_000_000,
          datagrams: 1,
          bytes: 4,
        },
      ],
    });
    const parsed = parseUdpBridgeStatus(statusPayload({
      state: "stopped",
      udp: { host: "127.0.0.1", port: 9_104, family: "IPv4" },
      capture,
      captureJournal: journal,
    }));
    const parsedJournal = parsed.captureJournal as UdpCaptureLifecycleJournal;
    expect(parsedJournal).toMatchObject({
      captureId: "capture-owned-by-client-a",
      state: "clean",
      datagrams: 1,
      bytes: 4,
      kernelDroppedDatagrams: null,
      kernelDroppedDatagramsSource: "unavailable",
      entriesComplete: true,
      omittedEntries: 0,
    });
    expect(Object.isFrozen(parsedJournal)).toBe(true);
    expect(Object.isFrozen(parsedJournal.bind)).toBe(true);
    expect(Object.isFrozen(parsedJournal.entries)).toBe(true);
    expect(Object.isFrozen(parsedJournal.entries[0])).toBe(true);

    const datagram = parseUdpBridgeDatagram({
      protocolVersion: 1,
      captureId: "capture-owned-by-client-a",
      sequence: 0,
      offsetUs: 42,
      receivedAt: "2026-07-16T00:00:00.000Z",
      remoteAddress: "2001:db8::42",
      remotePort: 55_555,
      remoteFamily: "IPv6",
      byteLength: 4,
      dataBase64: "AID/pQ==",
    });
    expect(datagram).toMatchObject({
      remoteAddress: "2001:db8::42",
      remotePort: 55_555,
      remoteFamily: "IPv6",
    });
  });

  it("rejects unbounded or contradictory capture lifecycle journals", () => {
    const tooManyEntries = Array.from({ length: 129 }, (_, sequence) => ({
      sequence,
      type: sequence === 0 ? "capture-started" : "bridge-error",
      at: "2026-07-16T00:00:00.000Z",
      offsetUs: sequence,
      datagrams: 0,
      bytes: 0,
      ...(sequence === 0 ? {} : { code: "test-error", message: "bounded error", fatal: false }),
    }));
    expect(() => parseUdpBridgeStatus(statusPayload({
      state: "capturing",
      udp: { host: "127.0.0.1", port: 9_104, family: "IPv4" },
      capture: capturePayload(),
      captureJournal: captureJournalPayload({
        state: "incomplete",
        entriesComplete: false,
        omittedEntries: 1,
        entries: tooManyEntries,
      }),
    }))).toThrow("bounded lifecycle entry list");

    expect(() => parseUdpBridgeStatus(statusPayload({
      state: "capturing",
      udp: { host: "127.0.0.1", port: 9_104, family: "IPv4" },
      capture: capturePayload({ datagrams: 1, bytes: 4 }),
      captureJournal: captureJournalPayload(),
    }))).toThrow("terminal counters do not match");

    expect(() => parseUdpBridgeStatus(statusPayload({
      state: "capturing",
      udp: { host: "127.0.0.1", port: 9_104, family: "IPv4" },
      capture: capturePayload(),
      captureJournal: captureJournalPayload({
        kernelDroppedDatagrams: 0,
        kernelDroppedDatagramsSource: "estimated",
      }),
    }))).toThrow("kernel drop counter source is unsupported");

    const endedAt = "2026-07-16T00:00:01.000Z";
    expect(() => parseUdpBridgeStatus(statusPayload({
      state: "stopped",
      udp: { host: "127.0.0.1", port: 9_104, family: "IPv4" },
      capture: capturePayload({ endedAt, durationUs: 1_000_000 }),
      captureJournal: captureJournalPayload({
        endedAt,
        state: "clean",
        entries: [
          {
            sequence: 0,
            type: "capture-started",
            at: "2026-07-16T00:00:00.000Z",
            offsetUs: 0,
            datagrams: 0,
            bytes: 0,
          },
          {
            sequence: 1,
            type: "bridge-error",
            at: "2026-07-16T00:00:00.500Z",
            offsetUs: 500_000,
            datagrams: 0,
            bytes: 0,
            code: "udp-socket-error",
            message: "socket failed",
            fatal: true,
          },
          {
            sequence: 2,
            type: "capture-stopped",
            at: endedAt,
            offsetUs: 1_000_000,
            datagrams: 0,
            bytes: 0,
          },
        ],
      }),
    }))).toThrow("cannot contain capture-path error evidence");
  });

  it("rejects malformed capture configuration before making a request", async () => {
    const source = new FakeEventSource();
    const fetchImpl = vi.fn();
    const client = new UdpBridgeClient({ token: TOKEN, fetchImpl, eventSourceFactory: () => source });
    const startPromise = client.start({ host: "127.0.0.1", port: 70_000 });
    source.emit("hello", statusPayload());
    await expect(startPromise).rejects.toMatchObject({ code: "invalid-bind-port" });
    expect(fetchImpl).not.toHaveBeenCalled();
    client.disconnect();
  });

  it("uses the same-origin proxy without exposing a token in URLs, headers, or credentials", async () => {
    const source = new FakeEventSource();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(init?.credentials).toBe("same-origin");
      expect(new URL(String(input)).pathname).toBe("/v1/status");
      return new Response(JSON.stringify(statusPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    let eventUrl = "";
    let eventSourceInit: EventSourceInit | undefined;
    const client = new UdpBridgeClient({
      authentication: { mode: "same-origin-proxy" },
      baseUrl: "http://127.0.0.1:49123",
      fetchImpl,
      eventSourceFactory: (url, init) => {
        eventUrl = url;
        eventSourceInit = init;
        return source;
      },
    });

    const connectPromise = client.connect();
    source.emit("hello", statusPayload());
    await expect(connectPromise).resolves.toMatchObject({ state: "idle" });
    expect(eventUrl).toBe("http://127.0.0.1:49123/v1/events");
    expect(eventSourceInit).toBeUndefined();
    await expect(client.getStatus()).resolves.toMatchObject({ state: "idle" });
    client.disconnect();
  });

  it("validates multicast groups, interfaces, and IP-family consistency", async () => {
    const makeClient = () => {
      const source = new FakeEventSource();
      const fetchImpl = vi.fn();
      const client = new UdpBridgeClient({ token: TOKEN, fetchImpl, eventSourceFactory: () => source });
      return { source, fetchImpl, client };
    };

    const unicastGroup = makeClient();
    const unicastPromise = unicastGroup.client.start({
      host: "0.0.0.0",
      port: 9_104,
      multicastGroup: "127.0.0.1",
    });
    unicastGroup.source.emit("hello", statusPayload());
    await expect(unicastPromise).rejects.toMatchObject({ code: "invalid-multicast-group" });
    expect(unicastGroup.fetchImpl).not.toHaveBeenCalled();
    unicastGroup.client.disconnect();

    const mixedFamily = makeClient();
    const mixedPromise = mixedFamily.client.start({
      host: "0.0.0.0",
      port: 9_104,
      multicastGroup: "239.255.42.99",
      multicastInterface: "::1",
    });
    mixedFamily.source.emit("hello", statusPayload());
    await expect(mixedPromise).rejects.toMatchObject({ code: "multicast-family-mismatch" });
    expect(mixedFamily.fetchImpl).not.toHaveBeenCalled();
    mixedFamily.client.disconnect();
  });

  it("subscribes before start, authenticates control requests, and emits exact bytes", async () => {
    const source = new FakeEventSource();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      expect(authorization).toBe(`Bearer ${TOKEN}`);
      const path = new URL(String(input)).pathname;
      if (path === "/v1/start") {
        expect(JSON.parse(String(init?.body))).toEqual({
          host: "0.0.0.0",
          port: 9_104,
          multicastGroup: "239.255.42.99",
          multicastInterface: "127.0.0.1",
          requestNonce: expect.stringMatching(/^[0-9a-f]{48}$/),
        });
        return new Response(JSON.stringify({
          protocolVersion: 1,
          status: statusPayload({
            state: "capturing",
            udp: { host: "0.0.0.0", port: 9_104, family: "IPv4" },
            multicast: { group: "239.255.42.99", interface: "127.0.0.1", family: "IPv4" },
            capture: capturePayload(),
          }),
          lease: CAPTURE_LEASE,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      expect(path).toBe("/v1/stop");
      expect(JSON.parse(String(init?.body))).toEqual({
        captureId: "capture-owned-by-client-a",
        lease: CAPTURE_LEASE,
      });
      return new Response(JSON.stringify(statusPayload({
        state: "stopped",
        udp: { host: "0.0.0.0", port: 9_104, family: "IPv4" },
        capture: capturePayload({
          endedAt: "2026-07-16T00:00:01.000Z",
          datagrams: 1,
          bytes: 4,
          durationUs: 1_000_000,
        }),
      })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const datagrams: UdpBridgeDatagram[] = [];
    let eventUrl = "";
    const client = new UdpBridgeClient({
      token: TOKEN,
      fetchImpl,
      eventSourceFactory: (url) => {
        eventUrl = url;
        return source;
      },
      onDatagram: (datagram) => datagrams.push(datagram),
    });

    const startPromise = client.start({
      host: "0.0.0.0",
      port: 9_104,
      multicastGroup: "239.255.42.99",
      multicastInterface: "127.0.0.1",
    });
    expect(eventUrl).toContain(`/v1/events?token=${encodeURIComponent(TOKEN)}`);
    source.emit("hello", statusPayload());
    await expect(startPromise).resolves.toMatchObject({
      state: "capturing",
      multicast: { group: "239.255.42.99", interface: "127.0.0.1", family: "IPv4" },
    });

    source.emit("datagram", {
      protocolVersion: 1,
      captureId: "capture-1",
      sequence: 0,
      offsetUs: 42,
      receivedAt: "2026-07-16T00:00:00.000Z",
      remoteAddress: "127.0.0.1",
      remotePort: 55_555,
      remoteFamily: "IPv4",
      byteLength: 4,
      dataBase64: "AID/pQ==",
    });
    expect(datagrams).toHaveLength(1);
    expect(datagrams[0]?.data).toEqual(Uint8Array.from([0x00, 0x80, 0xff, 0xa5]));
    await expect(client.stop()).resolves.toMatchObject({
      state: "stopped",
      capture: { id: "capture-owned-by-client-a", datagrams: 1, bytes: 4 },
    });
    await expect(client.stop()).rejects.toMatchObject({ code: "capture-not-owned" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    client.disconnect();
    expect(source.closed).toBe(true);
  });

  it("never adopts ownership from an active-capture hello", async () => {
    const source = new FakeEventSource();
    const fetchImpl = vi.fn();
    const client = new UdpBridgeClient({ token: TOKEN, fetchImpl, eventSourceFactory: () => source });
    const connectPromise = client.connect();
    source.emit("hello", statusPayload({
      state: "capturing",
      udp: { host: "127.0.0.1", port: 9_104, family: "IPv4" },
      capture: capturePayload({ id: "foreign-active-capture" }),
    }));
    await expect(connectPromise).resolves.toMatchObject({ state: "capturing" });
    await expect(client.stop()).rejects.toMatchObject({ code: "capture-not-owned" });
    expect(fetchImpl).not.toHaveBeenCalled();
    client.disconnect();
  });

  it("reuses its private start nonce in a replacement client after a lost response", async () => {
    const firstSource = new FakeEventSource();
    const observedNonces: string[] = [];
    let startAttempts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/start") {
        const body = JSON.parse(String(init?.body)) as { requestNonce: string };
        observedNonces.push(body.requestNonce);
        startAttempts += 1;
        if (startAttempts === 1) throw new TypeError("The start response was lost locally.");
        return new Response(JSON.stringify({
          protocolVersion: 1,
          status: statusPayload({
            state: "capturing",
            udp: { host: "127.0.0.1", port: 9_104, family: "IPv4" },
            capture: capturePayload({ id: "recovered-capture" }),
          }),
          lease: CAPTURE_LEASE,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (path === "/v1/status") {
        return new Response(JSON.stringify(statusPayload({
          state: "capturing",
          udp: { host: "127.0.0.1", port: 9_104, family: "IPv4" },
          capture: capturePayload({ id: "recovered-capture" }),
        })), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      expect(path).toBe("/v1/stop");
      return new Response(JSON.stringify(statusPayload({
        state: "stopped",
        udp: { host: "127.0.0.1", port: 9_104, family: "IPv4" },
        capture: capturePayload({
          id: "recovered-capture",
          endedAt: "2026-07-16T00:00:01.000Z",
        }),
      })), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const recoveryToken = `${TOKEN}-recovery`;
    const firstClient = new UdpBridgeClient({ token: recoveryToken, fetchImpl, eventSourceFactory: () => firstSource });
    const firstStart = firstClient.start({ host: "127.0.0.1", port: 9_104 });
    firstSource.emit("hello", statusPayload());
    await expect(firstStart).rejects.toMatchObject({ code: "bridge-unreachable" });
    firstClient.disconnect();

    const replacementSource = new FakeEventSource();
    const replacementClient = new UdpBridgeClient({
      token: recoveryToken,
      fetchImpl,
      eventSourceFactory: () => replacementSource,
    });
    const recoveredStart = replacementClient.start({ host: "127.0.0.1", port: 9_104 });
    replacementSource.emit("hello", statusPayload({
      state: "capturing",
      udp: { host: "127.0.0.1", port: 9_104, family: "IPv4" },
      capture: capturePayload({ id: "recovered-capture" }),
    }));
    await expect(recoveredStart).resolves.toMatchObject({
      state: "capturing",
      capture: { id: "recovered-capture" },
    });
    expect(observedNonces).toHaveLength(2);
    expect(observedNonces[0]).toBe(observedNonces[1]);
    await expect(replacementClient.stop()).resolves.toMatchObject({ state: "stopped" });
    replacementClient.disconnect();
  });

  it("preserves ambiguous recovery while active but releases stale settings once idle", async () => {
    const source = new FakeEventSource();
    const nonces: string[] = [];
    let startAttempts = 0;
    let refreshedStatus = statusPayload();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/start") {
        const body = JSON.parse(String(init?.body)) as { requestNonce: string };
        nonces.push(body.requestNonce);
        startAttempts += 1;
        if (startAttempts === 1) throw new TypeError("Ambiguous local start failure.");
        return new Response(JSON.stringify({
          protocolVersion: 1,
          status: statusPayload({
            state: "capturing",
            udp: { host: "127.0.0.1", port: 9_104, family: "IPv4" },
            capture: capturePayload({ id: "replacement-after-idle" }),
          }),
          lease: CAPTURE_LEASE,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (path === "/v1/status") {
        return new Response(JSON.stringify(refreshedStatus), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(statusPayload({
        state: "stopped",
        udp: { host: "127.0.0.1", port: 9_104, family: "IPv4" },
        capture: capturePayload({ id: "replacement-after-idle", endedAt: "2026-07-16T00:00:01.000Z" }),
      })), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new UdpBridgeClient({
      token: `${TOKEN}-stale-ambiguity`,
      fetchImpl,
      eventSourceFactory: () => source,
    });
    const firstStart = client.start({ host: "127.0.0.1", port: 9_104 });
    source.emit("hello", statusPayload());
    await expect(firstStart).rejects.toMatchObject({ code: "bridge-unreachable" });

    refreshedStatus = statusPayload({
      state: "capturing",
      udp: { host: "127.0.0.1", port: 9_104, family: "IPv4" },
      capture: capturePayload({ id: "possibly-owned-active-capture" }),
    });
    source.emit("status", refreshedStatus);
    await expect(client.start({ host: "127.0.0.1", port: 9_105 })).rejects.toMatchObject({
      code: "start-recovery-options-mismatch",
    });
    expect(startAttempts).toBe(1);

    refreshedStatus = statusPayload();
    source.emit("status", refreshedStatus);
    await expect(client.start({ host: "127.0.0.1", port: 9_104 })).resolves.toMatchObject({
      capture: { id: "replacement-after-idle" },
    });
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
    await client.stop();
    client.disconnect();
  });

  it("clears a definitive bind-port rejection so the operator can correct it", async () => {
    const source = new FakeEventSource();
    const nonces: string[] = [];
    let startAttempts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/start") {
        const body = JSON.parse(String(init?.body)) as { requestNonce: string };
        nonces.push(body.requestNonce);
        startAttempts += 1;
        if (startAttempts === 1) {
          return new Response(JSON.stringify({ code: "invalid-bind-port", message: "The selected UDP port is unavailable." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          protocolVersion: 1,
          status: statusPayload({
            state: "capturing",
            udp: { host: "127.0.0.1", port: 9_105, family: "IPv4" },
            capture: capturePayload({ id: "corrected-port-capture" }),
          }),
          lease: CAPTURE_LEASE,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(statusPayload({
        state: "stopped",
        udp: { host: "127.0.0.1", port: 9_105, family: "IPv4" },
        capture: capturePayload({ id: "corrected-port-capture", endedAt: "2026-07-16T00:00:01.000Z" }),
      })), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new UdpBridgeClient({
      token: `${TOKEN}-port-correction`,
      fetchImpl,
      eventSourceFactory: () => source,
    });
    const rejectedStart = client.start({ host: "127.0.0.1", port: 9_104 });
    source.emit("hello", statusPayload());
    await expect(rejectedStart).rejects.toMatchObject({ code: "invalid-bind-port" });
    source.emit("status", statusPayload({
      state: "capturing",
      udp: { host: "127.0.0.1", port: 9_104, family: "IPv4" },
      capture: capturePayload({ id: "unrelated-active-status" }),
    }));
    await expect(client.start({ host: "127.0.0.1", port: 9_105 })).resolves.toMatchObject({
      capture: { id: "corrected-port-capture" },
    });
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
    await client.stop();
    client.disconnect();
  });

  it("releases local ownership when status confirms a lost stop response already succeeded", async () => {
    const source = new FakeEventSource();
    let startCount = 0;
    let stopCount = 0;
    let statusGetCount = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/start") {
        startCount += 1;
        const id = startCount === 1 ? "capture-before-lost-stop" : "capture-after-lost-stop";
        const port = startCount === 1 ? 9_104 : 9_105;
        return new Response(JSON.stringify({
          protocolVersion: 1,
          status: statusPayload({
            state: "capturing",
            udp: { host: "127.0.0.1", port, family: "IPv4" },
            capture: capturePayload({ id }),
          }),
          lease: `${CAPTURE_LEASE}-${startCount}`,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (path === "/v1/status") {
        statusGetCount += 1;
        return new Response(JSON.stringify(statusPayload({
          state: statusGetCount === 1 ? "stopped" : "capturing",
          udp: { host: "127.0.0.1", port: statusGetCount === 1 ? 9_104 : 9_105, family: "IPv4" },
          capture: capturePayload(statusGetCount === 1
            ? { id: "capture-before-lost-stop", endedAt: "2026-07-16T00:00:01.000Z" }
            : { id: "other-visible-capture" }),
        })), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      stopCount += 1;
      if (stopCount === 1) throw new TypeError("The successful stop response was lost.");
      return new Response(JSON.stringify(statusPayload({
        state: "stopped",
        udp: { host: "127.0.0.1", port: 9_105, family: "IPv4" },
        capture: capturePayload({ id: "capture-after-lost-stop", endedAt: "2026-07-16T00:00:02.000Z" }),
      })), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new UdpBridgeClient({
      token: `${TOKEN}-lost-stop`,
      fetchImpl,
      eventSourceFactory: () => source,
    });
    const firstStart = client.start({ host: "127.0.0.1", port: 9_104 });
    source.emit("hello", statusPayload());
    await firstStart;
    await expect(client.stop()).rejects.toMatchObject({ code: "bridge-unreachable" });
    await expect(client.getStatus()).resolves.toMatchObject({
      state: "stopped",
      capture: { id: "capture-before-lost-stop" },
    });
    await expect(client.stop()).rejects.toMatchObject({ code: "capture-not-owned" });

    source.emit("status", statusPayload({
      state: "capturing",
      udp: { host: "127.0.0.1", port: 9_105, family: "IPv4" },
      capture: capturePayload({ id: "other-visible-capture" }),
    }));
    await expect(client.start({ host: "127.0.0.1", port: 9_105 })).resolves.toMatchObject({
      capture: { id: "capture-after-lost-stop" },
    });
    expect(statusGetCount).toBe(1);
    await client.stop();
    client.disconnect();
  });
});

interface ReadyLine {
  type: "narrowslink-bridge-ready";
  controlUrl: string;
}

function parseStartEnvelope(input: unknown): { status: ReturnType<typeof parseUdpBridgeStatus>; lease: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Malformed bridge start envelope.");
  }
  const record = input as Record<string, unknown>;
  if (record.protocolVersion !== 1 || typeof record.lease !== "string" || record.lease.length < 16) {
    throw new Error("Bridge start envelope is missing its private lease.");
  }
  return { status: parseUdpBridgeStatus(record.status), lease: record.lease };
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<ReadyLine> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    // Parallel CI can spend several seconds scheduling a fresh Node process
    // while the fixture-heavy suites are decoding. Keep the assertion bounded
    // without treating ordinary runner contention as a bridge failure.
    const timeout = setTimeout(() => reject(new Error(`Bridge startup timed out: ${stderr}`)), 15_000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const lineEnd = stdout.indexOf("\n");
      if (lineEnd < 0) return;
      try {
        const parsed = JSON.parse(stdout.slice(0, lineEnd)) as ReadyLine;
        clearTimeout(timeout);
        resolve(parsed);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Bridge exited before ready with code ${code}: ${stderr}`));
    });
  });
}

async function readSseEvent(response: Response, eventName: string, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("SSE response did not include a body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (event === eventName && data) return JSON.parse(data) as unknown;
      boundary = buffer.indexOf("\n\n");
    }
  }
  throw new Error(`SSE stream ended before ${eventName}.`);
}

describe("local UDP capture bridge", () => {
  let child: ChildProcessWithoutNullStreams | null = null;

  afterEach(async () => {
    if (!child || child.killed) return;
    await new Promise<void>((resolve) => {
      child?.once("exit", () => resolve());
      child?.kill("SIGTERM");
      setTimeout(resolve, 1_000);
    });
    child = null;
  });

  it("enforces capture ownership and forwards an exact zero-length UDP datagram", async () => {
    const script = fileURLToPath(new URL("../../scripts/capture-bridge.mjs", import.meta.url));
    child = spawn(process.execPath, [script, "--control-port", "0", "--udp-port", "0", "--token", TOKEN], {
      env: { ...process.env, REPLAYCASE_BRIDGE_TOKEN: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ready = await waitForReady(child);

    const unauthorized = await fetch(`${ready.controlUrl}/v1/status`, { headers: { Origin: LOOPBACK_ORIGIN } });
    expect(unauthorized.status).toBe(401);
    const hostileOrigin = await fetch(`${ready.controlUrl}/v1/status`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: "https://attacker.example" },
    });
    expect(hostileOrigin.status).toBe(403);

    const abortController = new AbortController();
    const eventsResponse = await fetch(`${ready.controlUrl}/v1/events?token=${encodeURIComponent(TOKEN)}`, {
      headers: { Origin: LOOPBACK_ORIGIN },
      signal: abortController.signal,
    });
    expect(eventsResponse.status).toBe(200);
    const datagramEvent = readSseEvent(eventsResponse, "datagram", abortController.signal);

    const invalidMulticast = await fetch(`${ready.controlUrl}/v1/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Origin: LOOPBACK_ORIGIN,
      },
      body: JSON.stringify({
        host: "0.0.0.0",
        port: 0,
        multicastGroup: "127.0.0.1",
        requestNonce: "invalid-multicast-check-nonce-0001",
      }),
    });
    expect(invalidMulticast.status).toBe(400);
    await expect(invalidMulticast.json()).resolves.toMatchObject({ code: "invalid-multicast-group" });

    const startRequestNonce = "client-a-idempotent-start-nonce-0001";
    const startRequestBody = JSON.stringify({
      host: "127.0.0.1",
      port: 0,
      requestNonce: startRequestNonce,
    });
    const discardedStartResponse = await fetch(`${ready.controlUrl}/v1/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Origin: LOOPBACK_ORIGIN,
      },
      body: startRequestBody,
    });
    expect(discardedStartResponse.status).toBe(200);
    await discardedStartResponse.body?.cancel();
    const statusAfterDiscardedResponse = await fetch(`${ready.controlUrl}/v1/status`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: LOOPBACK_ORIGIN },
    });
    const captureBeforeRecovery = parseUdpBridgeStatus(await statusAfterDiscardedResponse.json());
    expect(captureBeforeRecovery).toMatchObject({ state: "capturing", capture: { datagrams: 0, bytes: 0 } });
    expect(captureBeforeRecovery.captureJournal).toMatchObject({
      captureId: captureBeforeRecovery.capture?.id,
      state: "active",
      bind: {
        requestedHost: "127.0.0.1",
        requestedPort: 0,
        host: "127.0.0.1",
        family: "IPv4",
      },
      multicast: null,
      datagrams: 0,
      bytes: 0,
      entriesComplete: true,
      omittedEntries: 0,
      entries: [{ type: "capture-started", sequence: 0, offsetUs: 0, datagrams: 0, bytes: 0 }],
    });
    expect(captureBeforeRecovery.captureJournal?.kernelDroppedDatagrams).toBeNull();
    expect(captureBeforeRecovery.captureJournal?.kernelDroppedDatagramsSource).toMatch(/^unavailable-/);
    expect(JSON.stringify(captureBeforeRecovery)).not.toContain(startRequestNonce);

    const recoveredStartResponse = await fetch(`${ready.controlUrl}/v1/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Origin: LOOPBACK_ORIGIN,
      },
      body: startRequestBody,
    });
    expect(recoveredStartResponse.status).toBe(200);
    const ownedStart = parseStartEnvelope(await recoveredStartResponse.json());
    const started = ownedStart.status;
    expect(started.capture?.id).toBe(captureBeforeRecovery.capture?.id);
    expect(started.udp?.port).toBeGreaterThan(0);

    const foreignStart = await fetch(`${ready.controlUrl}/v1/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Origin: LOOPBACK_ORIGIN,
      },
      body: JSON.stringify({
        host: "127.0.0.1",
        port: 0,
        requestNonce: "foreign-client-start-nonce-0000001",
      }),
    });
    expect(foreignStart.status).toBe(409);
    await expect(foreignStart.json()).resolves.toMatchObject({ code: "capture-active" });

    const foreignStop = await fetch(`${ready.controlUrl}/v1/stop`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Origin: LOOPBACK_ORIGIN,
      },
      body: JSON.stringify({
        captureId: started.capture?.id,
        lease: "foreign-client-lease-with-enough-length",
      }),
    });
    expect(foreignStop.status).toBe(409);
    await expect(foreignStop.json()).resolves.toMatchObject({ code: "capture-not-owned" });
    const statusAfterForeignStop = await fetch(`${ready.controlUrl}/v1/status`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: LOOPBACK_ORIGIN },
    });
    const visibleStatus = await statusAfterForeignStop.json() as Record<string, unknown>;
    expect(visibleStatus).not.toHaveProperty("lease");
    expect(JSON.stringify(visibleStatus)).not.toContain(ownedStart.lease);
    expect(parseUdpBridgeStatus(visibleStatus)).toMatchObject({
      state: "capturing",
      capture: { id: started.capture?.id, datagrams: 0, bytes: 0 },
    });

    const payload = Buffer.alloc(0);
    const sender = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      sender.send(payload, started.udp?.port ?? 0, "127.0.0.1", (error) => error ? reject(error) : resolve());
    });
    sender.close();

    const received = parseUdpBridgeDatagram(await datagramEvent);
    expect(received.data).toEqual(Uint8Array.from(payload));
    expect(received.byteLength).toBe(payload.length);
    expect(received.captureId).toBe(started.capture?.id);
    expect(received).toMatchObject({
      remoteAddress: "127.0.0.1",
      remotePort: expect.any(Number),
      remoteFamily: "IPv4",
    });

    const stopResponse = await fetch(`${ready.controlUrl}/v1/stop`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Origin: LOOPBACK_ORIGIN,
      },
      body: JSON.stringify({ captureId: started.capture?.id, lease: ownedStart.lease }),
    });
    expect(stopResponse.status).toBe(200);
    const stopped = parseUdpBridgeStatus(await stopResponse.json());
    expect(stopped).toMatchObject({
      state: "stopped",
      capture: { id: started.capture?.id, datagrams: 1, bytes: 0 },
      captureJournal: {
        captureId: started.capture?.id,
        state: "clean",
        datagrams: 1,
        bytes: 0,
        entriesComplete: true,
        omittedEntries: 0,
        entries: [
          { sequence: 0, type: "capture-started", datagrams: 0, bytes: 0 },
          { sequence: 1, type: "capture-stopped", datagrams: 1, bytes: 0 },
        ],
      },
    });
    if (stopped.captureJournal?.kernelDroppedDatagrams === null) {
      expect(stopped.captureJournal.kernelDroppedDatagramsSource).toMatch(/^unavailable-/);
    } else {
      expect(stopped.captureJournal?.kernelDroppedDatagramsSource).toBe("linux-proc-net-udp-socket");
    }
    expect(stopped.captureJournal?.endedAt).toBe(stopped.capture?.endedAt);
    expect(stopped.capture?.durationUs).toBeGreaterThan(received.offsetUs);
    abortController.abort();
  }, 30_000);

  it("joins and leaves a portable IPv4 multicast group", async ({ skip }) => {
    const script = fileURLToPath(new URL("../../scripts/capture-bridge.mjs", import.meta.url));
    child = spawn(process.execPath, [script, "--control-port", "0", "--udp-port", "0", "--token", TOKEN], {
      env: { ...process.env, REPLAYCASE_BRIDGE_TOKEN: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ready = await waitForReady(child);
    const abortController = new AbortController();
    let sender = createSocket("udp4");
    try {
      const eventsResponse = await fetch(`${ready.controlUrl}/v1/events?token=${encodeURIComponent(TOKEN)}`, {
        headers: { Origin: LOOPBACK_ORIGIN },
        signal: abortController.signal,
      });
      expect(eventsResponse.status).toBe(200);
      const datagramEvent = readSseEvent(eventsResponse, "datagram", abortController.signal);

      const multicastGroup = "239.255.42.99";
      const multicastInterface = "127.0.0.1";
      const startResponse = await fetch(`${ready.controlUrl}/v1/start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Origin: LOOPBACK_ORIGIN,
        },
        body: JSON.stringify({
          host: "0.0.0.0",
          port: 0,
          multicastGroup,
          multicastInterface,
          requestNonce: "multicast-start-request-nonce-0001",
        }),
      });
      if (startResponse.status === 409) {
        const error = await startResponse.json() as { code?: string };
        if (error.code === "multicast-membership-failed") {
          skip("The local test environment does not expose a multicast-capable loopback interface.");
          return;
        }
      }
      expect(startResponse.status).toBe(200);
      const ownedStart = parseStartEnvelope(await startResponse.json());
      const started = ownedStart.status;
      expect(started.multicast).toEqual({
        group: multicastGroup,
        interface: multicastInterface,
        family: "IPv4",
      });

      await new Promise<void>((resolve, reject) => {
        sender.once("error", reject);
        sender.bind(0, multicastInterface, () => {
          sender.off("error", reject);
          resolve();
        });
      });
      sender.setMulticastInterface(multicastInterface);
      sender.setMulticastLoopback(true);
      sender.setMulticastTTL(1);
      const payload = Buffer.from([0xa5, 0x5a, 0x01, 0x31, 0x00, 0xff]);
      await new Promise<void>((resolve, reject) => {
        sender.send(payload, started.udp?.port ?? 0, multicastGroup, (error) => error ? reject(error) : resolve());
      });

      const received = parseUdpBridgeDatagram(await datagramEvent);
      expect(received.data).toEqual(Uint8Array.from(payload));

      const stopResponse = await fetch(`${ready.controlUrl}/v1/stop`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Origin: LOOPBACK_ORIGIN,
        },
        body: JSON.stringify({ captureId: started.capture?.id, lease: ownedStart.lease }),
      });
      expect(stopResponse.status).toBe(200);
      const stopped = parseUdpBridgeStatus(await stopResponse.json());
      expect(stopped).toMatchObject({
        state: "stopped",
        multicast: null,
        capture: { datagrams: 1, bytes: payload.length },
        captureJournal: {
          state: "clean",
          multicast: {
            group: multicastGroup,
            interface: multicastInterface,
            family: "IPv4",
          },
          datagrams: 1,
          bytes: payload.length,
        },
      });
      if (stopped.captureJournal?.kernelDroppedDatagrams === null) {
        expect(stopped.captureJournal.kernelDroppedDatagramsSource).toMatch(/^unavailable-/);
      } else {
        expect(stopped.captureJournal?.kernelDroppedDatagramsSource).toBe("linux-proc-net-udp-socket");
      }
    } finally {
      abortController.abort();
      try {
        sender.close();
      } catch {
        // A skipped environment may leave the sender unbound.
      }
    }
  }, 30_000);
});
