# ReplayCase use-case log

This is the canonical catalog of operator outcomes ReplayCase currently supports. It is not a chronological project record: completed product changes belong in [CHANGELOG.md](CHANGELOG.md), and unsupported future outcomes belong in [ROADMAP.md](ROADMAP.md).

## Status model

- **Supported:** the current application provides the complete workflow and the cited implementation or automated coverage exercises its critical path.
- **Supported with constraints:** the workflow is complete within the limits stated in the entry.

Use-case IDs are permanent. Update an entry when its current workflow, support level, constraints, or evidence changes; record the notable change separately under `CHANGELOG.md` → `[Unreleased]`.

## Current use cases

| ID | Use case | Primary actor | Status | Primary output |
| --- | --- | --- | --- | --- |
| UC-001 | Record live field telemetry | Field or test operator | Supported with constraints | Version 2 `.nlsession` |
| UC-002 | Investigate a recorded telemetry fault | Mission or reliability engineer | Supported with constraints | Exact operator-authored incident range |
| UC-003 | Audit capture-path integrity | Capture engineer or forensic reviewer | Supported with constraints | Integrity assessment and transport evidence |
| UC-004 | Compare captures and prove regressions | Test, protocol, or reliability engineer | Supported with constraints | Checksummed `.nlcompare.json` finding |
| UC-005 | Hand off a verifiable incident bundle | Operator and receiving engineer | Supported with constraints | `.nlb` archive and verified receiver workspace |
| UC-006 | Investigate and hand off a multi-bundle case | Investigating and receiving engineers | Supported with constraints; source build only | `.nlcase` archive |

## UC-001 — Record live field telemetry

**Actor:** Field or test operator

**Outcome:** Preserve live telemetry through an identified decoder pack as an immutable local session that can immediately enter the normal replay and investigation workflow and be reopened with the same interpretation from the local session library.

**Workflow:**

1. Start ReplayCase, apply or create a local capture profile, or directly choose the bundled NSL-01 or NMEA 0183 pack or load a bounded local pack; then select managed UDP or Web Serial and configure the source.
2. Run transport preflight with known traffic. ReplayCase validates pack identity, runtime compatibility, schema, and conformance fixtures, then reports bounded traffic, framing, checksum, family, and endpoint observations without retaining sampled payloads as session evidence.
3. Deliberately start recording. UDP stops and discards the probe before opening a new capture identity; serial keeps the selected port but resets framing so only future reads cross the evidence boundary.
4. Record raw datagrams or assembled serial records with byte counts, monotonic offsets, malformed input, UDP remote endpoints and bridge-journal events, measured or explicitly unavailable host socket drops, or the browser-exposed serial device identity and negotiated settings.
5. Stop the source with **Stop, save & replay**.
6. Save the downloaded version 2 `.nlsession`, follow worker processing through the same validation and decoder path as import, continue into replay with the validated finalized session, and retain the canonical session in the local library when IndexedDB succeeds.

**Radio transport capture topologies:**

ReplayCase starts where telemetry bytes are available to the laptop as UDP datagrams or serial bytes. It is not an RF receiver, demodulator, passive packet sniffer, or transparent man-in-the-middle. A radio, modem, base station, ground-control station, network, or tap must deliver a readable stream to the ReplayCase machine.

