# protocol

Shared wire and provider contract: schemas, identifiers, daemon methods, provider kit, and provider
conformance tools. It runs without the core so provider teams can validate against the protocol alone.

## Wire and compatibility

`PROTOCOL_VERSION` is `9.1.0`. The daemon's `OLDEST_CLIENT_MAJOR` is `8`, so it serves client major 8
while providers must speak major 9. Package versions and the wire version are separate.

Protocol majors break the wire. Changes within a major are additive. Daemon wire object schemas
strip unknown keys; do not make them strict or passthrough. MCP tool argument schemas are strict.

A client may use a newer daemon only when its advertised `oldestClientMajor` includes the client's
major. Set that value only for client majors the daemon still serves. Removing or renaming a daemon
method requires a protocol major release.

Use `ModulePathSchema` for module paths in wire requests and notifications. It normalizes valid
module keys, and handlers receive the parsed normalized value.

Put behavior shared across providers in the provider kit before duplicating it. Read the ownership
residues in `protocol/src/__tests__/` before changing a shared primitive.

Run conformance from source while iterating, without building the core:

```bash
bun run protocol/src/conformance/cli.ts -- bun run providers/<language>/src/main.ts
bun dist/conformance.js bun run providers/<language>/src/main.ts
```

Run it against every provider after a protocol or provider change. Use the `dist/` command to check
the shipped artifact.
