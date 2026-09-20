# Repository map

[Project home](../README.md) | [Documentation](README.md) | [Contributing](../CONTRIBUTING.md)

## Folder boundaries

| Path | Responsibility |
| --- | --- |
| [src/](../src/) | Browser application, capture adapters, pure telemetry domain, replay, workers, and local persistence |
| [verifier/](../verifier/) | Production archive intake and evidence verification shared by the browser and CLI |
| [scripts/](../scripts/) | Installed CLI, managed local server, UDP bridge, fixture generators, and developer checks |
| [scripts/release/](../scripts/release/) | Deterministic packaging, release identity, SBOM, checksums, and unpacked acceptance orchestration |
| [tests/e2e/](../tests/e2e/) | Source-build browser workflows and their test-only adapters |
| [tests/fixtures/](../tests/fixtures/) | Controlled case fixtures shared by domain, storage, and browser regressions; not physical-capture proof |
| [tests/release/](../tests/release/) | Unpacked-distribution acceptance tests, separate from source-build tests |
| [public/](../public/) | Shipped static assets, runtime-discovery defaults, and the generated deterministic [demo fixture](../public/fixtures/harbor-relay-session.json) |
| [docs/](README.md) | Documentation navigation, architecture contracts, design evidence, field proofs, and release notes |
| [.github/](../.github/) | CI, release automation, dependency policy, issue forms, and pull-request template |

Unit and integration tests live beside the implementation they exercise.
Browser acceptance tests live under `tests/` because they cross those module
boundaries. `verifier/` stays outside the browser tree because both the browser
and installed CLI use it; it is not a test helper.

Root files provide the product and community entry points, package metadata,
and build/test configuration. Keep GitHub community files and existing public
guide paths at the root instead of moving them for visual tidiness.

## Where to make a change

| Area | Entry points |
| --- | --- |
| Workspace and navigation | [App.tsx](../src/App.tsx), [styles.css](../src/styles.css), [main.tsx](../src/main.tsx) |
| Capture configuration and lifecycle | [CaptureDialog.tsx](../src/capture/CaptureDialog.tsx), [recorder.ts](../src/capture/recorder.ts) |
| Profiles and preflight | [capture-profile.ts](../src/capture/capture-profile.ts), [capture-preflight.ts](../src/capture/capture-preflight.ts) |
| Serial device and framing | [web-serial.ts](../src/capture/web-serial.ts), [serial-assembler.ts](../src/capture/serial-assembler.ts), [NSL-01 assembler](../src/capture/nsl01-serial-assembler.ts), [NMEA assembler](../src/capture/nmea0183-serial-assembler.ts) |
| UDP transport | [Browser adapter](../src/capture/udp-bridge.ts), [local bridge](../scripts/capture-bridge.mjs), [Linux drop-counter adapter](../scripts/udp-kernel-drop-counter.mjs) |
| Session loading and canonical bytes | [load-session.ts](../src/data/load-session.ts), [session-file.ts](../src/data/session-file.ts) |
| Schemas and resource limits | [types.ts](../src/domain/types.ts), [limits.ts](../src/domain/limits.ts) |
| Decoder identity and execution | [decoder-pack.ts](../src/domain/decoder-pack.ts), [decoder-conformance.ts](../src/domain/decoder-conformance.ts), [decoder.ts](../src/domain/decoder.ts) |
| Validation, diagnostics, and incidents | [session.ts](../src/domain/session.ts) |
| Shared replay clock | [replay/](../src/replay/) |
| Long-running work, progress, and cancellation | [processing/](../src/processing/) |
| Saved replay library | [session-library.ts](../src/storage/session-library.ts), [session-library-workflow.ts](../src/storage/session-library-workflow.ts) |
| Operator markers, notes, and ranges | [session-storage.ts](../src/storage/session-storage.ts) |
| Archive contract and generation | [evidence-contract.ts](../src/domain/evidence-contract.ts), [bundle.ts](../src/domain/bundle.ts) |
| Received evidence and receiver findings | [receiver/](../src/receiver/), [production verifier](../verifier/evidence-verifier.ts), [ZIP intake](../verifier/evidence-zip.ts) |
| Bounded comparison | [comparison domain](../src/domain/comparison.ts), [comparison workspace](../src/comparison/ComparisonWorkspace.tsx) |
| Multi-bundle case workspace | [cases/](../src/cases/), [case domain](../src/domain/case.ts), [case verifier](../verifier/case-verifier.ts), [case library](../src/storage/case-library.ts), [format contract](architecture/case-workspace.md) |
| Timeline sampling and presentation | [telemetry.ts](../src/lib/telemetry.ts), [time.ts](../src/lib/time.ts) |
| Browser discovery of the managed runtime | [src/runtime/operator-runtime.ts](../src/runtime/operator-runtime.ts) |
| Installed commands and local server | [replaycase.ts](../scripts/replaycase.ts), [scripts/operator-runtime.ts](../scripts/operator-runtime.ts), [CLI build](../vite.cli.config.ts) |
| Demo inputs | [Fixture generator](../scripts/generate-demo-session.mjs), [UDP sender](../scripts/send-demo-udp.mjs), [NMEA sender](../scripts/send-demo-nmea.mjs) |
| Maximum-record acceptance corpus | [large-session-corpus.mjs](../scripts/large-session-corpus.mjs) |