| Option | Topology | What ReplayCase observes | Test path |
| --- | --- | --- | --- |
| 1 | USB serial radio connected to the laptop | The radio terminates the RF link and exposes telemetry bytes through a browser-selected serial device. ReplayCase applies the selected pack's bounded serial framing, records serial reads and retained bytes, preserves device identity when exposed and negotiated settings, and retains malformed input plus disconnect or read-failure evidence. | Use a Chromium browser, select the matching decoder pack and **Serial port**, choose **Select port & preflight**, send known traffic, inspect framing and decoder fit, select **Start recording**, send the test evidence, stop with **Stop, save & replay**, and verify retained records plus decoded or diagnostic output. |
| 2 | Radio or base station outputs UDP to the laptop | The external receiver terminates the RF link and forwards payloads as UDP datagrams to the ReplayCase bridge. ReplayCase records datagrams, payload bytes, remote endpoint attribution, bridge journal entries, retained records, capture-path diagnostics, supported host socket drops, and explicit UDP/IP estimates. It does not observe radio or link-layer bytes. | Configure a known bind host and port, choose **Run UDP preflight**, send known base-station traffic to the exact reported address, inspect endpoint and decoder fit, select **Start recording**, send the test evidence, stop with **Stop, save & replay**, then replay and export a small evidence bundle. |
| 3 | Ground-control software forwards a UDP copy | Another application remains the primary receiver, and ReplayCase receives a duplicated stream. ReplayCase can preserve and verify the copy it received, but it cannot prove losses that happened before the copy point unless the forwarded payload or side channel carries those counters. | Configure the ground-control station or a small proxy to tee telemetry to ReplayCase's UDP address, prove the copy path in preflight, deliberately start recording, and compare ReplayCase counters with the upstream tool's send or receive counters when available. |
| 4 | Network multicast observer | The sender publishes UDP to a multicast group and port; ReplayCase joins that group on the selected interface. This is an IP-network observer pattern, not passive RF capture. ReplayCase records multicast bind configuration, datagrams, remote endpoints, bridge journal evidence, and retained records. | Select the matching decoder pack, run UDP preflight with a multicast group and matching bind/interface family, send known datagrams to the group and port, confirm ReplayCase observes them without being the sender's only destination, then start recording, stop, replay, and verify provenance. |

For multicast, the sender addresses one UDP datagram stream to a multicast group such as `239.42.91.4:9104` instead of one specific host. Receivers that join the group on the relevant network interface can receive the stream at the same time. This is useful when a base station, ground-control tool, and ReplayCase all need the same telemetry without configuring separate unicast destinations. It still depends on network equipment, operating-system multicast support, firewall rules, interface selection, and matching IPv4 or IPv6 family between bind address and multicast group.

**Current constraints:** ReplayCase v0.4.0 requires Node.js 20.19 or newer and a local browser. `replaycase serve` gives the browser a same-origin relay to the managed loopback bridge and keeps its bearer credential internal, without asking the operator to transfer it; source-development mode retains a separate manual bearer-token bridge. Capture profiles are local convenience state limited to 16 entries and 2 MiB; they contain the exact pack and transport settings but no credential, device permission, title, or telemetry. Preflight retains aggregate observations only and is bounded to 256 input units, 512 KiB, and 16 UDP endpoints. Probe traffic is intentionally excluded from evidence. Serial capture requires a browser with Web Serial support and a secure context such as `localhost` or `127.0.0.1`. The cross-browser automated serial gate injects the public browser API; it proves the complete application path but does not certify native device choosers, USB drivers, operating-system disconnect behavior, or physical adapters. Packs are limited to supported bounded runtimes; arbitrary JavaScript and automatic protocol detection are not accepted. NMEA UDP requires one sentence per datagram, while serial NMEA uses line-feed boundaries. Live capture is limited to 100,000 retained records, 32 MiB of retained payload bytes, 24 hours, and a canonical file within the 64 MiB replay limit. If IndexedDB, Web Crypto, or the available quota prevents library persistence, the downloaded file and active replay remain usable, but ReplayCase reports that the session was not saved in the library.

**Implementation evidence:** [decoder-pack contract](src/domain/decoder-pack.ts), [conformance runner](src/domain/decoder-conformance.ts), [capture profiles](src/capture/capture-profile.ts), [bounded preflight](src/capture/capture-preflight.ts), [capture dialog](src/capture/CaptureDialog.tsx), [bounded recorder](src/capture/recorder.ts), [runtime-selected serial assembly](src/capture/serial-assembler.ts), [UDP client](src/capture/udp-bridge.ts), [Web Serial adapter](src/capture/web-serial.ts), [durable session library](src/storage/session-library.ts), [profile tests](src/capture/capture-profile.test.ts), [preflight tests](src/capture/capture-preflight.test.ts), [decoder-pack and persistence tests](src/domain/decoder-pack.test.ts), [capture-pipeline tests](src/capture/capture-pipeline.test.ts), the [cross-browser real-UDP NSL-01, NMEA, profile, mismatch, and evidence-boundary gate](tests/e2e/capture-to-evidence.spec.ts), the [cross-browser simulated-serial preflight-to-evidence gate](tests/e2e/serial-capture-to-evidence.spec.ts), and [browser storage/failure recovery](tests/e2e/storage-failures.spec.ts).

