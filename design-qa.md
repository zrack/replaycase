# NarrowsLink Design QA

This document records the currently accepted visual baseline and its verification evidence. Historical product changes belong in [CHANGELOG.md](CHANGELOG.md), and planned visual work belongs in [ROADMAP.md](ROADMAP.md).

## Comparison target

- Source visual truth: [mission-timeline source](docs/design/narrowslink-mission-timeline-source.png)
- Current browser-rendered implementation: [release desktop implementation](docs/design/implementation-release-desktop.png)
- Current responsive implementation: [release mobile implementation](docs/design/implementation-release-mobile.png)
- Current narrow-desktop packet-family geometry: [1220-pixel workspace](docs/design/packet-family-narrow.png), captured at `1220 x 900` with a full-page screenshot, the bundled replay paused, an empty library, and no authored markers or notes.
- Accepted source/geometry comparison from the preceding equivalent workspace state: [full comparison](docs/design/comparison-production-final.png)
- Accepted focused source/geometry comparison: [focused comparison](docs/design/comparison-production-focused.png)
- Responsive session-library dialog evidence: [responsive library implementation](docs/design/implementation-functional-mobile.png)
- Capture-integrity functional evidence: [incomplete UDP capture replay](docs/design/implementation-capture-integrity.png)
- Field-capture setup evidence: [capture profile setup](docs/design/capture-profile-setup.png)
- Field-capture preflight evidence: [verified UDP preflight](docs/design/capture-preflight-ready.png)
- Responsive field-capture evidence: [mobile capture setup](docs/design/capture-profile-mobile.png)
- Received-incident evidence workspace: [verified receiver workspace](docs/design/receiver-workspace.png)
- Comparative replay evidence workspace: [bounded comparison workspace](docs/design/comparison-workspace.png)
- Desktop viewport: `1487 × 1058`, matching the `1487 × 1058` source image at device scale factor `1`; the capture-profile and preflight implementation images are also `1487 × 1058` at device scale factor `1`, so no density normalization was required.
- Responsive viewport: `390 × 844` at device scale factor `1`; measured document, body scroll, and document scroll widths all equal `390 px`, and the open live-capture dialog measures `358 × 812 px`.
- State: bundled Harbor relay replay reopened from the library; replay paused inside the link-fade incident at `23:40`; Narrative tab; all six evidence groups selected; two genuine saved sessions; two local operator markers, one in the visible timeline; and a session-wide note present.
- Release-gate state: the same bundled incident and operator note with one genuine saved session, visible non-color diagnostic severity tokens, selected-incident semantics, and all six evidence groups selected.
- Comparison evidence state: the selected link-fade incident is compared with the same validated fixture at `1280 × 720` using explicit range-start alignment. Packet, diagnostic, decoded-field, and link evidence are comparable and unchanged; the overall result remains unresolved because both legacy-v1 capture-integrity assessments are unknown. The controlled real-capture regression is proven separately by the browser gate.
- Maximum-record evidence state: a generated 52,378,445-byte, 200,000-record replay opens in the unchanged mission workspace while import, saved-session reopen, candidate loading, comparison construction, and bundle construction use a compact modal with a named progress bar, current phase, percentage, and cancel action. The transient surface preserves the existing square, restrained instrument language and never displaces the active workspace until processing succeeds.
- Field-capture evidence state: the packaged managed bridge opened an ephemeral loopback socket, observed 24 real NSL-01 datagrams and 737 bytes from one endpoint, reported 24 valid frames with no malformed frames, identified Position and Attitude families, confirmed decoder fit, and kept the explicit preflight-to-recording boundary beside a persistent **Start recording** action.

### Current release result

[![NarrowsLink release-grade capture-to-evidence workspace](docs/design/implementation-release-desktop.png)](docs/design/implementation-release-desktop.png)

[![NarrowsLink release-grade responsive workspace at 390 by 844 pixels](docs/design/implementation-release-mobile.png)](docs/design/implementation-release-mobile.png)

### Accepted desktop comparison

[![Approved source beside the final NarrowsLink implementation](docs/design/comparison-production-final.png)](docs/design/comparison-production-final.png)

### Accepted responsive result

[![NarrowsLink responsive saved-session library at 390 by 844 pixels](docs/design/implementation-functional-mobile.png)](docs/design/implementation-functional-mobile.png)

