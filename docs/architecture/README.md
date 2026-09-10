# Architecture notes

[Documentation](../README.md) | [Repository map](../repository-map.md)

Start with the [repository map](../repository-map.md#execution-paths) for the
capture, replay, and receiver paths and the source files that implement them.

| Contract | Scope |
| --- | --- |
| [Branding compatibility](branding-compatibility.md) | Current ReplayCase names versus deliberately stable evidence, decoder, storage, and CLI compatibility identities |
| [UDP capture attribution](udp-capture-attribution.md) | Host socket-drop evidence, layered byte accounting, provenance schemas, and limits on capture-path claims |
| [Decoder packs](../../DECODER_PACKS.md) | Pack identity, allowed runtimes, framing, schemas, fixtures, and contribution boundaries |

Cross-cutting engineering invariants and review requirements belong in
[CONTRIBUTING.md](../../CONTRIBUTING.md#engineering-invariants). Format details
and current support limits belong in the [product README](../../README.md).
