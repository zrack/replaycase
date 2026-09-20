# Architecture notes

[Documentation](../README.md) | [Repository map](../repository-map.md)

Start with the [system diagrams](system-overview.md) for runtime boundaries,
capture and replay, incident handoff, comparison, case verification, and local
storage. Use the [repository map](../repository-map.md#execution-paths) to find
the source files and tests behind each path.

| Contract | Scope |
| --- | --- |
| [System architecture diagrams](system-overview.md) | Implemented processes, evidence flow, trust boundaries, and persistence ownership |
| [Multi-bundle cases](case-workspace.md) | Bounded `.nlcase` archives, exact evidence citations, reproduced comparisons, worker processing, and revision-safe local persistence |
| [Branding compatibility](branding-compatibility.md) | Current ReplayCase names versus deliberately stable evidence, decoder, storage, and CLI compatibility identities |
| [UDP capture attribution](udp-capture-attribution.md) | Host socket-drop evidence, layered byte accounting, provenance schemas, and limits on capture-path claims |
| [Decoder packs](../../DECODER_PACKS.md) | Pack identity, allowed runtimes, framing, schemas, fixtures, and contribution boundaries |

Cross-cutting engineering invariants and review requirements belong in
[CONTRIBUTING.md](../../CONTRIBUTING.md#engineering-invariants). Format details
and current support limits belong in the [product README](../../README.md).