### Accepted capture-integrity result

[![NarrowsLink showing an incomplete UDP capture as durable capture-path evidence](docs/design/implementation-capture-integrity.png)](docs/design/implementation-capture-integrity.png)

### Accepted receiver result

[![NarrowsLink showing an exact verified incident in the bounded receiver workspace](docs/design/receiver-workspace.png)](docs/design/receiver-workspace.png)

### Accepted comparison result

[![NarrowsLink comparing two explicitly aligned telemetry incidents](docs/design/comparison-workspace.png)](docs/design/comparison-workspace.png)

### Accepted field-capture result

[![NarrowsLink field setup with reusable capture profiles](docs/design/capture-profile-setup.png)](docs/design/capture-profile-setup.png)

[![NarrowsLink confirming UDP source traffic and decoder fit before evidence recording](docs/design/capture-preflight-ready.png)](docs/design/capture-preflight-ready.png)

[![NarrowsLink field setup at 390 by 844 pixels](docs/design/capture-profile-mobile.png)](docs/design/capture-profile-mobile.png)

## Final findings

No actionable P0, P1, or P2 visual findings remain.

The final implementation matches the source's primary composition and geometry: `232 px` source rail, compact session command bar, stacked overview plots, shared time grid, labeled telemetry lanes, `280 px` incident rail, amber half-open incident selection, and the full-width evidence workspace. The interface also retains square controls, quiet one-pixel structure, restrained warm-black surfaces, dense instrument typography, semantic chart colors, and a pale-blue export action.

Seven visible differences are intentional and accepted product, data, or accessibility constraints:

- The source mocks several active and recent sessions. The implementation shows one genuine loaded source plus two genuinely persisted sessions and does not present invented sessions as available data.
- The source shows a live-follow control. A recorded session truthfully exposes replay controls, while live capture remains available from the source rail and command bar.
- Packet-family gaps, decoder resynchronization, diagnostics, estimates, and bundle metadata are derived from the validated fixture rather than copied as decorative source values.
- Evidence rows describe the real local NarrowsLink archive contents and sizes rather than the source's illustrative PCAP and `24.7 MB` copy.
- The evidence table has a sixth required Capture integrity row so optional derived diagnostics remain independently selectable while the transport event log, provenance document, bridge journal, and receipt cannot be removed from a verifiable archive.
- Diagnostics add visible severity words or compact `C`/`W`/`I` tokens, and overview incidents expose selected-state treatment, so meaning is not carried by color alone.
- Live capture adds a compact local profile row and a bounded preflight state before recording. These controls extend the source-aligned dialog rather than changing the mission workspace, and their locked, warning, and ready states represent real source observations rather than decorative setup progress.

## Capture setup baseline

The capture action strip stays sticky inside the scroll-bounded, square-cornered dialog; **Save setup** and delete occupy separate narrow-screen grid tracks. The [desktop capture setup](docs/design/capture-profile-setup.png), [ready preflight](docs/design/capture-preflight-ready.png), and [mobile capture setup](docs/design/capture-profile-mobile.png) keep the current phase action visible without document overflow or control overlap.

## Focused comparison evidence

