# nyaa-lexicon

Symbol-level code understanding served from one core: an MCP server for agents and an LSP server
for editors. Point at a symbol, ask what it is, and get structure, direction (who defines it, who
uses it), types, and honest uncertainty.

Ships as the `lexicon` plugin on the `atelier-nyaarium` marketplace.

## Layout

Bun workspace monorepo. Five packages, and the boundaries are real.

- `protocol/` - zod schemas, the symbol and fact id grammars, the conformance suite. Runs without
  the core, so a provider team is never blocked on us.
- `core/` - daemon, SQLite store, provider supervisor, every query, the knowledge layer.
- `adapters/mcp/` - agent-facing tools over stdio.
- `adapters/lsp/` - the editor face, answering from the same service class but its own instance,
  which is why it reads and does not write.
- `providers/<language>/` - one per language, separate process, own runtime, speaks the protocol.
- `docs/` - architecture, provider-protocol, knowledge-layer, parsing.

## Principles

- **No band-aids.** Weigh the long-run cost of a workaround against the one-time cost of the right
  design. Touch counts are not a reason to defer.
- **Bug-class elimination is the unit of work.** Do not fix the bug; build the primitive that makes
  the class impossible, then write down that it is impossible.
- **Single-owner invariants, enforced.** One module owns a concept, everything else routes through
  it, and a residue test fails the build if another module touches it.
- **Uncertainty lives in the value, never the interface.** Three-valued answers over absence, and
  every Unknown carries a reason from a closed enum.
- **Honest incompleteness, in writing.** A pinned contract does not mean the body exists, and
  pretending otherwise is the one lie this project exists to stop telling.
- **Test density is a bar.** Roughly 0.4 test-lines per source-line. A phase without its tests is
  not done.

## Development

```bash
bun install
bun run lint      # biome ci AND tsc --build, both run, both reported
bun run test      # vitest, including the residue tests
bun run lint:fix
```

**Read both halves of the gate.** Grepping lint output for `error TS` misses every formatting
failure, which has already produced a confident "gate clean" that was not. When in doubt, run
`bunx biome ci . --reporter=summary` on its own.

**Bun is the development runtime; node is the SHIPPING runtime.** Consumers run `node dist/main.js`
with no install step, which is the whole reason `dist/` is committed. A `bun:`-prefixed import works
here and fails in the artifact, on the platform the build exists to serve.

**Bun has no `node:sqlite`**, so anything touching the store cannot run under `bun run` at all. Run
it from `dist/` under node:

```bash
bun run build --build-only                       # bundle without bumping or committing

node dist/index-workspace.js <repo> [symbol]     # index a repo, optionally query a name
node dist/grade.js <switchboard checkout>        # graded checks against a repo whose answers are known
node dist/daemon.js <repo>                        # the daemon itself
node dist/conformance.js bun run providers/<language>/src/main.ts
```

**Dogfooding runs through the installed plugin.** `.mcp.json` resolves through
`${CLAUDE_PLUGIN_ROOT}`, so this checkout no longer registers a server for itself. Pointing lexicon
at its own code is how most of its real defects were found, so after changing anything the tools
reach, rebuild and reload the plugin rather than assuming the running server is current.

### Releasing

```bash
bun run build patch|minor|major   # bump every manifest, bundle dist/, commit both
```

Never hand-edit a version. The root `package.json` is the only file BUMPED; every workspace package
and `.claude-plugin/plugin.json` is SET from it, and the MCP server DERIVES its version at build
time. Bumping and building are one command because a `dist/` built at a version the manifests do not
claim looks correct and is not.

**Provider extraction changes require a MAJOR release.** Major releases retire stored facts. If a
provider changes a kind, name, range, binding or literal for unchanged source, ship a major.
Correcting `typeParameter` to `interface` is this case.

Patch and minor releases preserve stores. Build updates every provider manifest, so core-only
releases do not invalidate facts.

`dist` means exactly one thing here: the shipped bundle. Package `tsc` output goes to `.tsbuild/`.

Node 22.5+ required, for `node:sqlite`.

## Verifying a change

Ordered by how much they prove:

1. `bun run test` for the unit level.
2. `node dist/conformance.js ...` if the change touches a provider or the protocol.
3. `node dist/grade.js <switchboard checkout>` if it touches extraction, resolution or the service. This asks a real
   repository questions whose right answers are already known, so it catches "produces output" that
   is not "produces the right output".
4. Drive the built server against a real workspace. **A green gate is not evidence.** A multi-file
   cold-bind defect and a test that could never fail both survived a clean gate, and both died to a
   five-line probe.

## Rules that already cost something

- **Residue tests are build gates.** When adding one, plant the violation and watch it fail before
  trusting it. The first one here passed against a real violation. Every sweep also asserts it FOUND
  files to check, so a run matching nothing fails instead of quietly reporting clean.
- **Never branch on a language in `core/`.** A residue test fails the build; the fix is a new field
  on the provider contract.
- **Never write a control byte, em dash, smart quote or zero-width character into source.** Enforced
  over every tracked file. A raw NUL is legal to tsc, invisible in an editor, identical at runtime,
  and makes git call the file binary and grep return nothing for any pattern in it.
- **A test asserting current behavior is not a test.** After a fix, tests that encoded the bug will
  fail; that is the fix working.
- **Parsers follow `docs/parsing.md`.** Check for a library before writing one.
- **Comments state constraints, not narration.** One line, two at most for a critical one.

## Blind test corpora

Two repositories nobody working here reads. **The discipline is the point: no Read, no grep, no
opening a file. Only lexicon's own tool output.** A tool that can only be evaluated by someone who
already knows the answer is being graded on a test it has seen.

- **evie-bot** - the SOURCE test. Can it teach you a codebase you have never opened?
- **nyaaskills** (its `dist/`) - the HARD test. A single minified bundle where every identifier is
  two characters, so names become noise, the reference graph stays structurally intact and
  semantically useless, and LITERALS carry the entire public contract verbatim. This is where the
  free facts run out and the citation discipline either holds or does not.

Corpora clone into `temp/`, which is ignored.

## References

Sibling projects this one learned from. Paths are wherever they are checked out; nothing here
assumes a layout.

- **nyaadot** - the framework-first role model. Read its doctrine and its `util/` primitives before
  designing a new mechanism here.
- **switchboard** - the toolchain and plugin-packaging reference, and a dogfood target: barrel
  re-exports, a Kotlin twin held by fixtures, and residue tests.
