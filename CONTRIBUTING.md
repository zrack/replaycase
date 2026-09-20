# Contributing to ReplayCase

ReplayCase is a local-first telemetry capture, replay, incident-analysis, and evidence-export application. Contributions should preserve timing semantics, source provenance, visible failure states, deterministic derivation, and the ability to reproduce an incident from exported evidence. Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md); use the [support guide](SUPPORT.md) for usage questions and the [security policy](SECURITY.md) for private vulnerability reporting.

## Documentation ownership

| Document | Owns |
| --- | --- |
| [README.md](README.md) | Current product orientation, setup, workflows, formats, and limitations |
| [docs/README.md](docs/README.md) and [repository map](docs/repository-map.md) | Documentation navigation and source/test routing; not duplicate product policy or chronology |
| [USE_CASES.md](USE_CASES.md) | Stable use-case IDs, current operator outcomes, support constraints, and implementation evidence |
| [CHANGELOG.md](CHANGELOG.md) | The sole chronological record of notable completed changes and releases |
| [ROADMAP.md](ROADMAP.md) | Planned work and exit criteria only |
| [design-qa.md](design-qa.md) | The current accepted visual baseline and verification evidence |
| [ACCESSIBILITY.md](ACCESSIBILITY.md) | Current automated accessibility evidence, keyboard contract, support limits, and manual certification matrix |
| [docs/releases/](docs/releases/) | Immutable operator-facing summary and installation guidance for each published tag; the changelog remains the canonical full chronology |
| [AGENTS.md](AGENTS.md) | Durable product direction and project constraints for coding agents |
| [CONTRIBUTING.md](CONTRIBUTING.md) and the pull-request template | Current contributor and review policy |

Update a document only when the truth it owns changes. Do not append delivered milestones, commit summaries, or release notes to the README, use-case log, roadmap, design QA record, agent guidance, or collaboration files.

### Changelog policy

Add a concise, user-facing entry under `CHANGELOG.md` → `[Unreleased]` for every pull request that changes operator behavior, installation or contributor requirements, compatibility, security or privacy, session or bundle formats, evidence contents, or supported workflows.

Use only the applicable categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security`. Describe outcomes rather than implementation details, state migration or compatibility effects explicitly, and append the pull-request number when one exists.

Do not add entries for formatting, tests-only changes, internal refactors, regenerated screenshots or fixtures, or routine dependency updates unless they change supported behavior, contributor requirements, or security posture. Do not copy unfinished roadmap work into the changelog. When planned work is completed, remove it from the roadmap and record the delivered outcome in the changelog instead of relabeling the roadmap section as delivered.

Only a maintainer may convert `[Unreleased]` into a dated version section, and only while publishing a matching Git tag and GitHub Release. Keep `[Unreleased]` at the top for subsequent work; `package.json` metadata alone does not establish a release.

## Development setup

Use Node.js 20.19 or newer. The repository declares this minimum in `package.json`.

```bash
node --version
npm ci
npx playwright install chromium firefox webkit
npm run dev
```

Vite prints the local development URL. The application automatically loads the bundled harbor-relay fixture; use **Open local replay** to exercise the user-import path or **Live capture** for UDP/Web Serial.

On a Linux workstation or fresh CI runner, install the required browser system libraries with `npx playwright install --with-deps chromium firefox webkit` instead of the browser-only command above.

## Required checks

Run the complete verification command before opening a pull request:

```bash
npm run check
```

Available commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server |
| `npm run typecheck` | Validate the TypeScript project references |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run build` | Typecheck and create the production browser application and receiver CLI |
| `npm run build:cli` | Build the bundled `replaycase serve`, `verify`, and `version` CLI |
| `npm run test:cli` | Smoke-test the built receiver entry directly and through a package-style symlink |
| `npm run preview` | Serve the production bundle locally |
| `npm run test:e2e` | Build and run the Playwright release suite in Chromium, Firefox, and WebKit |
| `npm run test:e2e:run` | Serve the current production build on an isolated loopback port and run Playwright |
| `npm run test:e2e:headed` | Build and run the browser suite with visible browser windows |
| `npm run release:build` | Independently compile and package the release twice, requiring byte-identical assets |
| `npm run test:release` | Test the archive named by `REPLAYCASE_RELEASE_ARCHIVE` outside the repository in all three browser engines |
| `npm run release:check` | Build the reproducible preview distribution and run its complete unpacked acceptance gate |
| `npm run check` | Run typecheck, Vitest, production build, source browser matrix, and unpacked release gate |
| `npm run capture:bridge` | Start the manual bearer-token UDP bridge used for source development |
| `npm run capture:demo` | Send checked-in fixture frames as real UDP datagrams |
| `npm run capture:demo:nmea` | Send repeatable checksummed NMEA 0183 datagrams |
| `npm run fixture:generate` | Regenerate the deterministic bundled replay |
| `npm run fixture:large` | Stream the ignored 200,000-record acceptance corpus into `output/large-session/` |
| `npm run verify:bundle -- incident.nlb` | Build the receiver CLI and verify a local version 3 or 4 evidence bundle; add `--json` for machine-readable output |

