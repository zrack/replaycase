#!/usr/bin/env node

import { createSocket } from "node:dgram";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9_104;
const DEFAULT_RECORDS = 480;
const DEFAULT_INTERVAL_MS = 5;

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function parseDemoArguments(argv) {
  const options = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    records: DEFAULT_RECORDS,
    startIndex: 0,
    intervalMs: DEFAULT_INTERVAL_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    if (argument === "--host") options.host = value;
    else if (argument === "--port") options.port = integer(value, "Port", 1, 65_535);
    else if (argument === "--records") options.records = integer(value, "Record count", 1, 100_000);
    else if (argument === "--start-index") options.startIndex = integer(value, "Start index", 0, 99_999);
    else if (argument === "--interval-ms") options.intervalMs = integer(value, "Interval", 0, 60_000);
    else throw new Error(`Unknown option ${argument}.`);
    index += 1;
  }
  if (typeof options.host !== "string" || options.host.length === 0 || options.host.length > 253) {
    throw new Error("Host must be a non-empty hostname or IP address.");
  }
  return options;
}

function usage() {
  return `Replay the checked-in ReplayCase fixture as UDP datagrams

Usage: node scripts/send-demo-udp.mjs [options]

Options:
  --host <host>          UDP destination (default ${DEFAULT_HOST})
  --port <port>          UDP destination port (default ${DEFAULT_PORT})
  --records <count>      Datagrams to send (default ${DEFAULT_RECORDS})
  --start-index <index>  First fixture record (default 0)
  --interval-ms <ms>     Delay between datagrams (default ${DEFAULT_INTERVAL_MS})
  --help                 Show this message
`;
}

function delay(milliseconds) {
  return milliseconds === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function send(socket, bytes, port, host) {
  await new Promise((resolve, reject) => {
    socket.send(bytes, port, host, (error) => error ? reject(error) : resolve());
  });
}

export async function replayDemoUdp(options, onProgress = () => undefined) {
  const text = await readFile(new URL("../public/fixtures/harbor-relay-session.json", import.meta.url), "utf8");
  const document = JSON.parse(text);
  if (!Array.isArray(document.records)) throw new Error("The bundled fixture does not contain source records.");
  const selected = document.records.slice(options.startIndex, options.startIndex + options.records);
  if (selected.length === 0) throw new Error("The selected fixture range contains no records.");

  const socket = createSocket(options.host.includes(":") ? "udp6" : "udp4");
  let sentBytes = 0;
  try {
    for (const [position, record] of selected.entries()) {
      if (typeof record?.dataHex !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(record.dataHex)) {
        throw new Error(`Fixture record ${options.startIndex + position} does not contain valid hexadecimal bytes.`);
      }
      const bytes = Buffer.from(record.dataHex, "hex");
      await send(socket, bytes, options.port, options.host);
      sentBytes += bytes.length;
      if (position === 0 || (position + 1) % 100 === 0 || position + 1 === selected.length) {
        onProgress({ datagrams: position + 1, bytes: sentBytes });
      }
      if (position + 1 < selected.length) await delay(options.intervalMs);
    }
  } finally {
    socket.close();
  }
  return { datagrams: selected.length, bytes: sentBytes };
}

async function main() {
  let options;
  try {
    options = parseDemoArguments(process.argv.slice(2));
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
  console.log(`Sending fixture datagrams to udp://${options.host}:${options.port}…`);
  try {
    const result = await replayDemoUdp(options, (progress) => {
      console.log(`${progress.datagrams} datagrams · ${progress.bytes} bytes`);
    });
    console.log(`Finished: ${result.datagrams} datagrams · ${result.bytes} bytes`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
