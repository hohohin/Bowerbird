# LocalSend core vendored for Bowerbird

Source: https://github.com/localsend/localsend/tree/v1.18.2/packages/core

Tag `v1.18.2`, commit `af0416be50770a97760f7070684bc667b759a15c`; Apache-2.0. The upstream root LICENSE is included. `UPSTREAM.json` records the original core file hashes. This source copy retains the upstream core and web assets; examples/tests/build outputs are excluded. Only its `http` feature is enabled by Bowerbird. It is not a separately promised stable SDK. `BOWERBIRD.patch` records the local runtime changes against this tag.

Local modifications:

- `Cargo.toml`: an empty workspace allows standalone verification, and the omitted example declaration is removed; product dependencies and features otherwise retain upstream values.
- `src/http/server/mod.rs`: add explicit IPv4 binding. The explicitly bound receiving listener disables the wildcard IPv6 listener, permits only the receiving webpage/i18n/upload/cancel routes, checks Host and Origin, requires the pairing PIN for cancellation, and adds no-store/no-referrer/CSP headers. Original `start_with_port` retains its wildcard behavior; Bowerbird uses only `start_with_ipv4`.
- `src/http/server/common/collect_to_json.rs`: cap metadata bodies at 256 KiB before deserialization.
- `src/http/server/common/save.rs`: fail stalled bodies after 60 seconds and observe an application's failed/cancelled writer immediately, so the protocol session does not remain occupied after the writer has stopped.

The Bowerbird adapter owns file admission, byte/count quotas, staged destination callbacks, durable receipt acknowledgement, progress throttling, session cancellation and idle cleanup. No LocalSend discovery, WebRTC, cloud rendezvous or download surface is started. Browser uploads use local HTTP and are not described as encrypted.

Verified with the existing Windows Rust 1.90.0 toolchain (`cargo +stable`); no global toolchain upgrade. The upstream repository selects 1.97.1, but this vendored HTTP subset compiled on 1.90.0. This does not establish a lower MSRV.