- Timeline: the final comparison confirms equivalent label and scale gutters, minute-aligned ticks, connection/received-packet-rate/inferred-missing-frame order (labeled Connection, Throughput, and Loss in the UI), five packet-family bands, extended decoder-resync state, diagnostic and marker lanes, geographic traces, and selected-range treatment.
- Packet-family heading: the `1487`, `1220`, `1060`, `960`, and `390` CSS-pixel regression checks keep the original font size, the heading inside its gutter, and its bottom edge above the first family label in Chromium, Firefox, and WebKit. Narrow layouts reclaim right padding and letter spacing rather than wrapping the heading over the first row; desktop lane geometry remains unchanged.
- Incident rail: the final comparison and current release evidence confirm equivalent range summary, selector, semantic tabs, compact chronological narrative, visible non-color severity tokens, and session-wide operator-note region.
- Evidence workspace: the current full and focused comparisons confirm the summary-to-table hierarchy, operator context, estimated size/group count, source-aligned primary export placement, and a fully visible six-row table. Optional Diagnostics remains independently selectable while the sixth Capture integrity row is required.
- Source rail and header: widths, dividers, title/meta hierarchy, compact replay actions, loaded-source navigation, live capture, and dense real saved-session rows align with the prototype without fabricating availability.
- Session library: the current desktop and responsive evidence confirms two real IndexedDB entries, active-row treatment, meaningful date/duration/integrity metadata, guarded removal, a reachable narrow-screen dialog, and no horizontal body overflow.
- Capture integrity: the functional evidence confirms that an incomplete v2 receipt is visible in session context, its immutable UDP anomaly appears in the shared Diagnostics lane and Narrative as `Capture path`, and the evidence workspace keeps Capture integrity mandatory while Diagnostics remains optional.
- Transport provenance: a verified loopback capture confirms that the source-aligned incident rail can expose capture identity, bound socket, endpoint attribution, bridge totals, explicit unavailable kernel-drop evidence, lifecycle journal entries, and evidence boundaries without disturbing the mission timeline's density or hierarchy.
- Field capture: the current setup keeps profile recall, decoder identity, and transport configuration in that order; exposes live source, rate, last-input, validity, family, endpoint, and decoder-fit observations; states that probe bytes are excluded from evidence; and keeps the current transition action visible. At `390 × 844`, profile, decoder, transport, and sticky actions fit inside the `358 px` dialog without overlap or horizontal overflow.
- Received evidence: the accepted receiver keeps the same rail, compact command bar, warm-black one-pixel structure, dense instrument typography, shared timeline vocabulary, and inspector geometry while giving verification claims their own fixed band. Artifact counts, exact range, packet integrity, diagnostics, source evidence, and explicit unavailable states all come from the verified archive rather than decorative values.
- Comparative replay: the accepted comparison retains the same instrument language while replacing the mission timeline with two explicitly aligned source lanes, a comparability strip, bounded metric table, and fixed trace inspector. Input identities, range boundaries, overlap, unmatched tails, evidence IDs, and unresolved states come from the comparison contract rather than visual inference. At `390 × 844`, commands wrap into a stable two-column group, the eligibility matrix becomes two columns, timeline detail remains internally bounded, and document and body widths both remain `390 px`.
- Long-running processing: the modal uses the existing one-pixel structure, dense type scale, compact status hierarchy, and familiar secondary cancel action. Phase text and a native progress value communicate change without relying on animation or color, and the underlying validated workspace remains visually stable throughout cancellation.

## Required fidelity surfaces

- Fonts and typography: bundled Inter carries interface copy and IBM Plex Mono carries times, values, and protocol metadata. Uppercase micro-labels, numeric alignment, weight, and dense line heights were checked in the focused comparison.
- Spacing and layout rhythm: the viewport, rail and incident-panel widths, header and overview heights, label/scale gutters, lane baselines, evidence proportions, dividers, square corners, capture-profile grid, scroll-bounded dialog, and sticky action strip were compared at the stated desktop and mobile dimensions.
- Colors and visual tokens: warm near-black surfaces, muted gray structure, amber incident selection, green link/position data, blue received packet rate, red inferred missing frames, purple markers, cyan packet-family data, and pale-blue primary actions preserve the source semantics.
- Image and icon fidelity: the repository's NarrowsLink mark is reused as a real image asset. The source contains no photography or illustration. Recharts renders data plots and Phosphor supplies the icon family; no placeholder art, emoji, or improvised CSS/SVG illustration was introduced.
- Copy and content: session metadata, diagnostics, units, decoder state, bundle contents, profile exclusions, source observations, decoder-fit guidance, and preflight evidence boundary remain coherent and derived from application state instead of reproducing contradictory prototype numbers.
- Responsiveness: at `390 × 844`, the page has no horizontal body overflow, labels no longer collide, the command strip and Saved control remain reachable, the `358 px` library dialog fits the viewport, the telemetry surface uses its deliberate internal scroller, and panels preserve the desktop hierarchy.
- Accessibility review: semantic buttons, native checkboxes/selects, labels, tabs, dialogs, named progress bars, cancellation controls, focus treatment, status text, chart summaries, disabled states, reduced-motion behavior, non-color diagnostic cues, and narrow keyboard scrollers pass axe rules tagged WCAG A/AA plus interaction coverage in Playwright Chromium, Firefox, and WebKit. All three engines pass `960`, `640` (`200%`-equivalent), and `390` CSS-pixel reflow plus forced-color checks. This is not a claim of full accessibility compliance; packaged-browser screen-reader, native zoom, and hardware matrices remain manual follow-up work documented in [ACCESSIBILITY.md](ACCESSIBILITY.md).

