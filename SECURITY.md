# Security Policy

## Supported versions

NarrowsLink is a pre-1.0 project under active development. Security fixes are made on the current `main` branch and, when warranted, in the latest patch release. Superseded patches, older commits, and forks do not receive guaranteed backports.

| Version | Supported |
| --- | --- |
| Current `main` | Yes |
| Latest `0.3.x` patch | Yes |
| Superseded `0.3.x` patches | No guaranteed backports |
| `0.2.x` | No guaranteed backports |
| `0.1.x` | No guaranteed backports |
| `< 0.1.0`, older commits, and forks | No |

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability.

Use the repository's [private Security advisories](https://github.com/zrack/narrowslink/security/advisories) area to report the issue and coordinate with the maintainer. Describe the affected version or commit, the impact, and the minimum steps needed to reproduce the issue.

If GitHub does not offer the private report form for your account, contact the repository owner through their [GitHub profile](https://github.com/zrack) and ask for a private reporting channel without including sensitive technical details.

The maintainer will acknowledge reports as soon as practical, assess their severity and reproducibility, and coordinate remediation and disclosure through the private advisory. Response and fix timing depends on the issue's impact, complexity, and maintainer availability; this project does not currently offer a response-time SLA.

## Protect operational data

Never attach raw telemetry, capture files, evidence bundles, precise coordinates, access tokens, credentials, or device identifiers to a public issue, discussion, pull request, or comment. Start with a sanitized description and synthetic reproduction. If sensitive artifacts are necessary to investigate, coordinate their transfer privately and provide only the minimum data required.

Public reports may include redacted logs and synthetic fixtures after confirming that they contain no operational or identifying data.
