# Multi-bundle case contract

[Architecture](README.md) | [Operator procedure](../../USER_GUIDE.md#investigate-a-multi-bundle-case) | [Tracking charter](https://github.com/zrack/replaycase/issues/44)

This contract describes the current source build, not the published v0.4.0 package.

## Evidence and authorship

A case groups independently verified `.nlb` bundles. It does not concatenate sessions, synchronize clocks, change decoder identities, rewrite source bytes, or upgrade incomplete evidence to complete evidence. Bundle labels are taken from the imported filenames. Findings and open questions are authored case context, not observed telemetry. Their citations resolve against the exact included evidence; resolving a citation does not prove the author's assertion.

Each citation identifies a bundle by its complete SHA-256 and one target:

- `range`: integer `startUs` and `endUs`, a nonempty half-open interval inside the bundle's included incident.
- `record`: an exact `recordId` present in the bundle's raw records. Excluded raw records cannot be cited through inferred IDs.
- `diagnostic`: an exact `diagnosticId` present in the bundle's diagnostics.

Removing a cited bundle requires removing its findings and comparisons first. Receiver-local notes remain separate and are not automatically included in a case. Case authors must explicitly write portable findings.

## Archive version 1

An `.nlcase` is a bounded ZIP containing only:

```text
case.json
bundles/<sha256>.nlb
```

`case.json` is canonical UTF-8 JSON: recursively sorted object keys, preserved array order, no formatting whitespace or trailing newline, and strict schemas. Its format is `replaycase/case`, version `1`. It contains a UUID, title, summary, UTC creation/update timestamps, bundle descriptors, findings/questions, comparison findings, and an identity object. The identity is SHA-256 over canonical manifest content with the `identity` field omitted. Bundle descriptors contain SHA-256, byte count, label, and original filename. The archive itself has a separate whole-file SHA-256 used by local persistence.

Original `.nlb` bytes are stored without modification, including their original ZIP metadata and decoder artifacts. Newly built case ZIPs use a fixed DOS timestamp and stored entries. Re-exporting an imported or reopened case without edits returns the same archive bytes; editing authored context creates a new case revision without modifying embedded bundles.

The case UUID identifies a mutable investigation. The manifest and whole-archive hashes identify its exact content and revision. Neither hash authenticates the source, author, originating machine, or narrative. No signature or external trust anchor is claimed.

## Resource envelope

| Bound | Version 1 maximum |
| --- | --- |
| Outer archive | 64 MiB |
| Distinct bundles | 16 |
| Sum of stored `.nlb` bytes | 48 MiB |
| Sum of nested uncompressed artifact bytes | 64 MiB |
| Canonical case manifest | 1 MiB |
| Findings/questions | 200 |
| Citations per finding/question | 1-16 |
| Finding text or investigation summary | 4,000 characters |
| Comparison findings | 16, also subject to the 1 MiB manifest limit |

The existing per-bundle limits still apply. A valid standalone bundle can be too large for a case. Narrow the incident or omit unnecessary optional groups before exporting the source `.nlb`; the case importer never silently strips evidence. Duplicate bundle identities are rejected in received manifests; adding an exact duplicate in the UI is a no-op.

## Verification pipeline

1. Preflight the outer ZIP using the shared hardened container reader and the case-specific path/size policy. Reject unknown paths, nested cases, duplicate entries, traversal, encryption, unsupported compression, conflicting headers, and unaccounted bytes.
2. Bound and validate canonical `case.json`, its version, strict schema, identity, and exact declared artifact set.
3. Match every nested file's size and SHA-256. Preflight every nested ZIP and bound their aggregate expansion **before decompressing the first nested bundle**.
4. Run each original archive through the production evidence verifier, including decoder conformance and raw-to-decoded reproduction where supported. Preserve its separate consistency, completeness, capture, provenance, authenticity, and limitation results.
5. Resolve every citation. Validate every comparison finding and independently regenerate it with the existing comparison engine, exact embedded sources, declared alignment, original conclusion, and original timestamp. Require the entire result to match, not just a newly calculated hash.
6. Transfer verified evidence in ordered chunks through the case worker contract. Do not replace the active case until the complete result is received.

Worker termination cancels import, construction, and export before committing active state or initiating a download. Processing reports monotonic progress. Source bytes and authored context remain in memory, subject to the envelope; this is not disk-backed streaming or an unlimited evidence database.

## Persistence and conflicts

`replaycase-case-library` is a separate IndexedDB database. One record contains the entire verified archive and bounded listing metadata; case removal therefore removes its embedded evidence and authored findings in one transaction. Existing session databases and receiver-note keys are unchanged.

Every reopen checks the archive hash, reruns case and nested-bundle verification, and reconciles listing metadata. Saves reverify input and any existing revision before a compare-and-swap transaction. A save succeeds only on transaction completion. Concurrent changes, incompatible data, corruption, blocked opens, quota failures, and unavailable storage surface explicitly. They do not silently overwrite or repair evidence. Identical saves are idempotent.

Importing a different revision with an already saved UUID does not merge or replace it. Export any work to retain, then reopen the saved revision or explicitly remove it before saving the imported revision. There is no automatic conflict merge. Removing a saved case leaves an open in-memory copy usable and does not touch exported files, saved sessions, or receiver-local notes.

## Proof boundary

The automated handoff uses controlled baseline/failure/post-fix fixtures and separate browser profiles with only the local application origin allowed. It proves exact archive continuity, citations, regenerated comparisons, save/reload, rejection, and bounded responsive UI behavior. It does not prove a second person's usefulness judgment, a real radio path, native serial hardware, or manual assistive technology. Offline operation requires the application to be available from a local server; no cached service-worker or serverless-browser mode is provided.

Implementation: [case domain](../../src/domain/case.ts), [production case verifier](../../verifier/case-verifier.ts), [worker boundary](../../src/cases/case-processing.ts), [case library](../../src/storage/case-library.ts), [workspace](../../src/cases/CaseWorkspace.tsx), [browser handoff regression](../../tests/e2e/case-workspace.spec.ts), and [unpacked-installation gate](../../tests/release/case-workspace.spec.ts).
