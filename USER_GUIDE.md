# NarrowsLink user guide

This guide covers NarrowsLink v0.3.0 operation from installation through local capture, replay, incident authoring, evidence export, receiver verification, and comparative replay. Source contributors should use [CONTRIBUTING.md](CONTRIBUTING.md).

NarrowsLink keeps telemetry, saved sessions, operator annotations, and evidence generation on the local machine. It does not provide accounts, cloud storage, hosted ingestion, or telemetry upload.

## Requirements

You need:

- Node.js 20.19 or newer.
- A local browser.
- A supported Chromium browser for physical Web Serial capture.
- Enough browser memory and storage for the sessions you plan to process and retain.
- The four files from the [NarrowsLink v0.3.0 release](https://github.com/zrack/narrowslink/releases/tag/v0.3.0).

The release package contains the production application, authenticated UDP bridge, bundled Harbor relay replay, decoder-pack tools, application and CLI evidence receivers, and comparison workflow. A source checkout, Vite, and project dependencies are not required.

## Install and verify v0.3.0

Download these four release assets into one directory:

- `narrowslink-0.3.0.tgz`
- `narrowslink-0.3.0.release.json`
- `narrowslink-0.3.0.cdx.json`
- `SHA256SUMS`

On macOS, verify the published checksum set:

```bash
shasum -a 256 -c SHA256SUMS
```

On GNU/Linux:

```bash
sha256sum -c SHA256SUMS
```

All three listed assets must report `OK`. The checksum file is delivered through the same release channel as the package, so this proves byte consistency, not independent publisher authenticity.

Install the package without running lifecycle scripts:

```bash
npm install --global ./narrowslink-0.3.0.tgz --ignore-scripts
```

Confirm the installed identity:

```bash
narrowslink version --json
```

The output must identify version `0.3.0`. Compare its full commit and version with `narrowslink-0.3.0.release.json`. If either differs, stop and resolve the package mismatch before collecting evidence.

## Start and stop NarrowsLink

Start the application:

```bash
narrowslink serve
```

The command starts the production UI and authenticated bridge in one process, then opens:

```text
http://127.0.0.1:47890/
```

If the browser does not open, leave the command running and open the printed URL yourself. To prevent automatic browser launch:

```bash
narrowslink serve --no-open
```

Press `Ctrl+C` in the serving terminal to stop the application server and bridge cleanly.

Keep the default application port when you want access to an existing local session library. Browser storage belongs to the exact origin `http://127.0.0.1:47890`; another application port or browser profile selects different storage.

Use `narrowslink serve --help` to inspect bind and launch options. UDP-related command-line flags populate the capture dialog defaults. They do not start a UDP socket until you select **Run UDP preflight**.

## First run with the bundled replay

NarrowsLink validates and opens **Harbor relay downlink** automatically at startup. This synthetic session is the safest way to learn the workspace.

![NarrowsLink mission-timeline session review workspace](docs/assets/narrowslink-dashboard.png)

1. Select **Play replay**.
2. Move **Replay position** or choose a point on the mission timeline.
3. Change **Replay speed** to inspect slow transitions or cross a long quiet interval.
4. Choose each preset from **Selected incident**.
5. Review the **Narrative**, **Details**, **Provenance**, and **Stats** tabs.
6. Compare the Connection, Throughput, Packet loss, packet-family, Decoder, Diagnostics, Marker, and decoded-signal lanes at the same playhead.
7. Select **Save current replay** if you want the fixture in the local session library.

The fixture contains deliberate fades, inferred missing frames, checksum failures, missing sync words, truncated frames, and decoder recovery. Its multicast metadata is historical replay evidence; opening the fixture does not bind a live multicast socket.

## Workspace tour

The main workspace has five working areas:

| Area | What it does |
| --- | --- |
| Sessions rail | Opens local replays, starts live capture, saves or reopens sessions, and shows source and integrity facts |
| Top controls | Opens capture or replay files, controls playback and rate, adds markers, starts comparison, and creates bundles |
| Session overview | Shows the whole recording and its available incident presets or local ranges |
| Mission telemetry timeline | Aligns link, packet, decoder, diagnostic, marker, and decoded-signal evidence to one replay clock |
| Incident and bundle panels | Review the selected range, provenance, statistics, annotations, and evidence contents |

On narrow screens, use **Saved (n)** to open the same session library in a dialog.

## Open a local replay

NarrowsLink accepts `.json` and `.nlsession` files using session format v1 or v2.

1. Select **Open replay**, **Open local replay**, or **Replace session**.
2. Choose the local file.
3. Follow the processing phase and completion percentage while NarrowsLink reads, parses, validates, decodes, aggregates, canonicalizes, and transfers the replay.
4. Confirm the expected title, source, decoder pack and runtime identity, duration, and integrity state.

A valid imported file becomes the active replay and NarrowsLink attempts to save its canonical bytes in the local library. Select **Cancel** to stop an in-progress import; cancellation terminates the worker, leaves the active replay unchanged, and does not save partial content. A failed, cancelled, or oversized file does not replace a valid replay.

Imported and saved replay documents are limited to 64 MiB of canonical UTF-8 JSON, 200,000 records, and 24 hours. The cross-browser acceptance corpus reaches the record ceiling at 52,378,445 bytes; the exact time and memory required still depend on the browser and machine.

Session format v1 is preserved unchanged and reports `unknown` legacy capture integrity. Earlier valid v2 sessions without current provenance remain valid and report the missing evidence as unavailable.

## Choose or load a decoder pack

Every new capture uses one decoder pack. The default is **NSL-01 v1.3.7**.

1. Open **Live capture**.
2. Under **Decoder pack**, choose the bundled NSL-01 or NMEA 0183 reference pack.
3. To use a local pack, select **Load pack** and choose a `.nldecoder` or `.json` file.
4. Wait for the loaded-pack notice. Do not begin a test if identity, compatibility, or fixture validation fails.
5. Confirm the displayed runtime revision and first 12 characters of the pack SHA-256 against the expected pack identity.

Pack selection is locked once preflight begins. The resulting `.nlsession` embeds the exact pack, schema, runtime, and revision identities. NarrowsLink accepts only bounded declarative packs for its supported runtime allowlist and does not run pack-supplied JavaScript.

For pack authoring, offline validation, NMEA record boundaries, and the trust model, use [DECODER_PACKS.md](DECODER_PACKS.md).

## Save and reuse a capture profile

A capture profile is local setup state, not capture evidence. It stores the exact validated decoder pack plus either UDP bind, port, and multicast settings or serial line settings. It never stores the bridge credential, browser device permission, session title, or sampled telemetry.

1. Configure the decoder and transport in **Live capture**.
2. Select **Save setup**, enter a profile name, and confirm the save.
3. On a later run, choose the profile under **Capture profile**. NarrowsLink applies its exact decoder pack and transport settings.
4. If you deliberately change that setup, the profile is marked **modified**. Select **Update setup** to replace the stored settings or leave the profile unchanged.
5. Use the trash button to remove the selected profile.

Profiles are stored in browser local storage at the current NarrowsLink origin. They are limited to 16 profiles and 2 MiB of canonical content. A serial profile can restore settings but cannot bypass the browser's native device-selection and permission prompt.

## Record live UDP

The installed release manages the authenticated bridge. The operator never copies a bearer token.

![NarrowsLink confirming UDP traffic and decoder fit before recording](docs/design/capture-preflight-ready.png)

1. Start NarrowsLink with `narrowslink serve`.
2. Select **Live capture** or **Capture**.
3. In **Record live telemetry**, leave **UDP bridge** selected.
4. Confirm **Managed local bridge · authenticated**. The installed release should not show manual **Bridge URL** or **Bridge token** fields.
5. Enter a **Session title**.
6. Confirm the **Display timezone** is a valid IANA name, such as `America/Los_Angeles`.
7. Select or load the decoder pack that matches the incoming datagrams.
8. Set **UDP bind host** and **UDP port**.
9. For multicast, set **Multicast group** and, when needed, **Multicast interface**. The bind address and group must use the same IP family.
10. Select **Run UDP preflight**.
11. Send known traffic to the exact address shown under **Source**.
12. Inspect source state, datagram and byte rates, last-input age, valid and malformed frames, checksum failures, message families, endpoints, and the decoder-fit assessment.
13. Select **Start recording** when the decoder fits. **Record with warning** or **Start recording anyway** remains available when the probe has traffic problems or no traffic, but the warning becomes an operator decision rather than a hidden assumption.
14. Confirm the status is **Recording**, then send the telemetry that belongs in evidence.
15. Watch **Datagrams received**, **Input bytes**, **Records retained**, **Bytes retained**, and **Bridge state**.
16. Select **Stop, save & replay**.

Using UDP port `0` lets the bridge choose an available port. Read the actual bound port under **Source** before starting the sender.

UDP preflight uses a temporary bridge capture identity. Starting recording first requires that probe to stop cleanly, discards its sampled traffic, and opens a new capture identity. If NarrowsLink cannot confirm the stop, it refuses to record because the evidence boundary is not proven. The resulting `.nlsession` begins only with traffic received after **Start recording**.

For NMEA 0183, send one complete `$...*HH` sentence per UDP datagram. Concatenating multiple sentences into one datagram is not split automatically.

For traffic from another machine, bind the receiving computer's interface address or `0.0.0.0`. The latter listens on every local IPv4 interface, so prefer a narrower address when possible. Firewall and routing rules still apply.

This example supplies unicast or multicast defaults before startup:

```bash
narrowslink serve \
  --udp-host 0.0.0.0 \
  --udp-port 9104 \
  --multicast-group 239.42.91.4
```

The dialog remains the final per-capture configuration. Selecting **Stop, save & replay** downloads a version 2 `.nlsession`, opens the validated finalized capture, and attempts to retain it in the local library.

![NarrowsLink replaying and investigating a captured UDP burst](docs/design/live-capture-replay.jpg)

## Record live serial telemetry

Physical serial capture requires a browser with Web Serial support, normally a Chromium browser, and a secure loopback page.

1. Select **Live capture** or **Capture**.
2. Select the **Serial port** tab.
3. Enter a **Session title** and confirm the **Display timezone**.
4. Select or load the decoder pack that matches the serial stream.
5. Set **Baud rate**, **Data bits**, **Stop bits**, **Parity**, and **Flow control**. The defaults are `115200`, `8`, `1`, `None`, and `None`.
6. Select **Select port & preflight**.
7. Choose the device in the browser's native prompt.
8. Confirm **Serial state: open**, send known traffic, and inspect the preflight decoder-fit assessment.
9. Select **Start recording**, **Record with warning**, or **Start recording anyway** as the observed traffic warrants.
10. Send the telemetry that belongs in evidence and watch the serial reads, input bytes, retained records, and retained bytes.
11. Select **Stop, save & replay**.

Device selection and port setup happen before the capture clock starts. When recording begins, NarrowsLink keeps the selected port open but resets serial framing and counters; only subsequent reads enter the immutable session. NarrowsLink retains undecodable and partial input received after that boundary as evidence. A disconnect or read failure produces an incomplete receipt and a capture-path diagnostic rather than silently claiming a clean capture.

Both preflight paths analyze at most 256 input units, 512 KiB of input, and 16 UDP endpoints. The dialog retains aggregate observations, not sampled payloads. **Stop preflight** closes the temporary source without creating, saving, or downloading a session.

NSL-01 serial framing uses its sync word and declared binary length. NMEA serial framing uses line-feed boundaries, preserves CRLF, and retains overlong or unterminated tails as bounded partial records.

The automated release gate exercises the serial application path with an injected standards-based API. It does not certify physical adapters, USB drivers, native device choosers, or operating-system disconnect behavior.

## Replay and investigate a session

1. Select a preset or operator-authored range from **Selected incident**.
2. Use **Play replay**, **Pause replay**, **Replay again**, the position slider, and the speed control.
3. Correlate the same moment across the timeline lanes.
4. Use **Narrative** for ordered evidence-backed events.
5. Use **Details** for capture integrity and evidence-domain facts.
6. Use **Provenance** for UDP endpoint and bridge-journal evidence, measured or explicitly unavailable host socket drops, layered UDP byte accounting, or serial device and negotiated-setting evidence.
7. Use **Stats** for range-level measures.
8. Inspect malformed, checksum-failed, partial, and unknown frames instead of treating them as absent.

Capture-path diagnostics describe local collection failures. Keep them distinct from source-link and decoder failures when writing an incident conclusion.

For UDP, **Payload** is an exact bridge observation. **UDP** adds the fixed eight-byte datagram header, and **IP minimum** adds the fixed IPv4 or IPv6 header under stated no-fragmentation and no-options assumptions. **Link** and **Radio** remain unavailable because a UDP socket does not observe those layers. On Linux, NarrowsLink can report a capture-scoped socket-drop delta when procfs exposes one unique socket. Other platforms and ambiguous or unreadable sockets remain explicitly unavailable; that state is not zero.

## Create an exact incident range

Use a local range when a replay preset is too broad or the session has no preset.

1. Seek near the event.
2. Select **New range**.
3. Give the range a short **Title**.
4. Enter **Start · included** and **End · excluded** as `HH:MM:SS.ffffff` offsets from session start.
5. Choose **Info**, **Warning**, or **Critical** severity.
6. Select **Create range**.

Incident ranges use half-open semantics: `[start, end)`. The start instant is included; the end instant is excluded. NarrowsLink stores the offsets as integer microseconds.

Use the amber timeline handles for rapid adjustment, then use **Edit operator range** for exact boundaries. Replay presets remain immutable. Select **Refine replay preset as a local range** to create an editable copy.

Deleting a local range does not change the replay or an archive that was already exported.

## Add markers and a session note

Select **Add marker** to attach operator context to the replay clock.

The marker dialog accepts:

- **Offset from session start (seconds)**
- **Title**
- **Category**: Observation, Field note, or Maintenance
- **Note**

Use **Session-wide operator note** for context that applies to the whole replay. Markers, authored ranges, and notes are local overlays. They do not modify raw session records.

When browser storage is available, the workspace is restored by session identity. If storage is unavailable, the visible workspace remains usable in memory and can still be included in the next bundle.

## Export an evidence bundle

An incident must be selected before export.

1. Review **Incident bundle preview**.
2. Choose the optional evidence groups needed by the receiver:
   - **Raw source records (NDJSON)**
   - **Decoded packets (CSV)**
   - **Decoder schema**
   - **Diagnostics**
   - **Operator context**
3. Keep **Decoder schema** selected for a non-built-in or locally loaded pack so the receiving verifier can reproduce the interpretation.
4. Leave **Capture integrity** selected. It is required and cannot be removed.
5. Confirm the displayed range and estimated size.
6. Select **Create incident bundle**.
7. In **Package this incident for handoff?**, select **Build and download**.
8. Follow the bundle-processing phase and completion percentage. Select **Cancel** to terminate construction without downloading an archive, or wait for **Handoff archive is ready** and retain the downloaded `.nlb`.

The preview size is an estimate. The archive manifest contains the actual artifact list, byte sizes, counts, selection, and SHA-256 hashes.

Every bundle includes range-filtered transport events and whole-session provenance, bridge-journal, and integrity-receipt artifacts. Optional source, decoded, diagnostic, schema, marker, and note artifacts follow the selected incident and inclusion controls.

Version 3 and 4 raw and decoded artifacts are each limited to 100,000 rows. NarrowsLink v0.3.0 creates version 4 bundles; v0.2.0 creates version 3. When investigating a larger replay, select a narrower incident before including those groups. The maximum-record release case uses an exact 10,000-record incident rather than exporting the full 200,000-record session.

## Verify a received bundle

Treat received `.nlb` bytes as untrusted.

The v0.3.0 application and CLI verify versions 3 and 4. Upgrade a v0.2.0 receiver before opening a version 4 bundle; changing a manifest or file extension is not a conversion. Open the incident directly:

1. Start NarrowsLink on the receiving machine.
2. Select **Open evidence** in the Sessions rail or top bar.
3. Choose the received `.nlb` and wait while NarrowsLink preflights ZIP structure, bounds decompression, validates every artifact, checks identities and checksums, and reconciles the exact incident.
4. Confirm the three claims separately: **Internal consistency**, **Evidence completeness**, and **Source authenticity**. A green internal-consistency result does not turn incomplete capture evidence or unsigned authenticity into a verified claim.
5. Review **Artifact groups** before interpreting the timeline. **Not included** means the archive did not carry that evidence; the receiver does not infer or reconstruct it from other artifacts.
6. Inspect the exact half-open range through the received timeline, packet or raw-record table, and **Evidence** and **Provenance** tabs.
7. Use the **Notes** tab for a receiver-owned finding. NarrowsLink stores it separately under the exact whole-bundle SHA-256; it never changes the `.nlb` or presents the finding as source evidence.

If verification fails, NarrowsLink keeps the previously open replay or receiver workspace unchanged and identifies the failure class and artifact. Do not extract or inspect the rejected archive manually.

The CLI uses the same production verifier and remains the path for terminal-only use or a stable machine-readable report. Install a verified NarrowsLink package, then run:

```bash
narrowslink verify path/to/incident.nlb
```

For a stable machine-readable report:

```bash
narrowslink verify path/to/incident.nlb --json
```

A passing human-readable report identifies:

- Whole-bundle SHA-256 and byte size
- Session, source, and format
- Exact half-open selection
- Artifact count
- Internal-integrity verdict
- Aggregate, capture, and provenance evidence states
- Warnings
- Authenticity status
- Decoder-pack identity and whether selected raw records reproduced the exported decoded rows

Exit statuses are:

| Status | Meaning |
| --- | --- |
| `0` | The supported version 3 or 4 archive is internally consistent |
| `1` | The archive is invalid, tampered, unsafe, or unsupported |
| `2` | Command usage or local file I/O failed |

Do not extract a bundle that exits `1`. Correct path, permissions, or command usage before retrying an exit `2`.

A valid bundle can truthfully report `incomplete` or `unknown` capture or provenance evidence. Version 3 and 4 bundles are unsigned, so the verifier reports authenticity as `not-established`. Exchange the reported bundle SHA-256 or expected manifest identity through a separately trusted channel when authorship or source-channel authenticity matters.

For a real-world handoff claim, follow the [independent field-proof procedure](docs/field-proofs/README.md). Loopback capture, simulated serial, self-verification, and reopening on the source browser are regression evidence, not an independent field proof.

## Compare two bounded inputs

NarrowsLink v0.3.0 can compare an exact incident from the active replay or the fixed range from a verified receiver bundle with one candidate session or bundle.

1. In the replay workspace, select the baseline incident and choose **Compare**. In the receiver workspace, choose **Compare** to use the bundle's exact included range.
2. Under **Candidate**, choose a `.nlsession`, `.json`, or `.nlb`. NarrowsLink validates a session through the normal decoder pipeline and verifies a bundle through the production receiver before continuing. Session processing shows the same phase progress as replay import and can be cancelled without replacing either source workspace.
3. If the candidate is a session, choose its **Candidate incident**.
4. Choose an alignment:
   - **Align range starts** treats each selected range start as relative zero.
   - **Shared event anchors** requires a short event label and exact microsecond offsets inside both half-open ranges.
5. Select **Open comparison**. NarrowsLink computes only the intersection after alignment in a worker, reports progress, and reports every unmatched leading or trailing interval. Cancelling construction returns to setup without creating a partial comparison.
6. Review **Comparison eligibility** before interpreting a delta. Packet, diagnostic, and decoded-field comparisons require exact decoder, schema, pack, and runtime identity plus selected raw support in both inputs. RSSI requires one matching observation basis; decoded-packet RSSI also requires the same decoder identity. Capture evidence retains its own basis and may remain review-required or unavailable.
7. Select a metric row to inspect its reason, baseline and candidate supporting counts, up to the first 64 evidence IDs, and limitations. Higher packet traffic and arbitrary decoded values are directional observations, not automatic improvements.
8. Enter an **Operator conclusion**, then select **Export finding** to download the `.nlcompare.json`.

The finding includes both immutable input identities, source durations, exact ranges, evidence availability and aligned counts, decoder identities, alignment, overlap, unmatched tails, comparability decisions, metrics, bounded evidence-ID samples, assessment, limitations, and conclusion. Its canonical SHA-256 detects alteration to the finding itself. It does not authenticate the author, establish that clocks were synchronized, prove causality, or contain either source file. Keep the exact cited `.nlsession` or `.nlb` files with the finding so another engineer can reproduce the result.

Invalid or incompatible candidate input leaves the current replay, receiver, and any open comparison unchanged. **Return** goes back to the source workspace; **New comparison** keeps the same baseline and reopens setup.

## Use the local session library

The Sessions rail contains validated canonical sessions stored in IndexedDB.

- Select **Save current replay** to retain the active bundled replay when it is not already saved.
- Imported files and finalized captures automatically attempt a library save.
- Select a saved row to reopen it. NarrowsLink reports processing progress while it re-hashes, parses, validates, decodes, aggregates, and transfers the stored bytes before replacing the active replay.
- Select **Cancel** during reopen to keep both the current replay and saved library entry unchanged.
- Saving exact duplicate canonical content is idempotent; it remains one entry.
- Select the remove control, then **Remove**, to delete a saved replay.
- Use **Retry local library** after a temporary storage failure.

Removing a saved replay also attempts to clear its markers, note, and authored ranges. The active in-memory replay stays open, and exported files are not deleted. If workspace cleanup fails, NarrowsLink leaves a persistent residual-data warning.

New saves retain exact canonical bytes in version 3 IndexedDB records. NarrowsLink continues to read its earlier version 1 text and version 2 Blob records, but every reopen must still pass identity, canonical-byte, metadata, schema, and decoder checks.

A storage error does not mean a session was saved. Keep the downloaded `.nlsession` when the browser reports that IndexedDB, Web Crypto, quota, or the transaction prevented persistence.

## Upgrade NarrowsLink

1. Download the newer package, release manifest, SBOM, and `SHA256SUMS`.
2. Verify the new checksum set.
3. Stop the running `narrowslink serve` process with `Ctrl+C`.
4. Install the new package:

```bash
npm install --global ./narrowslink-<version>.tgz --ignore-scripts
```

5. Confirm the new identity:

```bash
narrowslink version --json
```

6. Start NarrowsLink on the same `127.0.0.1` application port with the same browser profile:

```bash
narrowslink serve
```

The installed package and browser-held library are separate. Replacing package files does not remove sessions or operator workspace data.

### Evidence compatibility

| Application | Bundle writer | Bundle receiver |
| --- | --- | --- |
| v0.2.0 | Version 3 | Version 3 only |
| v0.3.0 | Version 4 | Versions 3 and 4 |

Upgrade both the recording and receiving installations to v0.3.0 for a new handoff. Existing version 1 and 2 session documents remain supported without rewriting their evidence. Existing version 3 bundles remain inspectable. New version 4 bundles require the newer receiver; NarrowsLink does not provide a downgrade export. Keep original artifacts rather than editing manifests or removing provenance to make an older verifier accept them.

## Remove NarrowsLink

Stop the running process, then uninstall the package:

```bash
npm uninstall --global narrowslink
```

Uninstalling does not delete:

- The browser-held session library
- Markers, notes, or authored ranges
- Downloaded `.nlsession` files
- Exported `.nlb` bundles

To intentionally purge the browser-held library and workspace, preserve any required captures and then clear site data for `http://127.0.0.1:47890` in that browser profile. Package removal never deletes exported files.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `narrowslink` is not found | Confirm the global npm binary directory is on `PATH`, then rerun `narrowslink version --json`. Do not substitute an unverified package. |
| The browser did not open | Keep `narrowslink serve` running and open the printed loopback URL. |
| Port `47890` is occupied | Stop the existing process when possible. An alternate `--app-port` works, but it selects a different browser-storage origin. |
| The managed capture status is missing or invalid | Start the installed package with `narrowslink serve`; do not serve the application directory as static files. |
| UDP preflight will not start | Confirm the bind address exists locally, the port is free, and multicast group and interface values use the same IP family. |
| UDP preflight sees no traffic | Send to the exact address under **Source**, then check firewall, routing, and sender configuration. Port `0` changes to the actual assigned port after preflight opens. |
| Preflight reports a decoder mismatch | Confirm the sender's framing and protocol, then select or load the matching pack. Record with the warning only when preserving intentionally mismatched raw evidence is the test objective. |
| Recording cannot follow UDP preflight | NarrowsLink could not prove the temporary probe stopped. Select **Stop preflight**, resolve the bridge problem, and run a new preflight; do not treat probe traffic as recorded evidence. |
| A capture profile will not save | Confirm browser local storage is available and the profile set remains within 16 profiles and 2 MiB. Credentials, device permission, titles, and telemetry must be configured separately. |
| A decoder pack will not load | Confirm the file is at most 512 KiB, was sealed with `narrowslink decoder seal`, uses a supported runtime, and passes its bundled fixtures. |
| NMEA records are partial or unknown | Send one sentence per UDP datagram, or terminate each serial sentence with LF; confirm `$` prefix and `*HH` checksum. |
| Web Serial is unavailable | Use a supported Chromium browser at the loopback application URL, or use UDP capture. |
| Status says **Recording with attention required** | Stop and preserve the retained records. Expect incomplete capture evidence and review its issue codes. |
| The finalized session did not download | Select **Retry download**. The finalized session remains available until it is downloaded or explicitly discarded. |
| Finalization failed | Select **Retry finalization**. Discard only when losing the retained capture is acceptable. |
| A replay cannot be opened | Choose another file or load the bundled replay. Check the extension, session format, 64 MiB canonical-file limit, 200,000-record limit, 24-hour limit, and file integrity. |
| Replay processing appears slow | Keep the processing dialog open and inspect its current phase. The tested upper-tier gate allows no main-thread heartbeat gap above five seconds; it does not guarantee one update per second on every machine. Cancel to preserve the current workspace, then retry with another browser or a smaller synthetic reproduction if the machine lacks memory. |
| The library is unavailable or full | Keep using the active replay, free site storage if possible, then select **Retry local library**. Preserve downloaded session files. |
| Saved sessions appear missing after upgrade | Return to the same `127.0.0.1` application port and browser profile. |
| Verifier exits `1` | Treat the bundle as invalid or unsupported and do not extract it. |
| Verifier exits `2` | Correct the file path, permissions, or command usage and retry. |

## Privacy, security, and authenticity

NarrowsLink does not upload telemetry, but local evidence can still be sensitive. Sessions and bundles may contain:

- Raw telemetry bytes
- Device identifiers
- Coordinates
- Signal observations
- UDP endpoint addresses
- Operator markers and notes

Review and sanitize evidence before committing it to a repository, attaching it to an issue, or sending it to another person. Browser IndexedDB and local storage are persistence mechanisms, not encrypted secrets stores.

The managed bridge control plane is loopback-only and uses an internal short-lived credential. The UDP listener still binds the interface chosen by the operator and can receive traffic from that interface.

Release checksums and bundle verification establish internal consistency. The v0.3 release, checksum file, decoder packs, comparison findings, and version 3 or 4 evidence bundles are unsigned. They do not establish publisher, author, source-channel, or build-environment authenticity.

## Current operating limits

- Live capture supports UDP and Web Serial, not TCP or other transports.
- Capture profiles are limited to 16 entries and 2 MiB of canonical content. They store an exact decoder pack and transport settings but no credentials, device permission, session titles, or telemetry.
- Preflight analyzes at most 256 input units, 512 KiB of sampled input, and 16 UDP endpoints. It retains aggregate observations only, and preflight traffic is intentionally excluded from the recorded session.
- Bundled packs support NSL-01 and checksummed NMEA 0183 GGA, RMC, and HDT. Local packs are limited to supported bounded runtimes; arbitrary code and automatic protocol detection are not supported.
- Imported and saved replay documents are limited to 64 MiB of canonical UTF-8 JSON, 200,000 records, and 24 hours.
- Live capture is limited to 100,000 retained records, 32 MiB of retained payload bytes, 24 hours, and a canonical file that fits the 64 MiB replay limit.
- Replay parsing, validation, decoding, aggregation, canonicalization, comparison construction, and bundle construction use local workers with progress and cancellation. The active replay and comparison evidence still occupy browser memory.
- The tested 200,000-record corpus is 52,378,445 bytes. Its release gate rejects a main-thread heartbeat gap above five seconds or accumulated timer delay above 50% of the measured operation; Chromium heap growth may not exceed 768 MiB. Timings and baseline memory vary by browser and machine.
- Version 3 and 4 bundle NDJSON and CSV artifacts are limited to 100,000 rows; use a narrower incident when the active replay contains more evidence.
- Linux procfs is the only current measured host UDP socket-drop source. Unsupported platforms, unreadable procfs, counter regression, and ambiguous socket identity remain explicit unavailable states. Payload bytes are observed; UDP and minimum IP bytes are estimates; link and radio bytes are unavailable.
- Browser quota and Web Crypto availability can prevent a library save.
- Only one replay is active at a time.
- Physical Web Serial hardware and manual screen-reader/browser combinations remain outside the automated release gate.
- Receiver verification proves internal bundle consistency, not authorship.

## Command reference

| Command | Purpose |
| --- | --- |
| `narrowslink --help` | Show available commands |
| `narrowslink version --json` | Print the installed version and commit |
| `narrowslink serve` | Start the production UI and authenticated bridge |
| `narrowslink serve --help` | Show application, bridge, UDP, multicast, and launch options |
| `narrowslink serve --no-open` | Start without opening a browser |
| `narrowslink verify incident.nlb` | Verify a received evidence bundle locally |
| `narrowslink verify incident.nlb --json` | Emit the stable machine-readable verification report |
| `narrowslink decoder seal draft.json --out pack.nldecoder` | Seal and conformance-test a decoder-pack draft without overwriting output |
| `narrowslink decoder validate pack.nldecoder` | Validate pack identity, runtime compatibility, and fixtures offline |

## Get help

- Read [README.md](README.md) for product capabilities, formats, architecture, privacy, and current limits.
- Read [USE_CASES.md](USE_CASES.md) for supported outcomes and constraints.
- Read [ACCESSIBILITY.md](ACCESSIBILITY.md) for keyboard behavior and the tested accessibility boundary.
- Use [SUPPORT.md](SUPPORT.md) to prepare a reproducible support request.
- Report vulnerabilities through [SECURITY.md](SECURITY.md).
