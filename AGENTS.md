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
- **Anything repeatable across languages is abstracted before it repeats again.** A shape landing in
  a second provider is the signal; the third is a defect class. The primitive goes in `protocol/`,
  language facts stay with the provider, and a residue forbids a provider redefining a member the
  kit owns.
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
bun run test      # bun test, including the residue tests
bun run lint:fix
```

**Read both halves of the gate.** Grepping lint output for `error TS` misses every formatting
failure. When in doubt, run `bunx biome ci . --reporter=summary` on its own.

**Bun is the one runtime**, for development, tests and shipping; the floor is `BUN_FLOOR` in
`client/src/runtime.ts`, since 1.3.9 and below resolve no `node:sqlite` and lack the `bun test`
flags the gate uses, and every entry point but the conformance CLI, which a provider team may run
anywhere, refuses anything else by name. Consumers run `bun dist/main.js` with no install step, which is the whole reason
`dist/` is committed: Claude Code runs `bun install` in an installed plugin, Copilot copies the
repository and runs nothing, and the bundle needs neither. The bundle is built for node's module
surface and carries no `bun:` import, so `client/` and `protocol/` stay importable from a consumer's
node process (Switchboard's vitest is one).

`dist/` is not standalone, though. The plugin ships the whole checkout, and `lexiconRoot()` walks up
from the running file looking for a directory holding both `providers/` and `package.json`, which is
how the daemon finds the provider bundles to spawn. Copying `dist/` somewhere on its own throws
`could not locate the lexicon repository from this build`, which is the right answer to an unsupported
layout rather than a bug to route around.

Bun ships `node:sqlite`, so the store, the indexer and the daemon run from source and from the
bundle alike:

```bash
bun run build --build-only                       # bundle without bumping or committing