## UC-002 — Investigate a recorded telemetry fault

**Actor:** Mission or reliability engineer

**Outcome:** Correlate link behavior, packet cadence, decoder state, diagnostics, markers, and decoded signals around one precisely bounded event.

**Workflow:**

1. Load the bundled replay, choose a validated local session, or reopen a saved session from the Sessions rail. Long imports and reopens report their processing phase and completion percentage and can be cancelled without replacing the active replay or persisting partial content.
2. Seek or play the recording on the shared monotonic replay clock.
3. Select a preset or create an operator-authored half-open range around the event.
4. Refine the exact microsecond boundaries and inspect the projected narrative, details, statistics, diagnostics, and decoded values.
5. Add markers and a session note without modifying the source records; they persist locally by session identity when browser storage is available and are restored when the same saved content is reopened.

**Current constraints:** Imported and saved replay documents are limited to 64 MiB of canonical UTF-8 JSON, 200,000 records, and 24 hours. Worker-isolated validation, decoding, aggregation, and canonicalization keep the interface responsive and cancellable, but the active replay and derived evidence still occupy browser memory. The automated upper-tier corpus reaches 200,000 records at 52,378,445 bytes and rejects either a main-thread heartbeat gap above five seconds or accumulated timer delay above 50% of the measured operation, plus Chromium heap growth above 768 MiB; machine and browser baselines still vary. Saved session documents use IndexedDB, while markers, notes, and authored ranges use separate per-session local storage; either store can be unavailable or reject a write. Exact duplicate session content shares one SHA-256 library identity and retains its original saved date. Removing a saved replay attempts to clear both its library document and separate operator workspace; the active in-memory replay stays open but is detached to memory-only workspace state, exported files are unaffected, and a persistent warning identifies any residual workspace that could not be cleared. The mission workspace displays one active replay at a time; a separate bounded comparison workspace handles two explicitly selected incident ranges under UC-004.

**Implementation evidence:** [session projection](src/domain/session.ts), [processing contracts](src/processing/contracts.ts), [worker session processor](src/processing/process-session.ts), [replay clock](src/replay/ReplayClock.ts), [timeline helpers](src/lib/telemetry.ts), [durable session library](src/storage/session-library.ts), [session-library tests](src/storage/session-library.test.ts), [workspace persistence](src/storage/session-storage.ts), [browser replay and library coverage](tests/e2e/replay-library.spec.ts), [browser storage/failure recovery](tests/e2e/storage-failures.spec.ts), the [maximum-record source acceptance gate](tests/e2e/large-session-processing.spec.ts), the [maximum-record unpacked-release gate](tests/release/large-session-processing.spec.ts), and [keyboard/accessibility coverage](tests/e2e/accessibility.spec.ts).

## UC-003 — Audit capture-path integrity

**Actor:** Capture engineer or forensic reviewer

**Outcome:** Determine what ReplayCase actually observed about the collection path without misclassifying capture failures as source, link, or decoder failures.

**Workflow:**

1. For a version 2 session, review the workspace integrity summary, structured Provenance inspector, and capture-path diagnostics; legacy version 1 sessions have no receipt or provenance and are normalized to an unknown assessment.
2. Inspect the saved `.nlsession` or exported `transport/integrity-receipt.json`, `transport/events.json`, `transport/provenance.json`, and `transport/journal.json` when the exact evidence basis, counters, endpoint or device attribution, issue codes, and structured lifecycle entries are required.
3. Review immutable transport evidence for UDP bridge event-stream sequence discontinuities, counter mismatches, measured host socket drops, bridge or event-stream errors, recorder limits, serial failures, disconnects, and shutdown disposition.
4. Correlate `capture-path` diagnostics with the selected incident while keeping link, decoder, and unattributed evidence domains distinct.
5. Reconcile retained totals with transport-reported totals, endpoint-attribution totals, and the capture-scoped bridge journal when those observations are available. For UDP, distinguish exact payload bytes, estimated UDP bytes, minimum estimated IP bytes, and unavailable link or radio layers.