The similarly named runtime files have different jobs: `scripts/operator-runtime.ts`
runs the server on Node.js; `src/runtime/operator-runtime.ts` reads its bounded
discovery response in the browser.

## Execution paths

1. **Capture:** serial or UDP adapter -> bounded recorder -> canonical session
   -> the same validated loading path used by imports and the bundled fixture.
2. **Replay and investigation:** session worker -> domain validation and decoder
   -> immutable replay document -> shared replay clock and operator workspace.
3. **Evidence handoff:** selected half-open range -> bundle worker and archive
   contract -> `.nlb` -> shared production verifier -> bounded receiver workspace.
4. **Installed application:** CLI `serve` -> managed static server and UDP bridge
   -> browser runtime discovery. Packaging and release tests verify this path
   outside the source checkout.
5. **Case handoff:** verified bundles -> exact citations and comparison findings
   -> case worker -> bounded `.nlcase` -> nested production verification and
   reproduced comparisons -> case workspace and atomic local case library.

Raw records are immutable. Browser UI, worker adapters, and test helpers must
not create independent interpretations of the same evidence. Consult
[engineering invariants](../CONTRIBUTING.md#engineering-invariants) before
changing a cross-module contract.

## Verification routes

| Change | Start with |
| --- | --- |
| Domain, adapter, worker, or storage behavior | Adjacent `*.test.ts` or `*.test.mjs` files, then `npm test` |
| Browser workflow, accessibility, or responsive layout | [tests/e2e/](../tests/e2e/) and [source Playwright config](../playwright.config.ts) |
| CLI, package, installation, or runtime discovery | [CLI smoke test](../scripts/cli-smoke.mjs), [release tooling tests](../scripts/release/release-lib.test.mjs), [tests/release/](../tests/release/), and [release Playwright config](../playwright.release.config.ts) |
| Documentation | Check relative links and heading anchors; follow the [documentation index](README.md) and the changed guide from the README |
| Pull request | The complete `npm run check` gate and required repository CI, as defined in [Contributing](../CONTRIBUTING.md#required-checks) |

## Generated files and Graphify

`node_modules/`, `dist/`, `dist-cli/`, `build/`, coverage, temporary files,
release/test output, and `graphify-out/` are local generated artifacts excluded
by [.gitignore](../.gitignore). They are not source folders to reorganize or
commit. Do not commit private captures or incident bundles as map inputs.

This linked map is the GitHub-readable source guide. A local Graphify build adds
`graphify-out/graph.json`, `GRAPH_REPORT.md`, `graph.html`, and `GRAPH_TREE.html`
for symbol and relationship exploration. Generated graphs are discovery aids;
the source files and canonical documents remain authoritative.

Refresh Graphify from a clean checkout of the intended commit, not a directory
containing untracked source copies or private evidence. Use the Graphify skill's
full update workflow when documentation or images changed; `graphify update .`
alone refreshes code extraction, not those semantic results. After rebuilding,
generate the folder view with `graphify tree --root . --label ReplayCase`.
Record the source commit, file hashes, tool version, extraction scope, and build
time alongside the outputs. A newly generated HTML file does not prove that
its underlying graph was refreshed.

Before accepting a refresh, verify that graph paths exist in the captured
source, removed files have no surviving nodes, and retained semantic results
match their source hashes. Label working-tree changes and intentionally
uninterpreted assets explicitly. A separate account-wide GitHub tree must
refresh this repository's full `zrack/replaycase` identity and captured refs;
rebuilding the local code graph does not refresh that inventory.
