# Independent field-proof procedure

An automated loopback capture proves the software path. It does not satisfy NarrowsLink's north-star outcome. A field proof must use a real non-demo telemetry source and an independent recipient.

Use [PILOT-001](pilot-plan.md) to assign the first source, recording operator, and independent recipient. Its empty worksheet is preparation only; the [2026-08-19 readiness record](2026-08-19-readiness.md) remains pending until a new dated record provides actual evidence.

## Before capture

1. Draw the observation topology from telemetry producer through radio, modem, base station, forwarding software, network, or serial adapter to the NarrowsLink laptop.
2. Record the source hardware and firmware, receiving hardware, adapter or bridge, laptop operating system, NarrowsLink build identity, decoder-pack identity, and capture settings. Upgrade recording and receiving installations to v0.3.0 before a new handoff; v0.2.0 cannot read new version 4 bundles.
3. State what NarrowsLink can observe at that point and what remains upstream, unavailable, estimated, or based on another device's counters.
4. Run preflight, confirm traffic and decoder fit, then stop the probe and deliberately start the evidence capture.

## Capture and isolate

1. Record the real test without substituting a checked-in fixture or loopback sender.
2. Preserve malformed, partial, and capture-path diagnostics.
3. Stop, save, and replay the canonical `.nlsession`.
4. Select one half-open incident range `[startUs, endUs)` that contains enough raw and decoded evidence to investigate a concrete event.
5. Export the `.nlb` and record its whole-file SHA-256 plus the session, decoder pack, schema, runtime, and build identities reported by NarrowsLink.

## Independent handoff

1. Transfer the `.nlb` unchanged to a second NarrowsLink installation. Do not transfer browser storage or rely on the source laptop.
2. Have a person who was not present run production verification and open the receiver workspace.
3. Record whether the recipient sees the same raw evidence, decoded values, diagnostics, transport limitations, and selected boundaries.
4. Record the recipient's useful conclusion and every question the bundle cannot answer.

## Passing record

A proof passes only when the archive verifies on the second installation, the evidence and limitations reproduce, and the recipient can continue the investigation without the original source or laptop. Store the topology, procedure, session and bundle hashes, verification report, recipient result, and unresolved limitations together. A parser fixture, demo sender, same-browser reopen, or sender-operator self-review is not sufficient.
