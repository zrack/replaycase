import { describe, expect, it } from "vitest";

import {
  loadReceiverNotes,
  MAX_RECEIVER_NOTES_LENGTH,
  saveReceiverNotes,
  type ReceiverStorageLike,
} from "./receiver-storage";

function memoryStorage(): ReceiverStorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

const bundleHash = "a".repeat(64);

describe("receiver workspace notes", () => {
  it("reopens findings under the pre-rename storage key without copying or rewriting them", () => {
    const key = `narrowslink:receiver-workspace:v1:${bundleHash}`;
    const raw = JSON.stringify({ version: 1, text: "Legacy receiver finding", updatedAt: "2026-07-25T12:00:00.000Z" });
    const storage = memoryStorage();
    storage.setItem(key, raw);
    expect(loadReceiverNotes(bundleHash, storage).text).toBe("Legacy receiver finding");
    expect(storage.getItem(key)).toBe(raw);
    expect(storage.getItem(`replaycase:receiver-workspace:v1:${bundleHash}`)).toBeNull();
  });

  it("persists findings by immutable bundle identity, separate from bundle bytes", () => {
    const storage = memoryStorage();

    expect(saveReceiverNotes(bundleHash, "Receiver finding", storage)).toBe(true);
    expect(loadReceiverNotes(bundleHash, storage)).toMatchObject({
      text: "Receiver finding",
      storageAvailable: true,
    });
    expect(loadReceiverNotes("b".repeat(64), storage)).toEqual({
      text: "",
      updatedAt: null,
      storageAvailable: true,
    });
  });

  it("rejects invalid identities, oversized notes, and storage failures", () => {
    const failingStorage: ReceiverStorageLike = {
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
      removeItem: () => undefined,
    };

    expect(saveReceiverNotes("not-a-hash", "finding", memoryStorage())).toBe(false);
    expect(saveReceiverNotes(bundleHash, "x".repeat(MAX_RECEIVER_NOTES_LENGTH + 1), memoryStorage())).toBe(false);
    expect(saveReceiverNotes(bundleHash, "finding", failingStorage)).toBe(false);
    expect(loadReceiverNotes(bundleHash, {
      ...failingStorage,
      getItem: () => { throw new Error("blocked"); },
    })).toEqual({
      text: "",
      updatedAt: null,
      storageAvailable: false,
    });
  });
});
