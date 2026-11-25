# PILOT-001 attempt record template

**Template only; no capture or independent handoff is recorded here.** Copy this
file into the permitted working location for each attempt. Keep unavailable facts
explicitly `Unknown` or `Not recorded`; do not substitute demo results. Review
real telemetry, coordinates, device identifiers, and authored notes before
sharing or committing a completed record. Follow the [field-proof procedure](README.md).

## Setup and identity

| Field | Recorded value |
| --- | --- |
| Attempt ID and UTC date | |
| Status: not started / interrupted / failed / passed / inconclusive | Not started |
| Recording operator and laptop OS | |
| Real non-demo source, hardware, firmware, and owner | |
| Source connection and complete observation topology | |
| Primary stream or copy; available and unavailable upstream counters | |
| Receiver or adapter and capture settings | |
| Recording package version, full commit, and release-asset checksum result | |
| Decoder pack hash, schema hash, runtime ID/revision, and decoder revision | |
| Independent recipient, second machine OS/browser, and confirmation they were absent from capture | |
| Receiving package version, full commit, and release-asset checksum result | |
| Sharing permission, permitted channel, and storage location | |

Verify the published tagged package on both installations before capture.
Record all differences between the installations. Preserve unavailable host
counters as unavailable rather than zero. Do not operate an unknown device or
introduce a source interruption without the operator's approval.

## Operator log

Keep this log separate from immutable telemetry. Use UTC timestamps and, when
known, integer microsecond offsets from that session's UTC start. Offsets from
different sessions are not a common clock. Label an intervention explicitly;
a receiver disconnect does not establish an RF failure.

| UTC timestamp | Session offset (us), or unknown | Observation or intervention | Supporting record/diagnostic ID or external note |
| --- | --- | --- | --- |
| | | | |

Record preflight result, deliberate recording start, noteworthy events, stop,
export, and any assistance. Keep separate sessions for reconnections when a
disconnect terminates recording; do not splice their evidence.

## Preserved artifacts

| Artifact or claim | Recorded value |
| --- | --- |
| Original `.nlsession` filename, SHA-256, and UTC start | |
| Capture-integrity status, assessment basis, and limitations | |
| Transport provenance, bridge journal, and unavailable counters | |
| Exact half-open incident range `[startUs, endUs)` | |
| Exported `.nlb` filename, whole-file SHA-256, and included groups | |
| Separately communicated expected bundle hash and transfer time/channel | |
| Sender verification report filename and SHA-256 | |
| Operator log and topology record location | |

Retain original bytes. Record what was actually included and any excluded
context. Keep internal consistency, capture completeness, and authenticity as
separate claims; checksums alone do not establish source authenticity.

## Independent recipient assessment

Complete the first assessment before receiving the sender's expected diagnosis.
Use the transferred bundle on the second installation without the capture
system or original browser workspace. Record any help before it is provided.

| Field | Recipient's recorded result |
| --- | --- |
| Bundle receipt time (UTC) and SHA-256 match | |
| Verification report filename and SHA-256 | |
| Internal consistency / evidence completeness / authenticity, separately | |
| Exact incident range and decoder identities reproduced | |
| Raw records, decoded values, diagnostics, and limitations reproduced | |
| What happened, citing exact record or diagnostic IDs | |
| What cannot be concluded and missing context | |
| Time to verified open; time to a useful conclusion | |
| Assistance requested, time, and effect on the assessment | |
| Could investigation continue without the source system or recording laptop? | |

## Observed issue triage

Copy this section for each observed problem. An empty section is not a finding.
Preserve the first attempt before testing a proposed change.

- Issue ID and operator step where it occurred:
- Category: setup / software defect / missing source evidence / interpretation / documentation:
- Observed behavior and expected behavior, with exact source IDs or error text:
- Package commits, decoder identities, artifact hashes, and exact ranges needed to reproduce:
- Smallest reproduction and whether a second attempt reproduced it:
- Operator impact, workaround, help required, and elapsed time:
- Evidence permitted for a public issue or regression fixture; private evidence location:
- Proposed fix or explanation, explicitly unverified until tested:
- Regression acceptance criterion and verification result after a fix:
- Tracking issue/PR and follow-up attempt ID, when created:

## Outcome

- Outcome and supporting evidence:
- Unresolved limitations and next action:
- Reviewer and review date:

Mark `passed` only after a real non-NSL-01 capture yields an exact incident that
an uninvolved person verifies and investigates on a second installation, with
matching evidence and explicit limitations. A local reopen, simulated source,
or authored explanation is not independent field proof. Use an interrupted,
failed, or inconclusive outcome when that is what the attempt establishes.
