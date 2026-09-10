# ReplayCase Support

ReplayCase is an early-stage local application. Community support is provided through GitHub on a best-effort basis; there is no guaranteed response time or production support agreement.

## Start here

1. Read the setup and workflow guidance in [README.md](README.md).
2. For an installed release, run `replaycase version --json`, record the version and commit, and reproduce the behavior with the bundled synthetic fixture. Capture the exact `replaycase serve` or `replaycase verify` output without including telemetry or credentials.
3. For a source checkout, reproduce on the latest `main` branch, run `npm run check`, and record the failing command or test name.
4. Search existing issues before filing a new report.

Use the structured bug form for a reproducible product defect and the feature form for a proposed operator outcome. Include the ReplayCase commit, operating system, browser version, workflow path, telemetry source type, and minimal reproduction steps. For replay-processing problems, also include the canonical file byte size, record count, session duration, last visible processing phase and percentage, whether cancellation completed, and whether the prior workspace and saved entry remained intact. Report approximate memory only when the browser exposes it; never attach the source capture just to prove its size.

## Protect telemetry

GitHub issues are public when this repository is public. Do not post credentials, operational payloads, personal data, precise locations, device identifiers, proprietary protocols, or evidence bundles from real sessions. Prefer the bundled fixture or a minimal synthetic sample and document how it was generated. Sanitizing a capture does not replace authorization to share it.

If a problem cannot be demonstrated without sensitive data, describe its structure and observable failure without attaching the source. Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not support or bug discussions.

## Scope

Useful support requests cover ReplayCase installation, supported capture/import paths, replay and incident behavior, decoder diagnostics, progress or cancellation behavior, local-library persistence, evidence-bundle generation, and verifiable reproductions against the current repository state.

Project maintainers cannot validate field hardware, authorize telemetry disclosure, recover damaged source data, or guarantee compatibility with undocumented proprietary protocols. For a new protocol or workflow, open a feature request with testable acceptance criteria and a synthetic fixture plan.