bun core/src/indexCli.ts <repo> [symbol]         # index a repo, optionally query a name
bun dist/grade.js <switchboard checkout>         # graded checks against a repo whose answers are known
bun dist/daemon.js <repo>                        # the daemon itself
```

**Conformance never touches the store, so it does not need the build at all.** Run it from source
and skip the rebuild while iterating on a provider or the corpus:

```bash
bun run protocol/src/conformance/cli.ts -- bun run providers/<language>/src/main.ts
bun dist/conformance.js bun run providers/<language>/src/main.ts   # same thing, from the artifact
```

Use the `dist/` form to check what actually ships, and before a release.

**Dogfooding runs through the installed plugin.** `.mcp.json` resolves through
`${CLAUDE_PLUGIN_ROOT}`, so this checkout registers no server for itself. After changing anything
the tools reach, rebuild and reload the plugin rather than assuming the running server is current.

### Releasing

```bash
bun run build patch|minor|major   # bump every manifest, bundle dist/, commit both
```

Never hand-edit a version. The root `package.json` is the only file BUMPED; every workspace package
and `.claude-plugin/plugin.json` is SET from it, and the MCP server DERIVES its version at build
time. Bumping and building are one command because a `dist/` built at a version the manifests do not
claim looks correct and is not.

**The build starts every bundled provider before it finishes.** Bundling proves the imports
resolved, not that the thing runs, and a provider that dies on launch is recorded as an outage and
skipped, so the index reports files in scope and no facts. A provider that cannot start fails the
build, and a failed release build reverts `dist/` along with the version files.

**It also refuses any bundle carrying a UMD wrapper.** A wrapper surviving IS the bundler having
failed to resolve that dependency, so its inner requires are still there and resolve against `dist/`
at runtime. Import the package's ESM entry instead, by path if it declares no `exports` map. This
check is static because the startup smoke cannot reach the case: it runs providers only, and only at
launch, so a lazily-evaluated UMD module dies at first parse and smokes clean.

**A green `bun run test` is not evidence that the artifact runs.** The suite imports sources, and
the bundle is a different resolution of them. The build's provider smoke and the UMD gate are what
meet the artifact.

**Provider extraction changes require a MAJOR release.** Major releases retire stored facts. If a
provider changes a kind, name, range, binding or literal for unchanged source, ship a major.
Correcting `typeParameter` to `interface` is this case.

**Removing or renaming a daemon method requires a PROTOCOL major.** Clients connect to daemons
NEWER than themselves on the premise that method tables only grow within a protocol major. Without
the major, a stale client's calls start failing as `unknown method`.

Patch and minor releases preserve stores. Build updates every provider manifest, so core-only
releases do not invalidate facts.

`dist` means exactly one thing here: the shipped bundle. Package `tsc` output goes to `.tsbuild/`.

**After a crash, call `project_diagnostics` with the store key** before guessing. It renders
`diagnostics.json` and `reports/` from the workspace's state directory, no daemon needed: which
process held the memory, what the daemon was doing, and where each dead heap went.
`LEXICON_HEAP_SNAPSHOT=1` on the daemon adds a heap snapshot near the limit for a targeted repro,
gigabytes each, so not by default.

Crash reports are the daemon's own: a high-water sample and, with `LEXICON_HEAP_SNAPSHOT=1`, a heap
snapshot from the runtime, both under the store's `reports/`. Providers are never signalled for
one; bun treats the signal as a death.

## Verifying a change

Ordered by how much they prove:

1. `bun run test` for the unit level.
2. Conformance if the change touches a provider or the protocol, every provider, not just the
   one you edited. A corpus case is shared, so an edit for one language runs against every other.
3. `bun dist/grade.js <switchboard checkout>` if it touches extraction, resolution or the service. This asks a real
   repository questions whose right answers are already known, so it catches "produces output" that
   is not "produces the right output".

   **Budget minutes, and do not wrap it in a short timeout.** It indexes about a thousand files
   into an in-memory store on every run, up to five minutes, and a run killed early looks exactly
   like a hang. Nothing lexicon owns persists between runs, so a repeat that finishes in seconds is
   not a store being reused.
4. Drive the built server against a real workspace. **A green gate is not evidence.** A defect the
   suite cannot express survives a clean gate and dies to a five-line probe.

## Rules

- **Residue tests are build gates.** When adding one, plant the violation and watch it fail before
  trusting it. Every sweep also asserts it FOUND files to check, so a run matching nothing fails
  instead of quietly reporting clean.
- **Match the token, never the context around it.** Planting proves a check fires on the case you
  thought of, and says nothing about the ones you did not. A check written against the spelling that
  motivated it lets every other spelling through. Forbid the narrowest unambiguous token. Where the
  token already has instances on disk, run the check against ALL of them before trusting it.
- **Never branch on a language in `core/` or `formats/`.** A residue test fails the build on the
  quoted name itself; the fix is a new field on the provider contract.
- **Core asks providers through `ProviderPort`, and tests double it through `fakeSupervisor`.**
  The port is declared where its callers live, so a member core starts calling fails the type check
  rather than a suite at runtime. A residue forbids casting a double to the supervisor class. The
  shared double settles what the wire settles: an
  unowned or contested module refused, a provider that is not running refused, comments kept only
  where the tiers declare them, every answer parsed by its schema. A double that skips one of those
  proves a path the daemon cannot reach.
- **Never write a control byte, em dash, smart quote or zero-width character into source.** Enforced
  over every tracked source file except generated `dist/` and temporary `tmp/` files. A raw NUL is
  legal to tsc, invisible in an editor, identical at runtime, and makes git call the file binary and
  grep return nothing for any pattern in it. Scan with `grep -a`: without it the file holding the
  byte is exactly the file grep goes silent on, so "no match" reads as clean.
- **Time in `core/` comes from `clock.ts`.** Every module but the owner is swept for `Date.now`,
  `new Date()`, `setTimeout`, `setInterval`, `setImmediate`, `Bun.sleep` and their kin, and one
  `Clock` is handed from the daemon's composition root to the store, the service, the ledger, the
  transaction manager, the supervisor and the transport, so a fake clock drives a whole daemon in a
  test. A new stamp or timer takes the clock it is handed; an entry point that builds no daemon
  reads `systemClock` by name at its top.
- **A daemon handler declares its effect.** Only `read`, `write` and `staged` in `core/src/dispatch.ts`
  mint one, so a bare function cannot sit in the table and the dispatcher takes the workspace gate
  by tag. `staged` is the shape the type cannot check, since a handler handed the gate may ignore
  it; a residue pins those methods by name, and adding one is a reviewed edit. A read never
  counts demand: the recall handler counts it afterwards as the daemon's own write.
- **A test asserting current behavior is not a test.** After a fix, tests that encoded the bug will
  fail; that is the fix working.
- **A conformance `STALL` is the machine or the run, never the provider.** A timeout or a dead
  process is reported as stalled, with the load and the elapsed time, and the CLI exits 3 rather
  than 1. Re-run at lower load before believing one; never file it as a provider bug from the first
  run.
- **Parsers follow `docs/parsing.md`.** Check for a library before writing one.
- **Comments state constraints, not narration.** One line, two at most for a critical one.
- **A refusal names what the author did and what to do instead.** A merely correct refusal, like
  "not in the index", leaves the reader to invent a next step and invent it wrong. Every refusal is
  a constructor in `core/src/refusals.ts`, knowledge and refactor alike; a raw string in a reason
  slot is a type error in core and a residue refuses the cast.
  Slots the protocol types as `string` are narrowed for core in `refusalSlots.ts` and asserted in
  `refusalSlots.types.ts`, so widening one fails `tsc`. A warning riding a success is not a
  refusal and stays a string.
- **Knowledge is keyed by a subject, never by a symbol id.** `core/src/subjects.ts` owns the table
  and every transition; a row's key never changes (a trigger refuses the update), and identity moves
  only by rebinding the address. A refactor step journals what its rebind moved, with the state it
  replaced, in the same transaction as the move, and every reversal restores exactly that, never a
  state inferred from the subject as it stands.
- **Work exists only at an address the index holds.** A ranking reader in the ledger reads the
  store's `live*` surfaces, views joined to `symbols`, and a residue forbids the raw readers there.
  Recall, doubt and diagnosis read raw rows on purpose, since a stranded subject must still be seen.
- **A daemon wire object strips unknown keys; never `strict`, never `passthrough`.** A client and a
  daemon are separately versioned, so a strict schema refuses a newer peer's extra field and a
  passthrough one carries it somewhere nothing validates it. Tool argument schemas are the opposite
  case and do reject the unknown, since a typo there is the caller's mistake, not a version skew.
- **A pattern digest is evidence, never an identity key.** Two declarations can be textually
  identical and carry different knowledge and citations, so a digest may support `batchExactMatch`
  and may never key a row.

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

Sibling projects to consult. Paths are wherever they are checked out; nothing here assumes a
layout.

- **nyaadot** - the framework-first role model. Read its doctrine and its `util/` primitives before
  designing a new mechanism here.
- **switchboard** - the toolchain and plugin-packaging reference, and a dogfood target: barrel
  re-exports, a Kotlin twin held by fixtures, and residue tests.
