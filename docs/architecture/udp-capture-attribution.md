# UDP capture-path attribution

ReplayCase records only the evidence available at its UDP socket. This contract separates measured capture-path observations from deterministic protocol estimates and unavailable lower-layer evidence.

## Host drop counter

The bridge samples a host counter when its UDP socket starts listening and immediately before that socket closes. The journal stores the nonnegative difference for that one capture when the bridge can identify a unique socket.

| Host | Observation source | Scope | Current result |
| --- | --- | --- | --- |
| Linux with readable procfs | `/proc/self/net/udp` or `/proc/self/net/udp6`, intersected with `/proc/self/fd` socket inodes | One identified ReplayCase UDP socket between start and terminal samples | Measured datagram-drop delta from `linux-proc-net-udp-socket` |
| Linux without readable procfs or a unique socket identity | Explicit unavailable source | No counter is inferred | `unavailable-procfs`, `unavailable-socket-identity`, or `unavailable-counter-regression` |
| macOS and Windows | Explicit unsupported-platform source | No counter is inferred | `unavailable-unsupported-platform` |

An active capture reports `unavailable-capture-active` until its terminal sample exists. A numeric counter is valid only with the measured Linux source; unavailable sources must carry `null`, never zero.

A positive measured delta adds an immutable `udp-kernel-drops-observed` transport event and matching receipt issue. The capture-integrity receipt becomes incomplete, while retained raw records stay unchanged and inspectable. An unavailable host counter is a provenance limitation; it does not by itself claim packet loss or make an otherwise reconciled capture incomplete.

## Byte accounting

UDP provenance schema version 2 records four distinct layers for the whole session:

| Layer | Value | Evidence basis |
| --- | --- | --- |
| Payload | Bridge-retained payload bytes | Observed, exact |
| UDP | Payload plus 8 bytes per datagram | Deterministic estimate |
| IP | UDP estimate plus 20 bytes per IPv4 datagram or 40 bytes per IPv6 datagram | Minimum estimate assuming no IP options, extension headers, or fragmentation |
| Link and radio | `null` | Unavailable at a UDP socket |

ReplayCase does not use these estimates to claim measured wire utilization. Ethernet framing, VLAN tags, tunnels, IP fragmentation, radio framing, forward-error correction, retransmission, encryption overhead, and losses before the socket remain outside this observation point.

## Evidence compatibility

- Live session files remain `.nlsession` format version 2. New UDP captures use nested transport-provenance schema version 2; older valid provenance documents remain readable and are not rewritten.
- New evidence archives use `.nlb` format version 4 so the receiver can require and recompute the byte-accounting contract.
- The receiver accepts bounded bundle versions 3 and 4. Version 3 preserves its original provenance semantics.
- Bundle verification reconciles the journal counter with the transport event and receipt, and independently recomputes every byte-accounting value.

This feature improves attribution at the laptop boundary. It does not establish where upstream loss happened, whether the sender transmitted a missing datagram, or whether the radio link delivered every frame.
