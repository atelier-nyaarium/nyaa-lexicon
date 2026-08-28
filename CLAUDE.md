# nyaa-lexicon

Symbol-level code understanding served from one core: an MCP server for agents and an LSP server
for editors. Point at a symbol, ask what it is, and get structure, direction (who defines it, who
uses it), types, and honest uncertainty.

Ships as the `lexicon` plugin on the `atelier-nyaarium` marketplace.

## Layout

Bun workspace monorepo. Seven packages, and the boundaries are real.

- `protocol/` - zod schemas, the symbol and fact id grammars, the daemon method table, the
  conformance suite. Runs without the core, so a provider team is never blocked on us.
- `client/` - the client half of the daemon socket: find or spawn a daemon, connect, ask. Depends
  on protocol only and never writes index state; the daemon and both adapters consume it, and so
  can any other node project.
- `core/` - daemon, SQLite store, provider supervisor, every query, the knowledge layer.
- `adapters/mcp/` - agent-facing tools over stdio.
- `adapters/lsp/` - the editor face, answering from the same service class but its own instance,
  which is why it reads and does not write.
- `providers/<language>/` - one per language, separate process, own runtime, speaks the protocol.
- `formats/` - the one reading of a data format, for the providers that meet the same one. Markdown
  frontmatter and a `.yml` file are the same mapping, so they are the same function. It takes
  provider context as DATA, never as a language to branch on.
- `docs/` - architecture, provider-protocol, daemon-protocol, client, knowledge-layer, parsing.

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

`dist/` is not standalone, though. The plugin ships the whole checkout, and `lexiconRoot()` walks up
from the running file looking for a directory holding both `providers/` and `package.json`, which is
how the daemon finds the provider bundles to spawn. Copying `dist/` somewhere on its own throws
`could not locate the lexicon repository from this build`, which is the right answer to an unsupported
layout rather than a bug to route around.

**Bun has no `node:sqlite`**, so anything touching the store cannot run under `bun run` at all. Run
it from `dist/` under node:

```bash
bun run build --build-only                       # bundle without bumping or committing

node dist/index-workspace.js <repo> [symbol]     # index a repo, optionally query a name
node dist/grade.js <switchboard checkout>        # graded checks against a repo whose answers are known
node dist/daemon.js <repo>                        # the daemon itself
```

**Conformance never touches the store, so it does not need the build at all.** Run it from source
and skip the rebuild while iterating on a provider or the corpus:

```bash
bun run protocol/src/conformance/cli.ts -- bun run providers/<language>/src/main.ts
node dist/conformance.js bun run providers/<language>/src/main.ts   # same thing, from the artifact
```

Use the `dist/` form to check what actually ships, and before a release.

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

**The build starts every bundled provider on node before it finishes.** Bundling proves the imports
resolved, not that the thing runs, and a provider that dies on launch is recorded as an outage and
skipped, so the index reports files in scope and no facts. A provider that cannot start fails the
build, and a failed release build reverts `dist/` along with the version files.

**It also refuses any bundle carrying a UMD wrapper.** A wrapper surviving IS the bundler having
failed to resolve that dependency, so its inner requires are still there and resolve against `dist/`
at runtime. Import the package's ESM entry instead, by path if it declares no `exports` map. This
check is static because the startup smoke cannot reach the case: it runs providers only, and only at
launch, so a lazily-evaluated UMD module dies at first parse and smokes clean.

**A green `bun run test` is not evidence that the artifact runs.** Everything in the edit loop runs
under bun, and bun resolves what node refuses. The build is the only gate that meets the shipping
runtime.

**Provider extraction changes require a MAJOR release.** Major releases retire stored facts. If a
provider changes a kind, name, range, binding or literal for unchanged source, ship a major.
Correcting `typeParameter` to `interface` is this case.

**Removing or renaming a daemon method requires a PROTOCOL major.** Clients connect to daemons
NEWER than themselves on the premise that method tables only grow within a protocol major. Removals
have happened (`graphOf`, `renameSymbol`); each now costs a protocol major, or a stale client's
calls start failing as `unknown method`.

Patch and minor releases preserve stores. Build updates every provider manifest, so core-only
releases do not invalidate facts.

`dist` means exactly one thing here: the shipped bundle. Package `tsc` output goes to `.tsbuild/`.

**After a crash, call `project_diagnostics` with the store key** before guessing. It renders
`diagnostics.json` and `reports/` from the workspace's state directory, no daemon needed: which
process held the memory, what the daemon was doing, and where each dead heap went.
`LEXICON_HEAP_SNAPSHOT=1` on the daemon adds a heap snapshot near the limit for a targeted repro,
gigabytes each, so not by default.

