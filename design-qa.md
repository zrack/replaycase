# ReplayCase Design QA

This document records the currently accepted visual baseline and verification
boundary. Product history belongs in [CHANGELOG.md](CHANGELOG.md), and planned
work belongs in [ROADMAP.md](ROADMAP.md).

## Visual Contract

The [mission-timeline source](docs/design/narrowslink-mission-timeline-source.png)
remains authoritative for composition, density, geometry, typography, and color.
The approved ReplayCase wordmark and RC mark supersede the source image's legacy
branding, as recorded in [AGENTS.md](AGENTS.md). No other layout redesign is part
of this baseline.

Preserve the 232-pixel session rail, compact command bar, aligned overview and
telemetry lanes, 280-pixel incident rail, amber half-open selection, square
controls, one-pixel structure, Inter interface text, and IBM Plex Mono data.
Charts and annotations must come from real loaded evidence. Never fabricate
saved sessions, counters, markers, or notes to match the prototype.

## Current Screenshots

These are unedited browser captures. The session, capture, receiver, and comparison
images use the ReplayCase 0.4.0 production build served locally in managed mode.
The case images use the unreleased source production build. Source runtimes may
display `build unknown`; the images establish appearance, not published-package
identity.

| Surface | Evidence | State |
| --- | --- | --- |
| Session review | [Desktop](docs/assets/replaycase-dashboard.png) | 1487 x 1058; bundled Harbor relay; paused link-fade preset; empty library; no authored context |
| Narrow desktop | [1220-pixel view](docs/design/replaycase-narrow.png) | Same replay and preset; readable packet-family gutter |
| Mobile review | [390-pixel view](docs/design/replaycase-mobile.png) | 390 x 844 viewport, full-page capture; internally scrollable timeline and evidence table |
| Managed capture setup | [Desktop](docs/design/replaycase-capture-setup.png) | NSL-01, unsaved setup, managed bridge, loopback bind, ephemeral UDP port |
| Mobile capture setup | [Mobile](docs/design/replaycase-capture-mobile.png) | 390 x 844; bounded dialog with reachable primary action |
| UDP preflight | [Observed traffic](docs/design/replaycase-preflight.png) | 24 synthetic NSL-01 datagrams, 737 bytes, 24 valid frames, no malformed frames, one loopback endpoint |
| Evidence receiver | [Desktop](docs/design/replaycase-receiver.png), [mobile](docs/design/replaycase-receiver-mobile.png) | Verified v4 archive from the fixture's exact link-fade incident; 179 raw/decoded records, 11 diagnostics; unknown legacy integrity and unsigned authenticity remain explicit |
| Comparison | [Desktop](docs/design/replaycase-comparison.png), [mobile](docs/design/replaycase-comparison-mobile.png) | Received incident versus the same fixture range, explicit range-start alignment; no source-clock synchronization inferred |
| Local case | [Desktop](docs/design/replaycase-cases.png), [mobile](docs/design/replaycase-cases-mobile.png) | Three controlled file-source bundles, one cited question, and one reproduced comparison; unknown capture integrity and unestablished authenticity remain visible. Not a field test. |

![ReplayCase session review](docs/assets/replaycase-dashboard.png)

The original source and older design artifacts remain historical geometry
references. They are not current ReplayCase screenshots or evidence of a new
field test. Operator-facing documentation uses the current captures above.

## Verification

- ReplayCase wordmark, RC mark, browser title, loading/error copy, accessible file
  labels, capture build label, receiver, and comparison branding are consistent.
- The desktop and mobile captures retain the original instrument layout. The
  page remains bounded at 1487, 1220, 1060, 960, 640, and 390 CSS pixels; wide
  evidence surfaces use their intentional internal scrollers.
- The preflight capture used a real loopback socket and synthetic fixture
  datagrams. Probe traffic was stopped without being retained as a session.
- The screenshot bundle passed the same production receiver in ReplayCase and
  the published NarrowsLink v0.3.0 CLI with matching reports and unchanged bytes.
- The source-browser gate covers replay, import, persistence, failure recovery,
  real UDP, simulated Web Serial, incident authoring, export, receiver,
  comparison, axe WCAG A/AA rules, focus, reflow, and keyboard scrolling in
  Chromium, Firefox, and WebKit.
- The packaged gate verifies both CLI names, installed release identity,
  capture-to-evidence, package replacement with same-origin persistence, and the
  200,000-record replay tier in all three engines.
- Compatibility tests pin the legacy fixture and decoder hashes and retain
  storage, comparison-finding, and receiver-note behavior. Branding does not
  rewrite or reinterpret captured evidence.
- The case gate covers source-preserving handoff into a clean browser profile,
  exact citations, comparison reproduction, persistence, draft preservation,
  quota failure, cancellation, axe A/AA rules, and 390-pixel reflow across the
  three engines. External HTTP origins are blocked while the local application
  server remains available; this is not serverless browser-offline support.
- The unpacked-installation case gate verifies import, durable save/reopen, and
  byte-identical re-export outside the source checkout in all three engines.

## Boundaries

No actionable branding or layout defect remains in the checked surfaces.
The UI's explicit unknown/incomplete evidence and unsigned authenticity states
are intentional. A successful software gate is not a physical radio or serial
adapter test, manual assistive-technology certification, or an independent
second-person field handoff. Those boundaries remain documented in
[ACCESSIBILITY.md](ACCESSIBILITY.md) and the [field-proof procedure](docs/field-proofs/README.md).