## Maintainer release process

Only a maintainer may publish a ReplayCase release. Release publication is tag-driven, but the tag is created only after the candidate bytes pass locally and the release change has merged through the protected `main` branch.

1. On a release branch, update `package.json` and `package-lock.json` to the intended semantic version, convert the accumulated changelog entries into the matching dated section, and add the operator-facing release notes. Update any version-specific workflow trigger, asset names, release-acceptance constants, and tag checks for that version.
2. Run `npm run check`. Inspect `output/release/SHA256SUMS`, the external release manifest, the CycloneDX SBOM, and the tarball listing. The gate must prove two independent compilations are byte-identical and exercise the extracted package through real UDP capture, replay, authored evidence, `.nlb` export, artifact-local receiver verification, same-origin library persistence after package replacement, and the documented maximum-record replay workflow.
3. Merge the reviewed branch through the required GitHub checks. On a clean, up-to-date `main`, run `npm run check` again.
4. Create the annotated `v<package-version>` tag only at that verified `main` commit and push the tag to `origin`.
5. The release workflow rechecks the clean tag, pinned Node and npm toolchain, complete source suite, strict double build, unpacked artifact, and published checksums before its write-enabled job creates the GitHub Release.
6. Confirm the GitHub Release points to the intended commit, contains only the `.tgz`, external manifest, SBOM, and `SHA256SUMS`, and that the downloaded assets pass the published checksum set.

Do not publish ad hoc local archives or create the tag before the candidate gate passes. Re-running the workflow must not substitute different bytes under an existing release. The release assets, tag, and same-channel checksum file are unsigned; checksum verification establishes byte consistency, not publisher or build-environment authenticity.

## Regenerating the fixture

`public/fixtures/harbor-relay-session.json` is generated by `scripts/generate-demo-session.mjs`. Do not hand-edit the 18,402-record JSON file.

After changing the generator, run:

```bash
npm run fixture:generate
npm run check
```

Review both the generator diff and the resulting fixture facts. Keep generation deterministic, preserve all five packet families, and retain representative malformed frames and sequence gaps. If expected counts, incident ranges, decoder identity, or failure scenarios change, update the relevant tests and documentation in the same pull request.

The bundled session also carries visual and diagnostic regression intent. Preserve varied packet cadence and received packet rate, measurable fade shoulders versus the fade center, intentional sequence gaps, and enough valid post-failure traffic to exercise the sustained decoder-relock window. Assert those properties from decoded domain output rather than snapshotting decorative chart coordinates.

`scripts/large-session-corpus.mjs` separately streams the deterministic maximum-record acceptance file. Its output belongs in ignored `output/large-session/`, not the repository. Keep generation bounded at 200,000 records, preserve canonical v1 bytes and the exact 10,000-record incident, and update the source and release browser gates together when the published support tier or measurement contract changes.

## Decoder pack contributions

Read [DECODER_PACKS.md](DECODER_PACKS.md) before changing a pack, runtime, or decoder identity. Packs are data, not executable plug-ins.

For an NMEA schema or fixture contribution:

1. Create a draft without relying on a hand-calculated integrity value.
2. Include known-good records and representative checksum, framing, unknown-family, or field-quality failures.
3. Seal and execute the production conformance path:

   ```bash
   replaycase decoder seal draft.json --out protocol.nldecoder
   replaycase decoder validate protocol.nldecoder
   ```

4. Load the sealed file through **Live capture** and record repeatable real UDP or serial traffic.
5. Reopen the saved `.nlsession`, isolate a half-open incident, export an `.nlb` with the decoder schema included, and verify it through the production receiver.
6. Add focused unit coverage plus the real capture-to-handoff acceptance path before documenting the pack as supported.

Changing a description, schema, fixture, or expected result changes pack identity. Do not preserve the old hash or rewrite sessions that reference it. A new wire protocol outside the runtime allowlist requires a bounded reviewed runtime and adversarial resource-limit coverage; arbitrary JavaScript, automatic protocol detection, and multiple competing decoders remain out of scope.

