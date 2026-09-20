# Changelog

All notable changes to ReplayCase (formerly NarrowsLink) are recorded here. This is the canonical project history: the README describes the product as it works now, the use-case log catalogs current operator outcomes, the roadmap contains planned work, the design QA record holds the currently accepted visual evidence, and collaboration documents define current policy.

## [Unreleased]

### Added

- Added a local multi-bundle case workspace with exact-byte bundle deduplication, cited findings and questions, existing-engine comparisons, independently reproduced comparison findings, and portable `.nlcase` archives. Case imports and reopens reverify every nested bundle under aggregate archive limits; worker cancellation, atomic local persistence, corruption checks, and revision conflicts preserve the active investigation. Added controlled clean-profile handoff, storage-failure, archive-rejection, accessibility, and responsive regression coverage.
- Added task-based documentation navigation, a linked source and test map, and design and architecture indexes. Contributor guidance now separates generated Graphify output from source and requires explicit source identity and extraction scope when refreshing maps.

### Fixed

- Synchronized the storage-cleanup browser regression with the save operation's focus handoff and verified the operator note before removal, so interrupted text entry cannot masquerade as a note-retention failure.

## [0.4.0] - 2026-09-10

### Changed

- Renamed the GitHub repository, application, RC mark, CLI, release package, current documentation, and operator screenshots to ReplayCase. Release assets use `replaycase-<version>` and identify `zrack/replaycase` as their source.
- Retained `narrowslink` as a CLI alias and the old runtime-discovery path and environment variables as compatibility fallbacks. Upgrades from the old npm package must uninstall it before installing ReplayCase to avoid a command-name collision; browser storage and exported evidence are not removed.
- Preserved existing session, bundle, decoder-pack, comparison, and machine-report formats, file extensions, browser storage keys, deterministic fixture bytes, and published decoder identities. Historical release notes and dated proof records retain their original names and commands.

## [0.3.0] - 2026-09-09

### Added

- Added a capture-scoped Linux UDP socket-drop adapter that reconciles `/proc/self/net/udp` or `udp6` with the bridge process socket inode, preserves explicit unavailable reasons on unsupported or ambiguous hosts, and projects positive measured drops into immutable transport evidence and capture-path diagnostics.
- Added UDP transport-provenance schema version 2 with exact observed payload bytes, deterministic UDP overhead, minimum IPv4 or IPv6 estimates under explicit assumptions, and unavailable link and radio layers.
- Added evidence-bundle version 4 with receiver recomputation of UDP byte accounting and cross-document host-drop reconciliation while retaining bounded read compatibility for version 3 bundles.

### Changed

- Replaced the timing-sensitive one-second large-session heartbeat assertion with a five-second hard gap ceiling plus a 50% accumulated timer-delay ratio, while retaining the 768 MiB Chromium heap-growth budget.
- Expanded replay and receiver provenance inspectors to show host UDP drop-counter status, observation source, layered byte accounting, and the UDP-socket claim boundary.
- Refocused the roadmap on a real non-demo, second-installation field handoff and separated future signed identity from capture-path attribution.

### Fixed

- Detached a removed active replay from persisted workspace writes even when residual marker, note, or authored-range cleanup fails, preventing stale cleanup state from erasing the still-open in-memory note in WebKit.
- Kept the packet-family heading inside the narrow timeline gutter and above its first family label without changing the desktop lane geometry.

### Security

- Updated the PostCSS and Browserslist development dependencies to address GHSA-fxqj-rqcc-2cmp and GHSA-73wf-gq98-2v4g, with regression checks for untrusted source-map annotations and malformed custom browser statistics. Ordinary CSS processing, explicit source maps, and valid browser statistics remain supported.

### Documentation

- Documented the UDP capture-attribution contract, bundle compatibility, independent field-proof procedure, and a dated pending readiness result that does not substitute loopback or simulated-device coverage for physical evidence.
- Aligned operator installation and receiving instructions with the v0.3.0 package. Version 4 bundles require a v0.3.0 receiver; older version 3 bundles and version 1 and 2 sessions remain readable. Added a concrete pending pilot plan and recipient worksheet without claiming a completed field handoff.

## [0.2.0] - 2026-07-25

