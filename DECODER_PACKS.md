# ReplayCase decoder packs

ReplayCase decoder packs bind framing, a declarative schema, a supported parser runtime, and executable conformance fixtures to one immutable content identity. They do not contain JavaScript or other executable plug-in code.

The current application ships two packs:

- **NSL-01 v1.3.7:** the existing binary envelope and five packet families, adapted to the same registry and execution path used by external packs.
- **NMEA 0183 reference-v1:** checksummed GGA, RMC, and HDT sentences over UDP or serial.

## Operator workflow

1. Open **Live capture**.
2. Choose a bundled pack under **Decoder pack**, or select **Load pack** and choose a local `.nldecoder` or `.json` file.
3. Wait for the loaded-pack notice. ReplayCase validates the file shape, canonical SHA-256 identity, supported runtime, schema compatibility, and every bundled fixture before making the pack active.
4. Configure UDP or serial, run preflight with known traffic, and confirm that the selected pack produces the expected valid frames and message families. The pack is locked once preflight begins.
5. Select **Start recording**. UDP replaces the discarded probe with a new capture identity; serial resets framing on the already selected port so only subsequent reads enter evidence.
6. Stop and save. The version 2 `.nlsession` embeds the exact pack and records its pack, schema, runtime, and revision identities.
7. Export an `.nlb` with **Decoder schema** included. The production receiver revalidates the embedded pack and reproduces decoded rows from the selected raw records.

If pack validation or a fixture fails, capture does not start with that pack. Existing raw session records are never rewritten to fit a replacement decoder.

## NMEA 0183 record boundaries

ReplayCase operates on bytes delivered to the laptop; it does not demodulate radio signals.

- For UDP, send one complete NMEA sentence per datagram. Each sentence must begin with `$`, end with `*HH`, and fit within 256 bytes including line endings.
- For serial, the runtime assembles records at line-feed boundaries. CRLF is preserved. Unterminated or overlong input is retained as bounded partial records instead of being discarded.
- The reference schema decodes GGA position and fix data, RMC navigation data, and HDT true heading. Unknown sentence types and checksum failures remain inspectable diagnostics.

From a source checkout, `npm run capture:demo:nmea -- --port 9104` sends repeatable checksummed GGA, RMC, and HDT datagrams to a local capture.

## Pack contract

A pack uses `narrowslink/decoder-pack` format version `1`.

The format namespace and published pack metadata are retained across the
ReplayCase rename. Do not relabel an existing pack's description or display name:
those fields contribute to its immutable hash. Branding is not a decoder revision.

Each pack contains:

| Field | Purpose |
| --- | --- |
| `id`, `revision`, `displayName`, `description` | Human and machine identity |
| `runtime.id`, `runtime.revision` | Exact bounded parser implementation |
| `framing` | UDP record limit and serial assembly rule |
| `schema` | Declarative field and sentence definition consumed by the runtime |
| `fixtures` | Raw records, expected frames, expected field subsets, and expected diagnostics |
| `integrity` | SHA-256 over canonical pack contents excluding `integrity` |

Pack JSON is limited to 512 KiB and 64 levels of nesting. A pack may contain at most 32 fixtures, with at most 32 records and expected frames per fixture. Each fixture record produces exactly one expected frame.

The current parser-runtime allowlist is:

| Runtime | Contract |
| --- | --- |
| `nsl01-binary-v1` revision `1` | Fixed to the built-in NSL-01 schema and revision |
| `nmea0183-line-v1` revision `1` | Declarative checksummed NMEA sentence definitions using bounded string, number, integer, coordinate, and enum fields |

A new NMEA sentence schema can use the existing NMEA runtime without changing capture, session, replay, incident, bundle, or verifier code. A fundamentally different wire protocol requires a reviewed bounded runtime implementation; arbitrary code execution and automatic protocol detection are intentionally unsupported.

## Author and seal a pack

Start with a JSON draft containing every pack field except `integrity`. Fixtures should include known-good records and the malformed cases the pack claims to diagnose.

Seal the draft:

```bash
replaycase decoder seal nmea-draft.json --out nmea-reference.nldecoder
```

The command:

1. Bounds and parses the input.
2. Replaces any stale draft integrity value.
3. Calculates the canonical pack SHA-256.
4. Validates runtime and schema compatibility.
5. Runs fixtures through the production session, decoder, diagnostics, and replay path.
6. Writes canonical JSON without overwriting an existing output file.

Validate a pack received from another contributor:

```bash
replaycase decoder validate nmea-reference.nldecoder
replaycase decoder validate nmea-reference.nldecoder --json
```

Use the pack SHA-256 as its immutable identity. Changing a description, schema field, fixture, or expected result creates a different pack and requires resealing.

## Fixture expectations

Each fixture declares:

- A stable fixture ID, title, and representative transport.
- One or more hexadecimal source records with monotonic microsecond offsets.
- One expected frame per source record, including frame status, integrity status, family name, and any fields that must match.
- The exact ordered diagnostic types expected from the production session pipeline.

Expected field maps may be partial: include the values that define the behavior under test. Frame count, status, integrity, family name, and diagnostic sequence are always checked.

## Evidence and trust boundary

Pack identity proves that two installations have the same canonical pack contents. Conformance proves that the receiving runtime produces the pack's declared fixture results. The evidence verifier also checks that selected raw records reproduce the exported decoded rows.

Those checks do not prove who authored the pack, whether its schema is semantically correct, whether the source emitted truthful data, or whether the bundle came through an authentic channel. Decoder packs and version 3 or 4 evidence bundles are unsigned. Exchange their SHA-256 identities through a separately trusted channel when authorship or source authenticity matters.
