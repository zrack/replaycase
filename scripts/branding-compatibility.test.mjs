import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArguments } from "./capture-bridge.mjs";
import { NSL01_DECODER_PACK, NMEA0183_DECODER_PACK } from "../src/domain/decoder.ts";
import { SESSION_LIBRARY_DB_NAME } from "../src/storage/session-library.ts";
import { CAPTURE_PROFILE_STORAGE_KEY } from "../src/capture/capture-profile.ts";
import { EVIDENCE_BUNDLE_FORMAT, EVIDENCE_BUNDLE_MEDIA_TYPE } from "../src/domain/evidence-contract.ts";

afterEach(() => vi.unstubAllEnvs());

describe("ReplayCase branding compatibility", () => {
  it("preserves published built-in decoder identities and exact legacy fixture bytes", () => {
    expect(NSL01_DECODER_PACK.integrity.canonicalSha256)
      .toBe("58ea407d6d70532b39085d0f26628e134560c4bd83dfb6c886c6f40b6fdd0d13");
    expect(NMEA0183_DECODER_PACK.integrity.canonicalSha256)
      .toBe("b53b97d6a4454ce44136ba234da4d2cbacfdad268075acad6d0497e2a57aec12");
    const fixture = readFileSync(new URL("../public/fixtures/harbor-relay-session.json", import.meta.url));
    expect(createHash("sha256").update(fixture).digest("hex"))
      .toBe("43ec2db62b962ca26476215c804b91bec15614cfd3aff1b42bd15727ea430a3a");
  });

  it("retains the existing library, profiles, and evidence namespace", () => {
    expect(SESSION_LIBRARY_DB_NAME).toBe("narrowslink-session-library");
    expect(CAPTURE_PROFILE_STORAGE_KEY).toBe("narrowslink.capture-profiles.v1");
    expect(EVIDENCE_BUNDLE_FORMAT).toBe("narrowslink/evidence-bundle");
    expect(EVIDENCE_BUNDLE_MEDIA_TYPE).toBe("application/vnd.narrowslink.evidence-bundle+zip");
  });

  it("accepts the legacy bridge token environment with ReplayCase taking precedence", () => {
    vi.stubEnv("REPLAYCASE_BRIDGE_TOKEN", "");
    vi.stubEnv("NARROWSLINK_BRIDGE_TOKEN", "legacy-test-token");
    expect(parseArguments([]).token).toBe("legacy-test-token");
    vi.stubEnv("REPLAYCASE_BRIDGE_TOKEN", "current-test-token");
    expect(parseArguments([]).token).toBe("current-test-token");
    expect(parseArguments(["--token", "explicit-test-token"]).token).toBe("explicit-test-token");
  });

  it("publishes ReplayCase branding and both CLI entry names", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.name).toBe("replaycase");
    expect(pkg.bin).toEqual({ replaycase: "dist-cli/replaycase.mjs", narrowslink: "dist-cli/narrowslink.mjs" });
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain("<title>ReplayCase");
    expect(html).toContain("/replaycase-mark.svg");
    expect(html).not.toContain("NarrowsLink");
  });
});
