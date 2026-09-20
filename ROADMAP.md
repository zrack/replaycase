# ReplayCase roadmap

This file contains planned work only. See [README.md](README.md) for current capabilities, [USE_CASES.md](USE_CASES.md) for supported operator outcomes, and [CHANGELOG.md](CHANGELOG.md) for completed changes. The work areas below are not a release promise or strict sequence; they describe the next product bets that still need design, implementation, and evidence.

## Product goal

**ReplayCase makes constrained telemetry incidents reproducible.**

ReplayCase is a local-first evidence workbench that captures the telemetry and transport evidence available at a laptop, replays it deterministically through an identified decoder, and packages an exact incident so another engineer can verify what was observed, what was inferred, and what remains unknown.

This is the target product definition. [README.md](README.md) and [USE_CASES.md](USE_CASES.md) remain authoritative for what the current application supports.

## Success definition

The strongest success test is that a person who was not present during the test can receive a ReplayCase bundle on another machine, verify it, open the exact incident, inspect the same raw and decoded evidence, understand the capture-path limitations, and continue the investigation without the original system or laptop.

Success requires five properties:

- **Capture truth:** malformed, partial, and failed data are retained. Transport provenance, recorder problems, and unavailable evidence remain explicit.
- **Deterministic interpretation:** the session identifies the exact decoder pack, schema, parser runtime, and revision. Replaying the same input produces the same decoded output and diagnostics.
- **Fast investigation:** an operator can isolate a useful incident range and correlate packet behavior, link state, diagnostics, and decoded values without writing custom analysis code.
- **Independent handoff:** a receiving engineer can verify and inspect the archive offline while clearly distinguishing internal consistency, evidence completeness, and source authenticity.
- **Protocol portability:** a contributor can add a documented decoder pack with fixtures and expected results without modifying ReplayCase's core capture, replay, or evidence pipeline.

The north-star measure is **successful independently verified incident handoffs**. Count a handoff as successful only when it originates from a real capture, contains an exact incident range, passes verification on another ReplayCase installation, exposes the same raw and decoded evidence plus known limitations, and remains useful without the original laptop or source system. Track the percentage of shared bundles that recipients successfully verify and open, together with the time from incident selection to verified handoff. Packet counts, sessions saved, dashboard views, and installed decoder counts are not substitutes for that outcome.

## Strategic horizon

The goal positions ReplayCase as the local evidence layer for constrained telemetry: a tool that lets small teams capture what happened, understand why it happened, and hand off proof without requiring a cloud account, vendor backend, or custom one-off debug script.

The product can move in five useful directions:

- **Field black box for small systems:** turn drones, boats, robots, radios, sensors, research platforms, and embedded devices into systems with replayable incident evidence instead of disposable console logs.
- **Protocol workbench:** give protocol authors a place to ship decoder definitions, fixture captures, expected diagnostics, and conformance tests that other teams can reproduce.
- **Incident handoff format:** make `.nlsession` and `.nlb` files useful as portable evidence packages between operators, maintainers, vendors, educators, and receiving engineers.
- **Local-first reliability lab:** let teams compare firmware, decoder, transport, and field-environment changes against the same capture corpus without uploading sensitive telemetry.
- **Trust boundary demonstrator:** show exactly which claims are observed, inferred, unavailable, internally consistent, or externally authenticated, so investigations do not overstate what the evidence proves.

The near-term roadmap should keep serving those directions. Work that does not improve replayability, decoder portability, incident evidence, local trust, or operator review should be treated as secondary.

## Next milestone: Independent field proof

Prove the complete product outcome outside the controlled loopback and simulated-device gates. The purpose is not another parser demo; it is a handoff that remains useful after the source system and capture laptop are gone.

Execution owner: repository maintainer coordinates the pilot. The recording operator, real source, and independent recipient are not yet assigned; [PILOT-001](docs/field-proofs/pilot-plan.md) owns those decisions and the recipient worksheet. Confirm them before scheduling a field test. Both installations must use a published package compatible with the exported bundle format.

Planned work:

- Capture a real non-demo telemetry source through a documented UDP or physical serial topology, using a decoder pack whose immutable identity is preserved in the session.
- Record the source, receiver, laptop, operating system, ReplayCase build, decoder identity, capture settings, observation point, and every known capture-path limitation.
- Isolate one exact incident, export the unchanged `.nlb`, and transfer it to a second ReplayCase installation without sharing the original source or session workspace.
- Have an engineer who was not present verify the archive, reproduce its raw and decoded evidence and diagnostics, and record what they could and could not conclude.
- Preserve the session, bundle SHA-256, verification report, topology notes, and recipient result as a durable field-proof record.

Exit criteria: one independently verified incident handoff created from a real non-NSL-01 capture, opened on a second installation by a person who was not present, with matching evidence and explicit limitations.

## After the first pilot

- Turn observed setup, capture recovery, diagnostic interpretation, and handoff failures into reproducible issues and regression fixtures, with permission to retain any real telemetry.
- Repeat the handoff with a small set of additional operators; record verification success, assistance required, time to verified open, and time to a useful conclusion. Keep failed attempts in the evidence record.
- Complete the applicable hardware and assistive-technology checks below. A UDP pilot does not certify physical serial, and browser-engine tests do not certify screen readers.
- Choose the next protocol or larger feature from the repeated operator need. Do not expand a decoder catalog or add signing merely to fill a release.

Exit criteria: the team can identify the next engineering priority from observed pilot failures and useful investigations, not from demo throughput or feature counts. The strategic work below remains conditional on that evidence.

## Authenticity and trusted identity

- Produce a threat model before adding signatures: identify which actors, artifacts, source channels, capture devices, and build environments a signature is intended to authenticate.
- Decide key ownership, rotation, revocation, offline verification, clock assumptions, and recovery for individual and team use.
- Define optional signing or trusted-channel anchoring for release identity, decoder packs, session files, bridge journals, bundles, and comparison findings without making local capture depend on a hosted service.
- Add tampering, wrong-key, revoked-key, and unavailable-trust fixtures while continuing to report internal consistency, evidence completeness, and source authenticity as separate claims.

Exit criteria: a receiving engineer can establish a named artifact identity through an independently trusted key or channel, while unsigned and unsupported evidence remains valid but explicitly unauthenticated.

## Assistive-technology and hardware certification

- Run and record structured VoiceOver reviews with packaged Safari on macOS and iOS or iPadOS.
- Run and record NVDA reviews with packaged Firefox and Chromium-based browsers on Windows.
- Add JAWS coverage when a licensed Windows test environment is available.
- Verify native `200%` browser zoom with operating-system scaling across the packaged browser matrix, beyond the current automated CSS-viewport proxy.
- Exercise physical Web Serial device selection, disconnect, failure recovery, and permission behavior with representative adapters and drivers.

Exit criteria: [ACCESSIBILITY.md](ACCESSIBILITY.md) records reproducible manual results for the supported browser, operating-system, screen-reader, zoom, and Web Serial hardware combinations without broadening claims beyond tested evidence.

## Moonshot: Community protocol workbench

- Let operators and protocol engineers build, validate, and publish decoder packs with sample captures, expected decoded fields, diagnostics, and evidence-bundle fixtures.
- Add local schema authoring and decoder-revision migration tools that use comparison findings to show how a proposed pack changes packets, diagnostics, timelines, and bundle output.
- Support a curated registry of community protocol packs without making ReplayCase dependent on a hosted service.
- Make protocol packs portable enough for labs, field teams, educators, and hobby communities to exchange reproducible telemetry examples.
- Publish an example protocol pack that can be used as a teaching fixture, regression suite, and contribution template.

Exit criteria: a new telemetry community can bring a protocol, fixtures, and expected behavior into ReplayCase without forking the application.

## Moonshot: Incident evidence exchange

- Add optional signed manifests, public-key identity, or transparency-log integration for teams that need stronger provenance than local checksums.
- Explore redaction and minimization tools that preserve verification while stripping sensitive coordinates, identifiers, or operator notes.
- Add standalone comparison-finding import when both exact source artifacts are present, and test it against externally produced findings.
- Define external citation links and integrations so issue trackers, test reports, vendors, and research records can resolve the same verified case evidence.

Exit criteria: ReplayCase becomes a practical handoff format for telemetry incidents, not only a local review tool.

## Product boundary

Cloud storage, accounts, collaboration, and hosted ingestion are not current commitments. The default posture remains local-first, inspectable, and portable; any networked service should be optional and should not become necessary for capture, replay, diagnosis, or evidence export.