**Current constraints:** A version 2 receipt and provenance document can attest only to observations exposed by the local adapters. On Linux, ReplayCase samples `/proc/self/net/udp` or `udp6` at capture start and stop after identifying one process-owned socket inode, then reports the nonnegative drop delta as `linux-proc-net-udp-socket`. macOS, Windows, unreadable procfs, ambiguous socket identity, and counter regression remain explicitly unavailable rather than zero. A positive measured delta makes the receipt incomplete and produces a capture-path diagnostic without changing retained raw records. Payload bytes are observed exactly; UDP bytes are deterministic estimates; IP bytes are minimum estimates under stated header and fragmentation assumptions; radio and link-layer bytes remain unavailable. Earlier version 2 sessions and version 1 provenance that predate this contract remain valid and are not rewritten.

**Implementation evidence:** [integrity types](src/domain/types.ts), [Linux UDP socket-drop adapter](scripts/udp-kernel-drop-counter.mjs), [bridge integration](scripts/capture-bridge.mjs), [capture finalization](src/capture/recorder.ts), [session validation and diagnostics](src/domain/session.ts), [socket-drop adapter tests](scripts/udp-kernel-drop-counter.test.mjs), [session integrity tests](src/domain/session.test.ts), [receiver reconciliation tests](verifier/evidence-verifier.test.ts), the [capture attribution contract](docs/architecture/udp-capture-attribution.md), and the [cross-browser capture-to-evidence gate](tests/e2e/capture-to-evidence.spec.ts).

## UC-004 — Compare captures and prove regressions

**Actor:** Test, protocol, or reliability engineer

**Outcome:** Decide whether one controlled change improved, regressed, or left a constrained-telemetry behavior unresolved, then export a portable finding that another engineer can validate and reproduce from the same two identified inputs.

**Workflow:**

1. Select an exact incident in a validated replay or open a verified `.nlb`, then choose **Compare** to make that bounded evidence the baseline.
2. Load a candidate `.nlsession`, `.json`, or `.nlb`. ReplayCase validates sessions through the normal cancellable worker and decoder pipeline and verifies bundles through the production receiver before allowing comparison; choose the candidate incident when a whole session was loaded.
3. Declare range-start alignment or a named shared event with exact baseline and candidate microsecond anchors. ReplayCase computes only the intersecting relative interval in a worker, reports progress, allows cancellation back to setup, and reports unmatched tails.
4. Review comparability separately for alignment, packet evidence, capture evidence, diagnostics, decoded fields, and link observations. Inspect packet rate, complete-packet proportion, integrity-failure rate, warning or critical diagnostic rate, available RSSI, and exactly matching numeric fields only where their evidence bases allow it.
5. Select any metric to trace its baseline and candidate values, reason, total supporting evidence counts, the first 64 source IDs, and limitations.
6. Record an operator conclusion and export the bounded `.nlcompare.json` finding. Validate and reproduce it with the same two exact source inputs before treating the result as regression proof.

**Current constraints:** ReplayCase does not infer synchronized clocks, discover matching events, establish causality, or claim that higher traffic or an arbitrary decoded value is better. Range-start alignment means only that both selected starts are treated as relative zero; shared-event alignment depends on operator-supplied exact anchors inside both half-open ranges. Packet, diagnostic, and decoded-field deltas require the exact same decoder, schema, pack, and runtime identity plus selected raw support in both inputs. RSSI deltas require one matching evidence basis, and decoded-packet RSSI also requires the same decoder identity. Capture evidence is assessed separately and can remain review-required, incomplete, unknown, or unavailable. A bundle exposes only the evidence it carries. Session candidates share the 64 MiB, 200,000-record, 24-hour replay envelope; comparison construction projects only the selected ranges, but both active inputs and the bounded result remain in browser memory. The finding is bounded to 1 MiB, cites but does not embed either source, and is unsigned; its canonical SHA-256 catches content alteration but does not prove authorship, source-channel authenticity, or the cause of a measured difference. The current source build can also retain bundle-to-bundle findings inside a portable case under UC-006; standalone `.nlcompare.json` import is not supported.