### Added

- Added reusable local capture profiles that preserve validated UDP or serial settings and the exact decoder pack while explicitly excluding bridge credentials, browser device permission, session names, and telemetry payloads.
- Added bounded UDP and Web Serial preflight before recording, with live source state, traffic and byte rates, last-input age, valid and malformed frame counts, checksum failures, message families, endpoint observations, no-traffic guidance, and decoder-mismatch guidance.
- Added an explicit preflight-to-evidence boundary: UDP probes are stopped and discarded before a new owned capture ID begins, while serial retains the selected port but resets framing and routes only future reads into the immutable session.
- Added bounded, content-addressed decoder packs with an allowlisted parser runtime, canonical pack and schema identities, production-path conformance fixtures, local operator loading, and packaged `decoder seal` and `decoder validate` commands; new captures persist the exact pack and runtime while legacy NSL-01 sessions remain compatible and unchanged.
- Added the NMEA 0183 reference pack for checksummed GGA, RMC, and HDT sentences over one-sentence-per-datagram UDP or line-delimited serial input, including partial-tail retention, checksum diagnostics, real loopback UDP capture, local-library reopen, evidence export, and production receiver replay verification.
- Added an in-application receiver workspace for untrusted version 3 `.nlb` bundles: worker-isolated production verification now precedes inspection, the exact bounded incident is reconstructed only from included evidence, excluded context remains explicit, and internal consistency, evidence completeness, and unsigned authenticity remain separate claims.
- Added receiver-owned findings stored separately under the whole-bundle SHA-256 without modifying source evidence, plus NSL-01 and NMEA capture-to-receiver, rejection recovery, reload, accessibility, responsive-layout, and unpacked-release replacement coverage across Chromium, Firefox, and WebKit.
- Added bounded comparative replay for a selected session incident or verified evidence-bundle range against a validated `.nlsession` or verified `.nlb`: explicit range-start or named shared-event alignment, exact overlap and unmatched-tail accounting, conservative evidence comparability, traceable metric deltas, and a checksummed `.nlcompare.json` finding that cites but never modifies or embeds either source.
- Added a controlled real-UDP regression proof with one induced integrity failure, semantic finding validation, responsive and axe coverage, and unpacked-release receiver-to-session comparison across Chromium, Firefox, and WebKit.
- Added worker-isolated session import and saved-session reopen with deterministic chunk transfer, weighted phase progress, and cancellation that preserves the active workspace and never persists partial content; candidate loading, bounded comparison construction, and evidence-bundle construction use the same cancellable processing boundary.
- Added a streamed deterministic 200,000-record acceptance corpus and source plus unpacked-release browser gates that import, persist, cancel, reopen, compare an exact 10,000-record range, cancel and rebuild a bundle, and verify its contents in Chromium, Firefox, and WebKit against published heartbeat and Chromium heap-growth budgets.
- Added version 3 IndexedDB session records containing exact canonical bytes, with validated read compatibility for existing version 1 text and version 2 Blob records.

### Changed

- Promoted decoder packs, NMEA 0183, the in-application receiver, comparative replay, worker-backed large-session processing, and field-capture preflight into the self-contained v0.2 operator distribution.
- Generalized the annotated-tag release workflow so the package version, release notes, asset names, and GitHub Release remain bound to one `v<package-version>` identity.
- Defined NarrowsLink's product goal and success criteria around reproducible constrained-telemetry incidents and independently verified handoffs; retained the strategic product directions and moonshot opportunities while keeping delivered capabilities in the changelog and current-state docs.
- Expanded UC-001 with supported radio transport capture topologies, including USB serial radio, UDP base-station output, forwarded UDP copies, and network multicast observer setup and test paths.
- Raised the imported and saved replay envelope from 32 MiB and 100,000 records to 64 MiB and 200,000 records while retaining the separate live-capture ceiling of 100,000 records, 32 MiB of retained payload bytes, 24 hours, and a canonical file within the replay limit.

## [0.1.0] - 2026-07-24

### Added

