# Release and field-pilot readiness: 2026-09-10

## Result

**The published v0.3.0 package passes the automated release gates and is ready for a supervised field pilot. The independent real-source handoff remains unproven.**

This is a release-readiness record, not a passing field-proof result. It checks release identity and software evidence; it does not repeat the hardware inventory from the [2026-08-19 audit](2026-08-19-readiness.md).

## Identified release

| Item | Verified identity |
| --- | --- |
| Published package | [NarrowsLink v0.3.0](https://github.com/zrack/narrowslink/releases/tag/v0.3.0) |
| Publication time | `2026-09-10T06:03:10Z` |
| Annotated tag | `v0.3.0` |
| Commit | `b322ec5cdfcf99df66b51e58173d6b8587977162` |
| Source tree | `11272a793ae34edb7acac7a39e5e895f75482311` |
| Release build | Node.js `20.19.5`, npm `11.12.1`; manifest mode `release`, clean source, verified annotated tag |
| Archive SHA-256 | `c3b42a737080692f37502a76bfe8e751d9688f5b8c5c668778fa59e95a6b8b59` |

The release contains exactly four download assets: the `.tgz`, external release manifest, CycloneDX SBOM, and `SHA256SUMS`. The downloaded package, manifest, and SBOM pass the published checksum set. The internal and external manifests match, all 32 manifest-listed payload files match their recorded sizes and SHA-256 values, and `narrowslink version --json` reports the version and commit above.

These artifacts and same-channel checks are unsigned. They establish byte consistency and declared build identity, not independent publisher, build-environment, device, or telemetry-source authenticity.

## Automated evidence

The [release workflow](https://github.com/zrack/narrowslink/actions/runs/34442407334) completed successfully. The same source commit also passed [main-branch CI](https://github.com/zrack/narrowslink/actions/runs/34441810217).

| Gate | Recorded result |
| --- | --- |
| Typecheck, unit/integration tests, production builds, and CLI smoke | Passed; 302 tests across 39 files |
| Source browser matrix | 55 passed across Chromium, Firefox, and WebKit; two intentional skips |
| Unpacked-package acceptance | Six passed in the full check, then six passed again against the strict release build |
| Strict reproducibility | Two independent compilations produced byte-identical release assets |
| Published assets | Checksums passed before publication and on the downloaded files |

The two skips are the redundant maximum-tier import-cancellation cases in Firefox and WebKit. Both engines still run the complete 200,000-record import, persistence, reopen, comparison, bounded export, and receiver-verification workflow. The source suite also checks the narrow packet-family heading at five viewport sizes in all three engines.

Real loopback UDP and injected Web Serial exercise the software capture-to-evidence pipeline. They do not certify physical serial devices, radio behavior, actual multicast infrastructure, or an independent human investigation. The manual assistive-technology and native-zoom boundaries in [ACCESSIBILITY.md](../../ACCESSIBILITY.md) also remain open.

## Compatibility for the pilot

Use v0.3.0 on the recording and receiving installations. It writes `.nlb` version 4 and reads versions 3 and 4; v0.2.0 reads version 3 only. Existing version 1 and 2 `.nlsession` documents remain readable without rewriting the evidence. Follow the [upgrade guidance](../../USER_GUIDE.md#upgrade-narrowslink), including retaining the same browser profile and loopback origin for access to saved local state.

## Remaining proof

[PILOT-001](pilot-plan.md) remains not started. Its real NMEA source, recording operator, independent recipient, test date, and sharing permission are unassigned. No source session, incident bundle, second-machine verification report, or recipient conclusion has been supplied as field evidence.

Assign those inputs, then follow the [independent field-proof procedure](README.md). Preserve the unchanged session and bundle identities, exact incident range, decoder identities, observation topology, verification report, recipient assessment, and explicit limitations in a separate dated attempt record. A successful real-source handoff by someone who was not present is the next product milestone; another passing demo or automated gate does not complete it.