**Implementation evidence:** [comparison contract, metrics, and finding validator](src/domain/comparison.ts), [comparison workspace](src/comparison/ComparisonWorkspace.tsx), [worker comparison processor](src/processing/comparison-processing.ts), [comparison domain tests](src/domain/comparison.test.ts), the [controlled real-UDP comparison and finding gate](tests/e2e/comparison-workspace.spec.ts), the [maximum-record comparison and bundle gate](tests/e2e/large-session-processing.spec.ts), [comparison accessibility and responsive coverage](tests/e2e/accessibility.spec.ts), and the [unpacked-release receiver-to-session comparison gate](tests/release/capture-to-evidence.spec.ts). Decoder and pipeline regressions remain backed by the [fixture generator](scripts/generate-demo-session.mjs), [conformance runner](src/domain/decoder-conformance.ts), [decoder-pack tests](src/domain/decoder-pack.test.ts), [pack CLI tests](scripts/replaycase-decoder.test.mjs), and [fixture integration tests](src/domain/fixture.integration.test.ts).

## UC-005 — Hand off a verifiable incident bundle

**Actor:** Operator and receiving engineer

**Outcome:** Package one exact incident range with enough local evidence for another engineer to inspect and verify the received archive through a production, offline receiver workflow.

**Workflow:**

1. Select the operator-authored half-open incident range.
2. Add the relevant markers and notes, choose optional artifact groups, retain the decoder schema when the receiver must reproduce a non-built-in pack, and keep the mandatory transport events, provenance, bridge journal, and capture-integrity receipt.
3. Generate the `.nlb` ZIP archive in a worker while following phase progress. Cancelling terminates construction and produces no download; completing it downloads the exact archive.
4. On the receiving machine, select **Open evidence** and choose the `.nlb`; ReplayCase runs the production verifier in a worker before replacing the current workspace. Use `replaycase verify incident.nlb` or add `--json` when a terminal or machine-readable report is also required.
5. Review internal consistency, evidence completeness, and source authenticity as separate claims, then inspect the exact included timeline, rows, diagnostics, source annotations, transport evidence, decoder identity, and explicit unavailable groups.
6. Record any receiver-owned finding in the separate **Notes** tab and compare the bundle and pack identities through a separately trusted channel when authenticity matters.

**Current constraints:** The application receiver and CLI accept bounded version 3 and 4 `.nlb` bundles and treat their ZIP structure and contents as untrusted input; v0.4.0 writes version 4, while v0.2.0 writes and reads version 3. Upgrade the receiver before sending a version 4 bundle. Raw NDJSON and decoded CSV artifacts are each limited to 100,000 rows, so a replay above that count requires a narrower selected incident when those groups are included. The receiver reconstructs only the selected evidence carried by the archive; it does not fabricate excluded artifacts or whole-session context. When the exact pack is available, the verifier validates pack identity and fixtures and reproduces decoded rows from selected raw records. Excluding the schema artifact can prevent replay-checking a local pack and produces an explicit warning. A passing result establishes internal consistency, not complete capture evidence: a valid bundle can truthfully report `incomplete` or `unknown` capture or provenance evidence. Version 3 and 4 bundles and decoder packs are unsigned, so the verifier reports authenticity as not established and cannot prove who created them or whether the originating build was trustworthy. Receiver findings are local browser records keyed by the exact bundle SHA-256; they are not embedded in, signed with, or exported from the source archive. A receiver can start UC-004 from the verified bundle, but its separately stored note is not copied into the comparison; only a conclusion explicitly authored in that workspace is exported in the separate `.nlcompare.json`. Raw telemetry, coordinates, identifiers, and notes may be sensitive and must be reviewed before sharing. The software handoff path is automated, but this repository has not yet recorded a real-source, second-person field handoff; follow the [field-proof procedure](docs/field-proofs/README.md) before making that claim.