Node 22.5+ required, for `node:sqlite`. Reports carry the environment below 22.13.

## Verifying a change

Ordered by how much they prove:

1. `bun run test` for the unit level.
2. Conformance if the change touches a provider or the protocol, every provider, not just the
   one you edited. A corpus case is shared, so an edit for one language runs against every other.
3. `node dist/grade.js <switchboard checkout>` if it touches extraction, resolution or the service. This asks a real
   repository questions whose right answers are already known, so it catches "produces output" that
   is not "produces the right output".

   **Budget minutes, and do not wrap it in a short timeout.** It indexes about a thousand files
   into an in-memory store on every run, which has taken five minutes, and a run killed early looks
   exactly like a hang. That reading has already arrived as a release blocker. Nothing lexicon owns
   persists between runs, so a repeat that finishes in seconds is not a store being reused.
4. Drive the built server against a real workspace. **A green gate is not evidence.** A multi-file
   cold-bind defect and a test that could never fail both survived a clean gate, and both died to a
   five-line probe.

## Rules that already cost something

- **Residue tests are build gates.** When adding one, plant the violation and watch it fail before
  trusting it. The first one here passed against a real violation. Every sweep also asserts it FOUND
  files to check, so a run matching nothing fails instead of quietly reporting clean.
- **Match the token, never the context around it.** Planting proves a check fires on the case you
  thought of, and says nothing about the ones you did not. Two checks written against the spelling
  that motivated them both let other spellings straight through: the UMD gate matched one of four
  real AMD headers, and the language sweep required an adjacent `===`, so a name held in a `const`
  or reached by `startsWith` walked past. Forbid the narrowest unambiguous token instead. Where the
  token already has instances on disk, run the check against ALL of them before trusting it.
- **Never branch on a language in `core/` or `formats/`.** A residue test fails the build on the
  quoted name itself; the fix is a new field on the provider contract.
- **Never write a control byte, em dash, smart quote or zero-width character into source.** Enforced
  over every tracked file. A raw NUL is legal to tsc, invisible in an editor, identical at runtime,
  and makes git call the file binary and grep return nothing for any pattern in it.
- **A test asserting current behavior is not a test.** After a fix, tests that encoded the bug will
  fail; that is the fix working.
- **A conformance `STALL` is the machine or the run, never the provider.** A timeout or a dead
  process is reported as stalled, with the load and the elapsed time, and the CLI exits 3 rather
  than 1. Five times a loaded machine read as a provider defect, once as a release blocker, and none
  reproduced. Re-run at lower load before believing one; never file it as a provider bug from the
  first run.
- **Parsers follow `docs/parsing.md`.** Check for a library before writing one.
- **Comments state constraints, not narration.** One line, two at most for a critical one.

## Blind test corpora

Two repositories nobody working here reads. **The discipline is the point: no Read, no grep, no
opening a file. Only lexicon's own tool output.** A tool that can only be evaluated by someone who
already knows the answer is being graded on a test it has seen.

- **evie-bot** - the SOURCE test. Can it teach you a codebase you have never opened? This is the
  corpus that exercises comments: its prose carries invariants, their enforcement and their failure
  modes, so a comment tier either surfaces them or does not.
- **nyaaskills** (its `dist/`) - the HARD test. A single minified bundle where every identifier is
  two characters, so names become noise, the reference graph stays structurally intact and
  semantically useless, and LITERALS carry the entire public contract verbatim. This is where the
  free facts run out and the citation discipline either holds or does not.
  Minification strips comments, so the comment tier has nothing to report here and finding nothing
  is the right answer rather than a gap. Use this corpus for literals; use evie-bot for prose.

  **Indexing that bundle takes a step, and pointing at it bare does not work.** The TypeScript
  provider is project-model driven, so a directory with no `tsconfig.json` enumerates no files and
  the scan reports zero with nothing to explain it. Give the corpus a `tsconfig.json` whose `include`
  names the bundle, then index the directory holding it. Indexing the package root instead gets its
  source, not the bundle, since a project's own config does not include its build output.

Corpora clone into `temp/`, which is ignored.

## References

Sibling projects this one learned from. Paths are wherever they are checked out; nothing here
assumes a layout.

- **nyaadot** - the framework-first role model. Read its doctrine and its `util/` primitives before
  designing a new mechanism here.
- **switchboard** - the toolchain and plugin-packaging reference, and a dogfood target: barrel
  re-exports, a Kotlin twin held by fixtures, and residue tests.
