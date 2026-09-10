# ReplayCase accessibility

ReplayCase treats keyboard access, durable focus, non-color evidence cues, and responsive reflow as release requirements for the local capture-to-evidence and comparative-replay workflows. This document records the current support evidence and its limits; it is not a certification of complete WCAG conformance or every browser, operating system, device, and assistive-technology combination.

## Automated release matrix

The Playwright suite runs against Chromium, Firefox, and WebKit in `npm run check` and repository CI.

| Surface | Chromium | Firefox | WebKit | Evidence |
| --- | --- | --- | --- | --- |
| Bundled and local replay | Pass | Pass | Pass | Invalid import recovery, playback, seeking, rate changes, and active-replay preservation |
| Local session library | Pass | Pass | Pass | Save, exact-content deduplication, reload, validated reopen, workspace restoration, guarded removal, and unavailable/quota/corruption/cleanup failures |
| Maximum-record processing | Pass | Pass | Pass | A 200,000-record replay is imported, persisted, cancelled during reopen without state loss, reopened, compared over an exact bounded range, cancelled during bundle construction without a download, rebuilt, and verified while the gate rejects a heartbeat gap above five seconds or accumulated timer delay above 50% of the measured operation |
| UDP capture-to-evidence loop | Pass | Pass | Pass | Real loopback NSL-01 and NMEA preflight, decoder-fit and mismatch states, explicit new-capture boundary, reconciled v2 receipt, `.nlsession` download and reimport, replay, exact incident export, independent archive verification, in-application receipt, reload, and failure recovery |
| Simulated Web Serial capture-to-evidence loop | Pass | Pass | Pass | Injected browser API, preflight on one selected device, future-read handler transfer without reopen, fragmented reads, complete and partial NSL-01 assembly, reconciled v2 receipt, durable reopen, replay, exact authored range, `.nlb` generation, and independent archive verification |
| Received evidence workspace | Pass | Pass | Pass | Exact bounded incident, separate verification claims, explicit unavailable groups, decoded and raw evidence, provenance, source annotations, separate receiver finding, rejected-archive recovery, reload, and unpacked-release replacement |
| Comparative replay workspace | Pass | Pass | Pass | Explicit baseline and candidate setup, validated session and verified-bundle input, aligned range control, eligibility matrix, metric selection, bounded source trace, authored conclusion, finding export, and clean state for a new comparison |
| axe rules tagged WCAG A/AA | Pass | Pass | Pass | Automated scans of the replay, receiver, and comparison workspaces plus live-capture, range, marker, bundle, comparison-setup, and long-running processing dialogs |
| Keyboard and focus handoff | Pass | Pass | Pass | Dialog entry/return, incident tabs, range deletion, incident clear/select, capture ready-to-preflight-to-recording transitions, captured-session replacement, comparison setup, and authored finding controls |
| Reflow and horizontal evidence access | Pass | Pass | Pass | Replay, receiver, and comparison workspaces at `960 × 900`, `640 × 900`, and `390 × 844`; no page-level horizontal overflow, wrapped command actions, and explicit keyboard panning for table or timeline scrollers |
| Forced-color and non-color cues | Pass | Pass | Pass | Selected incidents expose pressed state; diagnostics retain visible severity words or `C`/`W`/`I` tokens in addition to color |

The `640` CSS-pixel case is the automated reflow proxy for a `1280`-pixel-wide layout viewed at `200%`. Native browser zoom remains part of manual compatibility review because zoom behavior also depends on browser chrome, operating-system scaling, and assistive settings.

Playwright's WebKit project provides browser-engine coverage. It does not by itself certify a packaged Safari release or Apple hardware.

## Keyboard contract

- Opening a dialog moves focus to its first meaningful field or action, traps `Tab` within the modal, and returns focus to the opener when the dialog closes.
- Live capture moves focus to a valid control or status target whenever ready, preflight, recording, stopping, saving, recovery, or discard replaces the previously focused action.
- Incident tabs support arrow-key navigation with one selected and tabbable tab.
- Clearing an incident focuses the empty selection state; selecting the first incident or deleting an authored range focuses the replacement selector or empty state.
- Delete and discard confirmations focus the safe action first and return focus to the initiating control when cancelled.
- Long-running import, reopen, comparison, and bundle dialogs expose a named progress bar and a reachable cancel action. Cancellation closes the transient state without replacing the current replay, removing a saved entry, or downloading partial output.
- The telemetry timeline and evidence table are named, focusable horizontal scroll regions at narrow widths and include screen-reader instructions for arrow-key access.
- The comparison metric table is a named, focusable horizontal scroll region; the source-ID and limitation inspector is a named vertical region, and visual packet or diagnostic marks are hidden from the accessibility tree in favor of the aligned range control and traceable rows.
- Overview incident targets expose selected state, severity, and exact clock range in their accessible names.
- The received timeline exposes one full-lane range control instead of hundreds of overlapping tiny packet targets. Exact packet seeking remains available through the keyboard-accessible evidence table.
- Receiver information uses tabs for evidence, provenance, and notes; receiver-owned text is labeled and remains separate from read-only source notes.

## Manual certification boundary

These combinations are not yet certified as release gates:

| Combination | Current status |
| --- | --- |
| VoiceOver with Safari on macOS | Manual structured review not yet recorded |
| VoiceOver with Safari on iOS or iPadOS | Manual structured review not yet recorded |
| NVDA with Firefox or Chrome on Windows | Manual structured review not yet recorded |
| JAWS with Edge or Chrome on Windows | Manual structured review not yet recorded |
| Physical Web Serial devices and driver/permission combinations | Complete application path passes with an injected API; device, driver, native permission, operating-system, and packaged-browser matrix not yet recorded |
| Native `200%` browser zoom across packaged browsers | Automated CSS-viewport proxy passes; manual browser/OS matrix not yet recorded |

Do not convert an automated engine pass into a broader assistive-technology or hardware support claim. Record completed manual combinations here with browser, operating system, assistive technology, viewport or zoom, input method, and observed result.

## Run the release checks

Install the browser runtimes once:

```bash
npx playwright install chromium firefox webkit
```

Then run the complete gate:

```bash
npm run check
```

For focused browser work:

```bash
npm run test:e2e
npm run test:e2e:headed
```

CI installs browser system dependencies, runs the same project matrix, and retains Playwright traces, screenshots, and video when a check fails.

## Reporting a problem

Accessibility defects belong in the issue tracker unless they expose private telemetry or a security vulnerability. Include the exact browser, operating system, assistive technology, input method, zoom or viewport, affected control, expected focus or announcement, and a sanitized reproduction. Follow [SECURITY.md](SECURITY.md) instead when disclosure could expose sensitive data or a security boundary.