**Implementation evidence:** [shared evidence contract](src/domain/evidence-contract.ts), [bundle builder](src/domain/bundle.ts), [worker bundle processor](src/processing/evidence-bundle-processing.ts), [production receiver verifier](verifier/evidence-verifier.ts), [bounded ZIP reader](verifier/evidence-zip.ts), [browser receiver loader](src/receiver/load-evidence-bundle.ts), [bounded receiver document](src/receiver/receiver-document.ts), [receiver workspace](src/receiver/ReceiverWorkspace.tsx), [separate receiver findings](src/receiver/receiver-storage.ts), [receiver and pack CLI](scripts/replaycase.ts), [bundle tests](src/domain/bundle.test.ts), [receiver verifier and document tests](verifier/evidence-verifier.test.ts), the [cross-browser NSL-01 and NMEA capture-to-receiver gate](tests/e2e/capture-to-evidence.spec.ts), the [maximum-record cancellation and verified-bundle gate](tests/e2e/large-session-processing.spec.ts), [receiver accessibility and reflow coverage](tests/e2e/accessibility.spec.ts), and the [artifact-local receiver and replacement gate](tests/release/).

## UC-006 - Investigate and hand off a multi-bundle case

**Actor:** Investigating engineer and receiving engineer

**Outcome:** Preserve a baseline/failure/post-fix investigation with exact source bytes, cited authored findings, open questions, and reproducible comparisons so another compatible installation can continue without the original laptop.

**Workflow:**

1. Create a case and add verified `.nlb` artifacts. Exact duplicates share one bundle identity.
2. Inspect individual bundles without changing their evidence. Author a finding or question with exact included range, raw-record, or diagnostic citations.
3. Select two distinct bundles and explicitly align their ranges through UC-004. Add the comparison finding to the case.
4. Save locally or export `.nlcase`. On another installation, import it to reverify the archive, each original bundle, every citation, and every reproduced comparison.
5. Save and reopen the received case, continue authored investigation, or remove the saved case while retaining any open in-memory copy and exported files.

**Current constraints:** Available in the current source build, not the published v0.4.0 package. The case is bounded to 16 distinct bundles, 48 MiB of stored bundle bytes, 64 MiB of aggregate expanded nested artifacts, and a 1 MiB canonical manifest inside a 64 MiB outer archive. Findings/questions are limited to 200, with 1-16 citations and 4,000 characters each; summaries are 4,000 characters; comparisons are limited to 16 subject to the manifest budget. Bundles remain unsigned and retain their own incomplete/unknown capture states. Case context does not establish causal truth or source authenticity. There is no session concatenation, automatic clock alignment, raw-session import, standalone comparison-file import, signing, or collaboration. Conflicting saved revisions are rejected, not merged. Receiver-local notes remain separate. Storage is origin-scoped and unencrypted; review every embedded artifact before sharing. Offline use needs a running local application server, not an external service. The automated clean-profile workflow is not a real-source second-person field handoff.

**Implementation evidence:** [Case format and trust contract](docs/architecture/case-workspace.md), [case domain](src/domain/case.ts), [production verifier and adversarial tests](verifier/case-verifier.test.ts), [worker boundary](src/cases/case-processing.ts), [atomic case library tests](src/storage/case-library.test.ts), [case workspace](src/cases/CaseWorkspace.tsx), [clean-profile browser handoff gate](tests/e2e/case-workspace.spec.ts), and [unpacked-installation gate](tests/release/case-workspace.spec.ts).

## Maintaining this log

1. Assign the next `UC-###` identifier and never renumber an existing use case.
2. Describe an operator goal and observable outcome, not a component or implementation task.
3. Cite the current implementation and automated evidence that justify the stated support level.
4. Keep unsupported outcomes in the roadmap or an issue until an end-to-end workflow exists.
5. When support or constraints change, update the existing entry and add the notable change to the changelog; do not append historical notes here.
