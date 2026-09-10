# ReplayCase {{VERSION}}

This package is the self-contained ReplayCase local operator distribution for
Git tag `{{TAG}}` at commit `{{COMMIT}}`.

## Requirements

- Node.js 20.19 or newer
- A current browser

The package contains the production browser application, the authenticated
local UDP bridge, the bundled Harbor Relay fixture, and the offline evidence
receiver. It has no npm runtime dependencies and does not require a source
checkout, Vite, or development tooling.

Imported and saved replay documents are bounded to 64 MiB of canonical UTF-8
JSON, 200,000 records, and 24 hours. Long replay, comparison, and bundle
operations run in local Web Workers with progress and cancellation. Live
capture retains a separate ceiling of 100,000 records, 32 MiB of retained
payload bytes, 24 hours, and a canonical file within the replay limit.

## Install and run

When upgrading from NarrowsLink, stop it and run `npm uninstall --global narrowslink`
first. Do not install both npm packages side by side: ReplayCase also provides
the legacy `narrowslink` command. Uninstalling code does not remove browser data
or exported evidence.

Install the downloaded release asset without running package scripts:

```bash
npm install --global ./replaycase-{{VERSION}}.tgz --ignore-scripts
replaycase serve
```

Open the loopback URL printed by `replaycase serve`. The command starts both
the browser application and its authenticated local UDP bridge; no token copy
is required.

Verify a received evidence bundle locally:

```bash
replaycase verify path/to/incident.nlb
replaycase verify path/to/incident.nlb --json
```

Inspect the installed build identity:

```bash
replaycase version --json
```

## Evidence compatibility

This release writes version 4 `.nlb` bundles and verifies versions 3 and 4.
Upgrade v0.2.0 receiving installations before sharing a new bundle; they can
read only version 3. There is no downgrade export, and editing an archive's
manifest is not a conversion. Existing version 1 and 2 session files remain
readable without rewriting their evidence.

ReplayCase retains the existing evidence extensions, `narrowslink/...` format
identifiers, decoder-pack contents and hashes, and browser storage keys.
`narrowslink` delegates to the same CLI; both commands report `replaycase` in
version JSON. The old runtime-discovery URL and `NARROWSLINK_*` configuration
variables remain compatibility aliases for their ReplayCase counterparts.

Verification separates internal consistency, capture completeness, and
authenticity. Bundles remain unsigned. A passing verifier does not certify
the source, radio path, or originating engineer.

## Upgrade and removal

Install a newer ReplayCase release and restart it on the same loopback host
and port to retain access to that browser origin's session library. Changing
the hostname, port, or browser profile selects a different browser storage
origin.

Removing the npm package removes the application files but does not erase
IndexedDB or local-storage data held by the browser. Export any sessions that
must be retained, uninstall ReplayCase, and then clear site data for the
ReplayCase loopback origin when an explicit data purge is required.

## Integrity

The GitHub Release publishes this package with `SHA256SUMS`, a normalized
CycloneDX SBOM, and a machine-readable release manifest. Verify the downloaded
asset against those files before installation when it crosses an untrusted
channel. Those same-channel checks establish byte consistency, not publisher
or build-environment authenticity; confirm the expected tag and commit through
a separately trusted channel when authenticity matters.
