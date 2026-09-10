# Independent field-proof procedure

An automated loopback capture proves the software path. It does not satisfy ReplayCase's north-star outcome. A field proof must use a real non-demo telemetry source and an independent recipient.

Use [PILOT-001](pilot-plan.md) to assign the first source, recording operator, and independent recipient. Its empty worksheet is preparation only. The [last published-package readiness audit](2026-09-10-readiness.md) records NarrowsLink v0.3.0 and its automated gates; it does not establish a real-source handoff. Current installation and rename compatibility are defined by the [ReplayCase release guide](../releases/README.md), not by that dated audit.

## Evidence and status

- [NarrowsLink v0.3.0 release readiness: 2026-09-10](2026-09-10-readiness.md): identified release assets, automated verification, compatibility, and remaining field-proof requirements at that date.
- [PILOT-001](pilot-plan.md): source, recording operator, and independent recipient remain unassigned; the pilot is not started.
- [Historical environment audit: 2026-08-19](2026-08-19-readiness.md): the hardware and source observations from that date, not a current device inventory.

No passing independent field-proof record exists yet. Preserve dated readiness records, and add a separate dated result when a real attempt occurs. Keep unsuccessful attempts and their limitations rather than replacing them with automated results.

## Before capture

1. Draw the observation topology from telemetry producer through radio, modem, base station, forwarding software, network, or serial adapter to the ReplayCase laptop.
2. Record the source hardware and firmware, receiving hardware, adapter or bridge, laptop operating system, ReplayCase build identity, decoder-pack identity, and capture settings. Use ReplayCase v0.4.0 for new recording and receiving installations; NarrowsLink v0.3.0 remains bundle-compatible, but v0.2.0 cannot read version 4 bundles.
3. State what ReplayCase can observe at that point and what remains upstream, unavailable, estimated, or based on another device's counters.
4. Run preflight, confirm traffic and decoder fit, then stop the probe and deliberately start the evidence capture.

## Capture and isolate

1. Record the real test without substituting a checked-in fixture or loopback sender.
2. Preserve malformed, partial, and capture-path diagnostics.
3. Stop, save, and replay the canonical `.nlsession`.
4. Select one half-open incident range `[startUs, endUs)` that contains enough raw and decoded evidence to investigate a concrete event.
5. Export the `.nlb` and record its whole-file SHA-256 plus the session, decoder pack, schema, runtime, and build identities reported by ReplayCase.

## Independent handoff

1. Transfer the `.nlb` unchanged to a second ReplayCase installation. Do not transfer browser storage or rely on the source laptop.
2. Have a person who was not present run production verification and open the receiver workspace.
3. Record whether the recipient sees the same raw evidence, decoded values, diagnostics, transport limitations, and selected boundaries.
4. Record the recipient's useful conclusion and every question the bundle cannot answer.

## Passing record

A proof passes only when the archive verifies on the second installation, the evidence and limitations reproduce, and the recipient can continue the investigation without the original source or laptop. Store the topology, procedure, session and bundle hashes, verification report, recipient result, and unresolved limitations together. A parser fixture, demo sender, same-browser reopen, or sender-operator self-review is not sufficient.
