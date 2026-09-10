# ReplayCase branding and compatibility

ReplayCase is the current product name. Its canonical repository is
[`zrack/replaycase`](https://github.com/zrack/replaycase), its npm release package
is `replaycase`, and its primary command is `replaycase`. Version 0.4.0 is the
first release under this name. This is a branding change, not an evidence-format
or decoder revision.

## Public names

- Application title, loading/error states, accessibility labels, CLI help, and
  release titles use ReplayCase. The square RC mark replaces the NL mark.
- Release assets use `replaycase-<version>` and their manifests identify
  `ReplayCase`, `replaycase`, and the current repository URL. The release-only
  manifest and build-result formats use `replaycase/...`; the SBOM root is
  `pkg:npm/replaycase@<version>`.
- Newly downloaded captures use a `replaycase-` filename prefix. Extensions and
  source-record contents are unchanged.
- The version command reports `name: "replaycase"`, including through the legacy
  alias. Consumers that compare that display/package identity must update.

## Retained contracts

| Surface | Compatibility requirement |
| --- | --- |
| Sessions, bundles, packs, comparison findings | Keep `.nlsession`, `.nlb`, `.nldecoder`, `.nlcompare.json`, existing `narrowslink/...` formats and vendor media types |
| Decoder identity | Keep published pack contents, schema hashes, revisions, runtime identities, and conformance results; do not relabel hashed descriptions |
| IndexedDB | Keep `narrowslink-session-library`, schema version, stores, and exact content identities |
| Local storage | Keep session-workspace, receiver-workspace, capture-profile, and UDP-start-recovery keys |
| CLI JSON | Keep verification/decoder-report formats and `narrowslink-serve-ready` / `narrowslink-bridge-ready` readiness event types |
| Runtime discovery | Use `/replaycase-runtime.json`; retain `/narrowslink-runtime.json` as an alias with the same secret-free `narrowslink/operator-runtime` document |
| Command compatibility | Package both `replaycase` and `narrowslink`; the latter delegates to the same CLI implementation |
| Configuration | Prefer `REPLAYCASE_*`; retain the matching `NARROWSLINK_*` fallback for bridge tokens, build identity/output, and test configuration |
| Historical artifacts | Preserve published release notes, dated proof records, source-layout image, and deterministic corpus identities as originally recorded |

The application origin remains `http://127.0.0.1:47890`. Use the same browser
profile and origin after upgrading; a different profile, hostname, or port has
separate browser storage. No evidence conversion or storage migration is needed.

## Installation transition

Uninstall the old global `narrowslink` npm package before installing the downloaded
ReplayCase archive because both packages provide the legacy command. Do not use
`--force` to overwrite another package's executable. Uninstalling removes code,
not browser storage or exported evidence. The [operator migration](../../USER_GUIDE.md#upgrade-from-narrowslink)
contains the complete commands.

Keep old published archive names, tags, checksums, release manifests, decoder
packs, and captured evidence intact. GitHub redirects the former repository URL;
use the new URL in active remotes and links, and do not create a new repository
under the old slug while that redirect is needed.

## Regression boundary

The regression suite pins the legacy fixture bytes and both built-in pack hashes,
tests existing storage schemas and report formats, verifies both CLI names and
runtime paths, and runs capture, replay, comparison, bundle verification, and
package-replacement flows. These are software compatibility checks, not physical
radio, serial-adapter, or independent field-handoff certification.
