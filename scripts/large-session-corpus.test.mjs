import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  generateLargeSession,
  LARGE_SESSION_ID,
  LARGE_SESSION_RANGE_TITLE,
  LARGE_SESSION_TITLE,
} from "./large-session-corpus.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )),
  );
});

describe("large-session acceptance corpus", () => {
  it("streams deterministic canonical evidence with bounded ranges", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replaycase-large-session-"));
    temporaryDirectories.push(directory);
    const firstPath = join(directory, "first.nlsession");
    const secondPath = join(directory, "second.nlsession");

    const first = await generateLargeSession(firstPath, 3);
    const second = await generateLargeSession(secondPath, 3);
    const firstBytes = await readFile(firstPath);
    const secondBytes = await readFile(secondPath);
    const document = JSON.parse(firstBytes.toString("utf8"));

    expect(firstBytes.equals(secondBytes)).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    expect(first.sha256).toBe(createHash("sha256").update(firstBytes).digest("hex"));
    expect(first.records).toBe(3);
    expect(first.bytes).toBe(firstBytes.byteLength);
    expect(document).toMatchObject({
      format: "narrowslink/session",
      formatVersion: 1,
      id: LARGE_SESSION_ID,
      title: LARGE_SESSION_TITLE,
      incidents: [{
        title: LARGE_SESSION_RANGE_TITLE,
        startUs: 2_999,
        endUs: 3_001,
      }],
    });
    expect(document.records).toHaveLength(3);
    expect(document.records.map((record) => record.index)).toEqual([0, 1, 2]);
    expect(firstBytes.at(-1)).toBe(0x0a);
  });
});
