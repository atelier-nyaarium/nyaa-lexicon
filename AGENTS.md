# nyaa-lexicon

Symbol-level code understanding served through MCP and LSP. The core indexes workspaces, language
providers extract facts in separate processes, and clients and adapters expose the shared service.

## Packages

- `protocol/`: wire schemas, identifiers, provider kit, and provider conformance tools.
- `client/`: daemon discovery and socket client.
- `core/`: daemon, SQLite index, provider supervisor, queries, and knowledge layer.
- `adapters/mcp/` and `adapters/lsp/`: agent tools and editor support.
- `providers/<language>/`: one provider package per language.
- `formats/`: shared readers for data formats used by providers.
- `docs/`: architecture, protocol, client, knowledge, and parsing guides.

## Development

```bash
bun install
bun run check
bun run corpora
bun run lint
bun run test
bun run bench
bun run snapshot
bun run build patch|minor|major
```

- `bun run check` runs corpora, lint, and tests. Tests run against a fresh `dist/`, then restore it.
- `bun run corpora` syncs test repositories to pinned commits under `temp/`; `--reset` discards local edits.
- `bun run lint` runs Biome and the TypeScript project build, reporting both results.
- `bun run test` runs Bun tests, including residue tests. Package tests live in `src/__tests__/`;
  script tests live in `scripts/__tests__/`.
- `bun run bench` measures a cold index. Use `--against <ref>` to gate indexing changes on time and file count.
- `bun run snapshot` builds a fresh bundle and creates `refs/snapshots/dev` for a consumer project.
  It uses a scratch index and leaves the checkout and real index unchanged.
- `bun run build patch|minor|major` updates versions, bundles `dist/`, and commits the release. Do
  not edit package versions by hand. `bun run build --build-only` builds without a bump or commit.
- Run conformance after provider or protocol changes, against every provider:

  ```bash
  bun run protocol/src/conformance/cli.ts -- bun run providers/<language>/src/main.ts
  bun dist/conformance.js bun run providers/<language>/src/main.ts
  ```

  The source command is for iteration; the `dist/` command checks the shipped artifact.

`dist/` is the committed runtime bundle, not a standalone distribution. The plugin ships the full
checkout so the daemon can find provider bundles. `check`, `bench`, and `snapshot` build it and restore
the committed bundle. Package TypeScript output goes to `.tsbuild/`. Source tests do not verify the
bundle; the build smoke checks the bundled providers.

Provider fact changes for unchanged source require a package major release. Removing or renaming a
daemon method requires a protocol major release. Package and protocol versions are separate.

For daemon crashes, run `project_diagnostics` with the store key before investigating.

## Invariants

- Cross-language primitives belong in `protocol/`; shared data-format readers belong in `formats/`.
  Never branch on a language in `core/` or `formats/`. Read `docs/parsing.md` before adding or
  changing a provider.
- The protocol provider kit owns provider module state. Core publishes `moduleAdmission` only after
  the index records a commit or refusal. Providers learn from that verdict, not from their output.
- Indexing must not run code from the indexed workspace. Start daemon and provider children through
  `bunCommand` in `client/src/launch.ts`; run bounded child processes through `runBounded`.
- Residue tests enforce ownership rules and are build gates. Read source through
  `protocol/src/astResidue.ts`, not text matching. Plant a negative control and make each sweep fail
  if it finds no files to inspect. Match the narrowest unambiguous token and check every existing
  occurrence before trusting a new residue.
- Daemon wire schemas strip unknown object keys. Do not make them strict or passthrough. MCP tool
  argument schemas reject unknown keys.
- Uncertainty belongs in the answer with a reason from the protocol's closed set. Do not guess or
  omit an unavailable fact.
- Source files must not contain control bytes, smart quotes, em dashes, or zero-width characters.

See `docs/architecture.md` for core coordination and `docs/knowledge-layer.md` for knowledge rules.