- Reproducible, dependency-free operator distribution containing the production UI, authenticated UDP bridge, deterministic fixture, and receiver CLI; one `narrowslink serve` command starts the managed local application without token transfer, while release assets include exact build identity, a normalized CycloneDX SBOM, published checksums, and an unpacked-artifact capture-to-verification acceptance gate.
- Cross-browser release gate for the complete UDP capture-to-evidence loop, including real loopback recording, `.nlsession` reimport and deduplication, replay and authored investigation context, independently verified `.nlb` contents and checksums, reload/reopen/removal, and surfaced storage or download failures.
- Cross-browser simulated Web Serial capture-to-evidence release gate, including fragmented reads, complete and partial NSL-01 assembly, reconciled v2 integrity and device provenance, canonical-session deduplication and reopen, exact-range export, and production receiver verification, while retaining physical hardware and native permission behavior as a manual boundary.
- Automated axe rules tagged WCAG A/AA, critical keyboard and focus-handoff coverage, narrow and `200%`-equivalent reflow checks, forced-color evidence cues, and a documented accessibility support boundary.
- Content-addressed local session library with IndexedDB persistence, real session metadata, validated reopen, exact-content deduplication, explicit replay-and-workspace removal, and surfaced storage, cleanup, or corruption failures.
- Canonical use-case log with stable IDs, actors, outcomes, current constraints, and implementation evidence for five supported workflows.
- Mission-timeline-first local session review with a deterministic bundled replay, one synchronized replay clock, telemetry and decoder lanes, incident narrative, details and statistics, markers, and operator notes.
- Validated session import and NSL-01 decoding that preserve malformed and partial frames while deriving link, inferred missing-frame, jitter, decoder, diagnostic, and decoded-signal evidence.
- Bounded live UDP and Web Serial capture, including an authenticated local UDP bridge and stop/save/replay through the same validation and decoder pipeline used by imported sessions.
- Operator-authored half-open incident ranges with exact microsecond boundary editing, timeline resizing, per-session persistence, and exact-range export. (#17)
- Session format v2 transport-event logs and terminal capture-integrity receipts, capture-path diagnostics, and explicit unknown integrity for unchanged legacy v1 imports. (#18)
- Independently auditable transport provenance for new captures, including per-datagram UDP endpoint attribution, a bounded bridge-side lifecycle journal, explicit unavailable host drop counters, serial device and negotiated-setting evidence, a structured workspace inspector, and mandatory provenance artifacts in evidence bundles.
- Locally generated `.nlb` evidence archives with selectable artifacts, mandatory transport events, provenance, bridge journals, and integrity receipts, plus manifest metadata, record counts, byte sizes, and SHA-256 checksums.
- Production receiver CLI for bounded, offline verification of version 3 `.nlb` bundles, with strict archive, path, artifact, session-duration, and cross-document validation; human-readable and stable JSON reports; and separate internal-integrity, evidence-completeness, and unsigned-authenticity verdicts.
- MIT licensing.
- GitHub collaboration infrastructure, including CI, issue forms, pull-request guidance, Dependabot, security and support policies, and a code of conduct. (#5, #14)

### Changed

- Made diagnostic severity and selected-incident state perceivable without color, made narrow timeline and evidence regions keyboard-scrollable, and preserved focus across capture phases, destructive confirmations, incident replacement, and responsive command wrapping.
- Renamed the project to NarrowsLink and adopted the mission-timeline-first product direction.
- Aligned the runnable desktop and responsive workspaces with the approved prototype and evidence-backed replay state.
- Separated optional Diagnostics from mandatory Capture integrity in bundle selection while keeping all six evidence controls visible in the accepted desktop workspace. (#18)
- Made this changelog the sole chronological project record and refocused the README, roadmap, design QA record, agent guidance, and contributor workflow on their current responsibilities.

### Security

- Restricted the UDP bridge control plane to loopback access with server-enforced capture ownership and an internal short-lived bearer credential; the browser uses a same-origin application relay, so the credential is not exposed in runtime metadata, URLs, cookies, readiness output, or logs.

[Unreleased]: https://github.com/zrack/replaycase/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/zrack/replaycase/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zrack/replaycase/releases/tag/v0.3.0
[0.2.0]: https://github.com/zrack/replaycase/releases/tag/v0.2.0
[0.1.0]: https://github.com/zrack/replaycase/releases/tag/v0.1.0
