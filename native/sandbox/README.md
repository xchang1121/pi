# Pi Native Sandbox

This crate is the source-built process-isolation backend for the
`@earendil-works/pi-speculative-action` package. It implements one versioned
JSON protocol on the platforms where a compact native boundary is available:

- Linux: user, mount, network, PID, IPC, and UTS namespaces; a read-only host
  view; a writable staged workspace; seccomp; capability removal; and
  process-tree supervision.
- macOS: an in-process Seatbelt profile with source/home/network denial,
  staged-workspace writes, and process-tree supervision.

Windows uses the package's OCI worker backend. AppContainer mandatory ASLR is
incompatible with the fork model used by MSYS2/Git Bash, so retaining a second
Windows-native implementation would not satisfy the Bash tool's execution
contract.

The package build helper compiles this crate, hashes the result, and records a
platform asset in `prebuilds/manifest.json`. The TypeScript broker verifies
that hash and materializes a private executable copy before use. An explicitly
configured development binary is probed with the same protocol and fails
closed if missing or incompatible.

## Protocol

```text
pi-sandbox-native --native-sandbox check
pi-sandbox-native --native-sandbox execute --request request.json
```

## Build and test

```text
npm run build:native --workspace @earendil-works/pi-speculative-action
cargo test --manifest-path native/sandbox/Cargo.toml --all-targets
```

Set `PI_NATIVE_SANDBOX_REQUIRED=1` to make platform integration tests fail
instead of skip when the host cannot provide its native isolation API.