## Primary interactions tested

- Played and paused the replay and changed speed to `2×`; the monotonic replay state updated as expected.
- Opened and closed the marker dialog.
- Switched from Narrative to Details and restored Narrative.
- Created an operator incident with exact `HH:MM:SS.ffffff` start/end values, confirmed `[start, end)` duration copy, and verified its projected empty-diagnostic state.
- Adjusted an authored start boundary from the overview with the keyboard; the timeline, incident rail, statistics, and bundle preview updated from the same range.
- Reloaded the page and confirmed the authored range survived versioned per-session local persistence.
- Renamed and extended the range in the shared editor, then exercised the guarded delete flow and kept the sample range.
- Built and downloaded a `15.2 KB` `.nlb` for the exact authored range; the success state reported the generated filename and verifiable local evidence.
- Imported a purpose-built v2 UDP failure replay and confirmed the incomplete receipt, sequence-discontinuity event, exact capture-path diagnostic, and narrative entry survived reopen and projected into the selected incident range.
- Built and downloaded `capture-integrity-browser-review-capture-integrity-incident.nlb`; the success state reported six selected groups and verifiable local evidence with Capture integrity locked on while Diagnostics remained independently selectable.
- Opened and closed the live UDP/serial capture setup.
- Selected the bundled NMEA pack and confirmed its runtime and pack identity updated together; the same controls reflowed without horizontal overflow at `390 × 844`.
- Saved, updated, reapplied, and removed a local capture profile while confirming the exact custom decoder pack and transport settings returned and bridge credentials, session title, device permission, and telemetry did not.
- Ran real UDP preflight with matching NSL-01 traffic, confirmed 24 valid frames and the observed endpoint, then proved probe records were absent after the new owned recording began.
- Ran a deliberate NMEA-decoder/NSL-01-traffic mismatch, confirmed the explicit warning path remained available, and stopped the probe without creating or saving a session.
- Ran simulated Web Serial preflight, retained one selected and opened device, reset framing at **Start recording**, and proved only reads after that boundary entered the session.
- Stopped preflight and confirmed the dialog returned to a zero-duration **Ready** state with an explicit no-session notice.
- Saved the bundled replay, reloaded the page, and confirmed its genuine IndexedDB row and active state survived browser navigation.
- Imported the exact same fixture and confirmed content-addressed deduplication kept the library at one entry and preserved the original saved order.
- Added a second validated session through the real repository path, confirmed newest-first ordering, reopened it from the rail, switched away and back, and verified its per-session operator note restored.
- Exercised removal confirmation and cancellation with keyboard focus, deleted the active library copy while keeping its replay and note in memory, restored the same session document, and confirmed the deleted workspace note did not resurrect.
- Opened and closed the responsive Saved `(2)` dialog at `390 × 844`; focus moved to the labeled heading and returned to the Saved control, with document and body widths both measuring `390 px`.
- Verified the final desktop document is exactly `1487 × 1058` with no page overflow.
- Verified the operator range editor at `390 × 844`; exact boundary fields stack cleanly and the primary action remains visible.
- Checked browser warnings and errors after the complete session-library flow: none.
- Checked and saved the capture-integrity replay at a `1487 × 1058` browser viewport with no document overflow; the header, required Capture integrity row, and all optional evidence controls remain visible in the accepted frame.
- Recorded 12 real fixture datagrams through an ephemeral loopback UDP bridge, stopped with verified v2 integrity, saved and reimported the `.nlsession`, replayed it, authored an exact half-open range plus marker and note, and independently verified every `.nlb` path, boundary, byte count, record count, manifest hash, and `SHA256SUMS` entry.
- Loaded a sealed, non-bundled `NMEA-0183-GIG-HARBOR` pack, recorded real GGA, RMC, and HDT UDP datagrams, retained a checksum failure as an inspectable diagnostic, and proved the custom pack, schema, runtime, raw records, decoded rows, and diagnostics survived `.nlsession` persistence and independent `.nlb` verification.
- Opened independently generated NSL-01 and NMEA `.nlb` files through the worker-isolated production verifier, inspected the exact bounded evidence in the receiver, restored a separately stored receiver finding after reload and re-import, and confirmed a malformed archive left the verified workspace unchanged.
- Verified the receiver workspace with axe rules tagged WCAG A/AA and without page-level overflow at `960 × 900`, `640 × 900`, and `390 × 844`; dense timeline marks remain visual evidence while the full-lane scrubber and exact packet table provide usable seek targets.
- Compared a clean real loopback UDP baseline with an independently verified candidate `.nlb` containing one controlled checksum failure; confirmed explicit range-start alignment, a comparable capture basis, regressed integrity-failure rate, bounded source IDs with complete supporting counts, an authored conclusion, and production semantic validation of the downloaded `.nlcompare.json`.
- Compared a verified receiver bundle with its exact source session in the unpacked release using named shared-event anchors, exported an unchanged finding, returned to the receiver, and continued the existing replacement workflow without losing the separately stored receiver note.
- Verified the comparison setup and workspace with axe rules tagged WCAG A/AA, keyboard-scrollable evidence regions, and no page-level overflow at `960 × 900`, `640 × 900`, and `390 × 844` in Chromium, Firefox, and WebKit.
- Recorded a 24-datagram loopback acceptance capture and visually confirmed the verified Provenance tab reconciled all 24 records and 737 retained bytes to one exact remote endpoint and a clean two-entry bridge journal while preserving the unavailable host-drop-counter boundary.
- Exercised simulated Web Serial device selection through four fragmented reads, retained four complete frames and one terminal partial frame without byte loss, saved and deduplicated the canonical v2 session, reopened and replayed it from IndexedDB, authored an exact half-open range, and verified the downloaded `.nlb` with the production receiver in Chromium, Firefox, and WebKit. Physical device, driver, and native permission behavior remains a manual boundary.
- The v0.3 packaged-release gate verifies the managed production workspace, authenticated capture setup, UDP preflight, and absence of browser errors. Profile and preflight visual anatomy remain defined by the accepted captures above; native hardware and manual screen-reader certification remain outside this automated result.
- Repeated the capture-to-receiver, replay/library, failure-recovery, axe rules tagged WCAG A/AA, focus-handoff, responsive, keyboard-scroller, and forced-color gates in Playwright Chromium, Firefox, and WebKit.
- Imported the deterministic 52,378,445-byte, 200,000-record corpus with visible phase progress, retained interaction heartbeats, exact canonical-byte persistence, and no workspace replacement on cancellation; then reopened it, compared its exact 10,000-record incident, cancelled one bundle build without a download, rebuilt it, and verified exactly 10,000 raw and decoded records through the production receiver in Chromium, Firefox, and WebKit.
- Repeated the maximum-record import, persistence, reload, reopen, and progress path from the independently built unpacked operator distribution in Chromium, Firefox, and WebKit.
- Current release evidence: TypeScript validation, `302` tests across `39` files, the production application and CLI builds, CLI smoke verification, `55` passing source-workspace Playwright checks with `2` intentional engine-redundant cancellation skips, two byte-identical release compilations, and all `6` unpacked-package capture-to-receiver and maximum-record checks across Chromium, Firefox, and WebKit passed.

