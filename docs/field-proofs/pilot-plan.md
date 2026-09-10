# PILOT-001: First independent incident handoff

Status: **not started; source and independent recipient unassigned**. This is the working plan, not a proof record. Keep completed results in a separate dated record using the [procedure](README.md).

## Decisions required

| Responsibility | Current assignment or decision |
| --- | --- |
| Pilot coordination | Repository maintainer; confirm participants and permitted sharing |
| Recording operator and laptop | Unassigned |
| Real telemetry source | Unselected; target checksummed NMEA 0183 GGA/RMC, with HDT when available |
| Observation path | Select physical USB serial, base-station UDP output, or a documented forwarded/multicast copy |
| Independent recipient and second machine | Unassigned; must not attend the recording test |
| Recording and receiving package | v0.4.0; record each installed commit from `replaycase version --json` |
| Decoder identity | Record exact reference or local pack hash, schema hash, runtime ID, and revision before capture |
| Test date and sharing permission | Unset; do not publish device identifiers, coordinates, or private telemetry by default |

## First experiment

1. Use a real source already available to the team. Record its normal traffic and identify a concrete event worth investigating. If no natural event is available, a team-approved receiver disconnect while the source is safely stationary can test capture interruption. Record that intervention explicitly; it does not simulate or prove an RF failure. A physical disconnect may terminate capture: preserve its terminal receipt, then record any reconnection as a separate session.
2. Draw the complete observation path and identify whether ReplayCase receives the primary stream or a copy. Note unavailable upstream loss counters and OS-specific limits before starting.
3. Verify both installations and decoder compatibility. Preflight the selected source, deliberately start recording, and keep a timestamped operator log separate from the telemetry.
4. Preserve the finalized session, then select an exact incident containing sufficient lead-in, the event, and any recovery actually observed in that session. Do not imply continuity across a disconnect or splice another session into the evidence. Include raw records, decoded output, decoder schema, diagnostics, and relevant operator context in the bundle.
5. Transfer the unchanged bundle and its independently communicated hash to the recipient through an approved channel. Do not provide the original session workspace or explain the expected diagnosis before their first assessment.
6. Have the recipient complete the worksheet below offline. Record any help requested before offering it; repeat after a fix as a new attempt, retaining the original outcome.

## Recipient worksheet

- Received bundle SHA-256 and match against the separately supplied identity:
- Receiving OS, browser, application version, and full build commit:
- Verification result, evidence completeness, and authenticity result, reported separately:
- Exact incident boundaries and decoder identities:
- Raw evidence, decoded values, diagnostics, and limitations reproduced:
- What happened, with record or diagnostic IDs supporting the conclusion:
- What cannot be concluded from this bundle:
- Missing context, confusing UI, failures, or help required:
- Time from receipt to verified open; time to a useful conclusion:
- Could the investigation continue without the source system or recording laptop?

## Exit and follow-up

Pass only when a real non-NSL-01 capture yields an exact incident that a person who was not present independently verifies and uses on a second installation. Keep session and bundle identities, topology, verification output, the recipient assessment, timings, and limitations together in a dated proof record. Leave unavailable fields explicit; do not fill them with demo results.

After the first attempt, prioritize observed blockers to setup, evidence interpretation, and handoff. Run subsequent attempts with a small number of additional operators before choosing another protocol or a larger feature. Physical serial and manual accessibility certification still require their own recorded checks even if this pilot passes over UDP.