## Engineering invariants

- Use ReplayCase for current product, CLI, repository, and release branding. Preserve the legacy evidence, decoder, and storage identities and compatibility aliases documented in [branding compatibility](docs/architecture/branding-compatibility.md); never apply a global brand replacement to captured or content-addressed evidence.
- Treat raw `SourceRecord` values as immutable input. Derive frames, decoded fields, metrics, diagnostics, incidents, and archives from them.
- Store and compare time as safe integer microsecond offsets from the session's UTC start. Apply the declared IANA time zone only for display.
- Use half-open incident and export ranges: `[startUs, endUs)`.
- Route bundled and user-imported sessions through the same validation and decoding functions.
- Route finalized live captures through that same validation and decoding path before replay.
- Keep replay-file, record-count, duration, responsiveness, and Chromium heap-growth limits centralized in `src/domain/limits.ts`. Live capture retains its lower record and retained-payload ceilings in `src/capture/recorder.ts`; do not imply the larger import tier applies to capture.
- Run long session validation, decoding, aggregation, canonicalization, bounded comparison construction, and bundle construction through the worker processing contracts. Transfer large record/frame results in ordered chunks, preserve deterministic output and source linkage, and keep progress monotonic.
- Cancellation must terminate the active worker and leave the prior workspace, saved library entry, and download boundary unchanged. Never persist or export a partial result.
- Store only validated canonical session documents in the IndexedDB library, identify them by SHA-256 over canonical `.nlsession` bytes, and keep exact duplicate saves idempotent without changing their original saved date. New records store exact canonical bytes; continue to validate and read the documented older text and Blob record versions.
- Re-hash, parse, and validate every saved-session reopen. Surface corruption and storage failures without replacing the active validated replay or claiming an uncommitted save succeeded.
- Treat saved-session removal as a two-store operation: delete the IndexedDB replay, clear its per-session local-storage workspace when identifiable, keep any active replay in memory, and warn if residual operator context could not be cleared.
- Never let a control client stop or adopt a UDP capture it did not start; reconcile bridge sequence, datagram, and byte totals before claiming a capture is complete.
- Keep saved capture profiles bounded and local, bind them to an exact conformant decoder pack, and exclude credentials, browser device permission, session naming, and telemetry payloads.
- Keep preflight bounded and outside session evidence. Require confirmed UDP probe shutdown before opening a new recording identity; for serial, keep the selected port but reset framing and route only future reads to the recorder.
- New live captures must finalize as session v2 with immutable transport events and a terminal receipt. Preserve strict v1 import behavior and never infer verified integrity for legacy evidence.
- Never substitute browser or recorder counts for an unavailable transport-reported count. Preserve null observations, use the truthful incomplete assessment basis, and require explicit adapter evidence before verification.
- Preserve the bridge journal, per-datagram UDP remote endpoint, and Web Serial device and negotiated-setting evidence when changing capture code. Keep unavailable operating-system counters explicitly null with their observation source; do not convert missing evidence into a clean zero.
- Keep host UDP counters scoped to one identified capture socket and sampling interval. A numeric counter requires its measured observation source; unsupported platforms, unreadable counters, ambiguous sockets, and regressions remain explicit unavailable states. Keep observed payload, estimated UDP, minimum IP, and unavailable link or radio accounting distinct.
- Reconcile receipt issue codes, counters, and immutable events for incomplete as well as verified captures. If the bounded event log is exhausted, mark it incomplete and retain every known receipt-level fact rather than fabricating an event.
- Classify observed capture failures as `capture-path` evidence; CRC or partial-frame detection alone does not prove whether the source, link, decoder, or local capture path caused the corruption.
- Bound live recording by the serialized `.nlsession` size, not only the binary payload size, so every accepted capture remains importable.
- Preserve malformed, partial, checksum-failed, and unknown frames with explicit integrity status and source linkage.
- Bind every new capture to the exact validated decoder pack, schema hash, pack hash, runtime ID, and runtime revision. Run pack fixtures through the production session and diagnostic path; never execute pack-supplied code.
- Keep decoder, replay, range, incident, and bundle behavior pure where practical and add automated tests for changes.
- Make evidence manifests truthful: every listed file must exist, every inclusion toggle must be honored, and hashes must cover the exact emitted bytes.
- Always emit and hash `transport/events.json`, `transport/provenance.json`, `transport/journal.json`, and `transport/integrity-receipt.json`; transport evidence is a mandatory bundle baseline, not an optional group.
- Treat received `.nlb` bytes as untrusted. Preflight bounded ZIP structure and canonical paths before decompression, reject unsupported or ambiguous archive features, and apply strict resource limits, UTF-8 parsing, schemas, counts, ranges, and cross-artifact reconciliation.
- Treat the supported version 3 or 4 manifest duration as authoritative: every selected range, timed event, raw or decoded record, diagnostic, annotation, receipt stop, and bridge-journal offset must remain within it.
- Keep receiver verification in production code and make browser or test helpers thin adapters to it. Report internal consistency, capture and provenance evidence, and authenticity separately; do not turn an unsigned consistency pass into an authenticity claim or treat truthfully incomplete or unknown evidence as tampering.
- Do not add a required cloud dependency for capture, replay, analysis, or export.
- Preserve original bundle bytes in cases. Follow the [case contract](docs/architecture/case-workspace.md) for aggregate nested ZIP limits, exact citations, independently reproduced comparisons, cancellable workers, atomic persistence, and conflicting-revision rejection. Authored case context is not source evidence or an authenticity claim.