## Implementation checklist

- [x] Preserve the approved mission-timeline composition and instrument-grade visual language.
- [x] Match source and implementation at the same viewport and replay state.
- [x] Keep the fixture and imported sources on the same validation, decode, replay, incident, and export pipeline.
- [x] Preserve malformed and partial frames as inspectable diagnostics.
- [x] Preserve capture-path anomalies, endpoint or device provenance, bridge journal, and terminal integrity receipt through replay, operator range projection, and checksummed export.
- [x] Populate the source rail with real durable sessions and preserve validated reopen, explicit removal, and responsive access.
- [x] Preserve exact source identities, explicit alignment, bounded comparability, evidence traceability, and unresolved states through comparative replay and checksummed finding export.
- [x] Preserve exact profile setup, bounded non-evidence preflight, and an explicit UDP or serial transition into immutable recording.
- [x] Keep maximum-record import, reopen, selected-range comparison, and bundle construction responsive, cancellable, deterministic, and free of partial persistence or downloads.
- [x] Gate the full capture-to-evidence loop, independent archive verification, storage failures, keyboard focus, and automated accessibility across the supported browser-engine matrix.
- [x] Verify desktop, responsive, and primary interaction states.
- [x] Resolve every P0, P1, and P2 visual QA finding.

final result: passed