## Where changes belong

Use the [repository map](docs/repository-map.md#where-to-make-a-change) for
linked implementation entry points and test routing. The
[documentation index](docs/README.md) routes operator and contributor guides;
[architecture notes](docs/architecture/README.md) cover cross-cutting contracts.

The [design index](docs/design/README.md) distinguishes the approved source and
current screenshots from older implementation captures. Preserve the source's
restrained, square-cornered, instrument-grade hierarchy unless an approved
change establishes a new documented direction.

Keep local Graphify output out of commits. Follow the
[map refresh contract](docs/repository-map.md#generated-files-and-graphify) so
untracked copies, stale symbols, and private evidence cannot be presented as
current GitHub source.

## Visual changes

Treat visible differences from the approved source as regressions unless the pull request explicitly records an approved new product direction in `AGENTS.md`. For material workspace changes:

1. Run the application and load the bundled Harbor relay replay.
2. Capture the source and implementation at the same `1487 × 1058` viewport and equivalent incident state.
3. Put both full frames into one comparison image, then repeat for any fidelity-critical region that is difficult to judge at full scale.
4. Verify the responsive workspace at `390 × 844`, including body overflow, command reachability, timeline labels, incident content, and evidence controls.
5. Update `docs/assets/replaycase-dashboard.png`, the current evidence in `docs/design/`, and `design-qa.md` when the accepted appearance changes.

Screenshots are evidence, not the review itself. Keep `design-qa.md` focused on the currently accepted source and implementation evidence, remaining intentional differences, current interaction coverage, and final pass/block result. Put change-by-change correction history in the pull request and record the notable delivered outcome in `CHANGELOG.md`.

## Tests and review expectations

- Add a focused regression test for decoder, validation, replay, incident-range, or bundle changes.
- Include known-good and malformed cases when changing packet behavior.
- Test exact boundaries at `startUs` and `endUs`; values at `endUs` must be excluded.
- Keep clock tests deterministic by injecting the monotonic time source and frame scheduler.
- Verify evidence changes through the production receiver as well as direct contract assertions; inspect archive paths, manifest metadata, record counts, half-open ranges, cross-document semantics, and SHA-256 values rather than only checking that a download occurred.
- Exercise the receiver with full and minimal bundles, legacy-v1 and pre-provenance-v2 evidence, UDP and serial provenance, disclosed incomplete or unknown evidence, and adversarial archives. Cover strict path and ZIP limits, malformed JSON/NDJSON/CSV, recomputed-checksum semantic tampering, human and JSON reports, and exit statuses `0`, `1`, and `2`.
- For session-library changes, cover valid v1 and v2 session documents, version 1 text, version 2 Blob, and version 3 canonical-byte storage records, the pre-database 64 MiB limit, content identity, exact-duplicate behavior, newest-first listing, validated reopen, cancellation, corruption, missing entries, replay-and-workspace removal, residual-workspace warnings, unavailable IndexedDB, quota exhaustion, and transaction failures.
- For large-session changes, regenerate the 200,000-record corpus and exercise import, progress, cancellation, exact-byte persistence, reload, reopen, selected-range comparison, bundle cancellation, completed export, production verification, heartbeat gaps, and Chromium heap growth in both the source and unpacked-release matrices.
- For case changes, cover exact original bundle bytes, deduplication, unresolved citations, independently recalculated comparisons, nested expansion limits, corruption and revision conflicts, transaction failure, cancellation, clean-profile handoff, and artifact-local save/reopen/export. Controlled fixtures are not independent field proof.
- For UI changes, exercise the bundled replay, file-import error state, saved-session save/list/reopen/remove and failure states, playback, seeking, incident switching, marker creation, note persistence, and bundle flow at desktop and narrow widths.
- Keep critical dialogs and workspace states clean under axe rules tagged WCAG A/AA. Test keyboard focus when an action, dialog phase, incident selection, or responsive layout replaces the focused element; retain visible non-color state and severity cues.
- For capture changes, exercise both the real loopback UDP path and the browser-injected Web Serial application path from profile or direct setup through preflight, the explicit recording boundary, stop, re-import, durable reopen, replay, annotation, bundle export, and production receiver verification. Include decoder mismatch, no probe leakage, active-capture ownership, unconfirmed probe shutdown, sequence gaps, zero-length datagrams, and corrupt serial-length resynchronization in automated coverage. Treat the injected serial gate as application-path evidence, not physical hardware certification.
- For integrity changes, add a failure round trip through capture finalization, JSON serialization, replay parsing, operator-authored half-open range projection, bundle generation, and production receiver verification. Cover both a UDP and serial path when the contract affects both.

## Contribution workflow

1. Read the [Code of Conduct](CODE_OF_CONDUCT.md), then search [open issues](https://github.com/zrack/replaycase/issues) before starting. Open an issue for behavior changes so the operator outcome, acceptance criteria, compatibility impact, and privacy implications can be agreed on first. Small typo-only documentation corrections can go directly to a pull request.
2. Use the route in [SUPPORT.md](SUPPORT.md) for setup and usage help. Do not open a public issue for a suspected vulnerability or attach sensitive telemetry; follow [SECURITY.md](SECURITY.md) instead.
3. External contributors should fork the repository and add this repository as `upstream`. Collaborators may create a branch in the repository. Start from current `main` and use a descriptive branch such as `fix/serial-resync` or `docs/bundle-verification`:

   ```bash
   git fetch upstream
   git switch main
   git pull --ff-only upstream main
   git switch -c fix/serial-resync
   ```

   If the clone uses `origin` for this repository rather than a fork, substitute `origin` for `upstream`.
4. Make one coherent change, add focused tests, update affected current-state documentation, and add an `[Unreleased]` changelog entry when the [changelog policy](#changelog-policy) applies. Run `npm run check`. For visual changes, also complete the evidence workflow in [Visual changes](#visual-changes).
5. Push the branch to your fork or repository remote and open a pull request against `main`. Complete every applicable section of the pull request template, link the tracking issue with `Closes #123` when appropriate, and call out session-format, decoder, incident-range, persisted-data, privacy, or evidence compatibility changes.
6. Wait for the repository's required GitHub Actions checks to pass and address review feedback with additional commits. Do not rewrite another contributor's branch without their agreement.
7. A maintainer squash-merges an approved pull request after required checks pass, then deletes the merged branch. The pull request title should therefore be a useful imperative commit summary.

## Pull request expectations

- Explain the operator outcome, not only the implementation, and keep the change focused on that outcome.
- Add a concise `[Unreleased]` changelog entry for notable changes, or explain why the policy does not apply.
- Include screenshots for material UI changes, document the viewport and replay state used, and update `design-qa.md` when the accepted appearance changes.
- Report the exact local checks run, including `npm run check`; distinguish skipped browser projects or unavailable hardware/manual assistive-technology checks. A local pass complements rather than replaces repository CI.
- State whether file formats, decoder behavior, timing or half-open range semantics, browser storage, archive inclusions, or verification behavior changed.
- Avoid committing generated build output, secrets, private telemetry, sensitive location data, or evidence bundles that have not been cleared for publication.

## Fixtures, privacy, and disclosure

Only contribute telemetry that you have permission to publish. Strip credentials, device identifiers, personal data, operational secrets, and sensitive coordinates before committing a capture. Generated examples are preferred when they can reproduce the same protocol or failure behavior.

Evidence bundles can contain raw records, decoded coordinates, markers, and operator notes. Treat them as potentially sensitive even though ReplayCase builds them locally and does not upload them.

For a security-sensitive issue, do not attach the original capture to a public report. Follow [SECURITY.md](SECURITY.md) to report it privately, describe the affected format and minimum reproduction, and coordinate a sanitized fixture before sharing telemetry.
