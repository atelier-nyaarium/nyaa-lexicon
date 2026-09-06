# Questionaire

## Question 1 - Library or hand-written parser?

Q: Bash's grammar is not ours. Read it through a library, or write the cursor-token-structure parser
the parsing law describes?
A: The library. `unbash` 4.0.x (webpro-nl, TypeScript, zero dependencies, ESM with an exports map,
ISC).

> Parsing law 1: check for a library before writing the parser. A scratchpad spike against 4.0.10
> answered its three questions. Positions: 60 of 60 words sliced their own text back out, offsets in
> UTF-16 code units as the protocol pins. Shipping runtime: no UMD wrapper, no wasm, `type: module`.
> Scale: 3 MB and 91,601 lines of bash-completion in 53 ms, linear. Structure came out typed for
> pipelines, and-or lists, subshells, functions, `[[ ]]`, case, heredocs, redirects, and command
> substitution inside quotes and inside `${x:-...}`; malformed input kept a partial tree with
> positioned errors.

## Question 2 - Where does the vault's operation shape live?

Q: Switchboard's gateway approves vault operations by a shape of the command line. Does it ask the
Lexicon daemon, or parse for itself?
A: It parses for itself, on the same pinned `unbash`, in the switchboard repository.

> The gateway runs in a container without Lexicon, and an approval decision is a pure function that
> may not depend on a daemon being up. One parser in both places, pinned to one version, is how the
> provider and the gateway agree by construction.

## Question 3 - Comments

Q: `unbash` decides where a comment opens but records no span. The protocol wants comment spans from
the same lexical authority as the values. Upstream change, or a second scanner?
A: Upstream first: a `comments` array of `[pos, end)` spans on the parse result. Until it lands the
provider declares `comments: false`, which conformance skips rather than fails. The fallback, only
if upstream refuses, is a mask built from the parser's own word, quote and heredoc ranges, guarded by
the corpus string-forms case.

## Question 4 - Which files?

Q: Which files does the provider claim?
A: Extensions `.sh` and `.bash`; exact filenames `.bashrc`, `.bash_profile`, `.bash_aliases`,
`.bash_logout`, `.profile`. Not `.zsh*`: zsh is another grammar. Extensionless scripts with a bash
shebang need a claim the protocol does not have yet; see Phase 3.

## Question 5 - Version

Q: Which `unbash` version, given the seven day floor in `bunfig.toml`?
A: 4.0.10 (2026-08-09) now; 4.0.11 (2026-09-01) once it is seven days old. Exact pin, no range.

# Plan

## Phase 1 - Provider on unbash ✅

- `providers/bash/`: manifest on the GDScript pattern, `unbash` pinned, `@nyaa-lexicon/protocol`
  and `vscode-jsonrpc` as the other providers have them.
- `src/main.ts`: `initialize` with the claims of Question 4, `discoverByWalk` for the project model,
  `parseFile` from one parse, `resolveImport` for `source` and `.` with a literal path (relative to
  the file, then the workspace root), `bind` same file then sourced files, `typeOf` Known for the
  `-a`, `-A` and `-i` attributes of `declare`, `typeset` and `local` and Unknown otherwise,
  `renameEdits` and `moveEdits` refused with `NotImplemented` as C does.
- `src/extract.ts`: the walk over the unbash tree. Declarations: functions, top-level and `local`
  assignments, `declare`, `readonly`, `export`, `alias`. References: expansions as `read`,
  assignments as `write`, a command name matching a same-file or sourced function as `call`,
  `source` and `.` as `import`. Literals: quoted words, `$'...'`, numbers and heredoc bodies, each
  only when nothing in it expands, as the other providers hold a template with substitutions. Ranges
  through `coordinatesOf`. Diagnostics from `errors`, plus the unclosed heredoc unbash stays silent
  on. Tiers: projectModel, declarations, references, imports, binding, literals, syntaxDiagnostics;
  comments false until Phase 2; docs false; types true with the narrow answer above; metrics as the
  kit computes them.
- Conformance fixtures for every declared tier in `protocol/src/conformance/corpus.ts`, and bash's
  rows in `stringForms.ts` (single, double, ANSI-C, locale, quoted and unquoted heredoc).
- Tests at the repository's bar, behavior over state: a script in, the facts out.
- Build smoke and the UMD gate pass; `bun dist/grade.js` unchanged since the corpus has no bash.
- Minor release.

Shipped: `providers/bash/` on `unbash` 4.0.10, with `main.ts` answering the wire and the extraction
split by concern: `extract.ts` walks the tree and composes; `context.ts` holds the facts and the
walk record; `scope.ts` owns identity, the scope chain and settlement, with one `resolve` for the
walk and the settle; `words.ts` owns words, parts and arithmetic; `builtins.ts` owns the builtins
that write and the assignment prefix, over one option parser; `heredoc.ts` owns the here-document
scan. Scope is a chain: a function's locals nest under its own descriptor; a
subshell, each side of a pipe, a command substitution and a coproc body keep their assignments to
themselves; a read settles against the nearest enclosing local declared before it, then the file's
variable. A call at the top level reaches the definition before it and a call inside a function the
last in the file, since the body runs later. A function defined twice carries an occurrence and its
locals nest under it, so the served re-mint and the bindings agree. The declaring builtins, `read`,
`mapfile`, `readarray`, `printf -v`, `getopts`, `let`, `unset`, `alias` and `coproc` name their
variables; `declare -p` and `-f` name without declaring; `local` outside a function is bash's error;
`${Y:=d}` writes, a subscript reads its names, `$_` and `${!prefix*}` read nothing, and a nameref's
value is a read of the variable it names. A literal is a value nothing expands in: quoted words,
`$'...'`, bare numbers, unquoted assignment values and here-document bodies, `<<-` without its tabs,
never an array initializer. Sourcing binds transitively, each file read once. A CRLF file's ranges
end on line content while a value keeps the `\r` bash keeps. A subshell's assignment to a name it
inherits is a write to that name, since the copy has no identity of its own; a function defined in
a subshell is unknown outside it. The here-document body is the one place extract.ts scans source
text itself: unbash places only an expanding body, so a quoted or unclosed one is found on the line
after its redirect and its closing delimiter by a regex; both go on the Phase 2 upstream ask beside
comment spans. Conformance passes fourteen cases and fails one, `claimed-tier-is-tested/literals`,
which every provider fails because the corpus's only literals case is markup's; a corpus literal
expectation is the fix and belongs to the protocol, not this provider.

## Phase 2 - Comment spans ✅

- Upstream: a pull request to webpro-nl/unbash recording each skipped comment's `[pos, end)` on
  `ParsedScript.comments`, from the lexer's own `opensComment` decision, and placing every
  here-document body (`bodyPos`, `bodyEnd`, `closed` on `Redirect`) so the provider's own scan
  goes. Pin the release that carries it once it is seven days old.
- Provider: `comments: true`, the spans mapped through `coordinatesOf`, the corpus comment cases and
  the string-forms guard green.
- Fallback only if upstream refuses: the mask of Question 3, with the corpus as the proof it holds.

Superseded: no automated pull requests to a third-party repository. webpro-nl/unbash#10, comment
spans, was a feature the maintainer never asked for and is closed. webpro-nl/unbash#11, placing
every here-document body with `contentPos`, `contentEnd` and `heredocTerminated`, completes a
positional gap and stays open for the maintainer to judge; if it lands, the scan in `heredoc.ts`
retires on a release seven days old. Comments therefore take the fallback of Question 3: a mask
built from unbash's own word, quote and here-document ranges, guarded by the corpus string-forms
case. The rule is recorded in the owner's global instructions.

Shipped: `comments.ts` reports every `#` outside the spans the walk saw a `#` as data in, up to its
line's end, the carriage return dropped, the shebang included as the corpus asks. The walk marks
those spans as it goes, each from unbash's own word and part positions: a word without parts, a
quoted or expanded part, an arithmetic command, a `let` word, and an assignment's name and `=`; the
here-document body span comes from the scan in `heredoc.ts` until unbash places it. A command
substitution is not marked, since its own words mark themselves and a comment inside it is a
comment. `comments: true`; every corpus comment case bash can state carries a bash fixture and
passes, and the block-comment and spliced-comment cases do not apply, since bash has neither.

### Bug Classes

- Mechanism: opaque marking is opt-in per call site in the walk. Defect class: text unbash
  tokenized that no call site marks leaks its `#` as a comment. Patched three times: the assignment
  prefix (the value's substitution was hidden by marking too much), then the `for (( ))` header and
  a function's name, then the here-document delimiter line, then a builtin's name word whose
  subscript expands. Closed by `mask.test.ts`, which found that fourth one on its first run: a walk that
  knows only the tree's shape collects every span unbash tokenized as data, and no reported comment
  may start inside one, over scripts holding a hash in every hand-marked position and over the
  machine's bash-completion corpus when present. Here-document bodies and delimiter lines have no
  span in the tree, so the mask's own scan stays the authority for them.

## Phase 3 - Shebang claim ✅

- Protocol: a `shebangs` claim beside `filenames` and `sharedExtensions`: an extensionless file whose
  first line names one of the listed interpreters is claimed, ranked with a filename claim. The
  walk reads one line of each extensionless candidate; the routing rules in `provider-protocol.md`
  gain the sentence.
- Provider: `bash`, `sh`, `env bash`, `env sh`.
- Conformance: one case proving the claim and one proving an extensionless file with another
  interpreter is not taken.
- Protocol minor: a new optional field, tolerated by older providers.

Shipped: protocol 3.1.0 adds `shebangs` to the initialize answer, a list of interpreters as
`shebangInterpreter` in `protocol/src/shebang.ts` names them, `env` with its options and its
assignments looked through, so a provider lists `bash` and `sh` rather than every spelling.
Routing in `core/src/routing.ts` reads an extensionless module's first line through the
`HeadReader` the indexer hands the supervisor, from the opening bytes alone and only when some
provider claims a shebang, and ranks the claim with a filename claim. `walkWorkspace` reads the
same bytes for its own discovery. A conformance fixture may now state `discovery`, which files the project model must list
or leave out, and two `projectModel` cases use it. The Bash provider claims `bash` and `sh`.

## Phase 4 - Switchboard: the structural shape

In the switchboard repository, its own plan. Named here because Question 2 decided it.

- The gateway depends on `unbash` at the same exact pin.
- `operationShape` becomes a structural reading: every simple command in the tree, including inside
  command substitution, subshells and pipelines; wrappers peeled to the real program (`sudo`, `env`,
  `nice`, `nohup`, `time`, `command`, `exec`); each program with its first non-flag argument.
- A grant covers the set the request named. A request whose set is not a subset of the grant's
  asks again. That is the guard the owner deferred.
- `operationShape` stays the phone's display shape until the console's copy reads the same set.

## Painpoints

- The literals tier cannot be proven. `ConformanceFixtureSchema` has no literal expectation and the
  only literals case is markup's, so every provider claiming the tier fails
  `claimed-tier-is-tested/literals` and every conformance run carries a failure that has to be
  explained away. A corpus literal list, exact like `declarationNames`, is the fix (backlogged).
- `withOccurrences` re-mints a repeated declaration and leaves its bindings alone, and
  `docs/provider-protocol.md` says a provider "may" mint occurrences itself. It must, or a reference
  inside the second definition binds to the first's local after serving. Every provider that binds
  locals already keeps its own identity bookkeeping; the doc reads as optional (backlogged).
- A conformance run under load reports `STALL ... 0 passed`, which an auditor reads as a failed
  provider. The CLI's exit code says otherwise, but a summary written from the output does not.
- `exactOptionalPropertyTypes` turns every optional fact field into
  `...(x === undefined ? {} : { x })`. The extractor writes that spread in eleven places. A kit
  helper that drops undefined fields from a fact would remove the ceremony from every provider.
- unbash places only an expanding here-document body and never says whether one closed, so the
  provider carries the one scanner the parsing law forbids, dated for removal (Phase 2).
- Two repositories, two rules about one directory: switchboard forbids a `node_modules` inside
  `lexicon/`, and lexicon's own gates need it. Every lap installs it to work and removes it to run
  switchboard's gates, and a provider test run on the wrong side of that dance fails with
  `Cannot find package 'unbash'`.
- A comment-tier corpus case carries one fixture per language inline, so claiming the tier for a
  new language is ten edits scattered through `corpus.ts` rather than one file per language, and
  the shared `comments` list at the case level is only ever right for the slash-comment family.
- `indexCli` spawns the shipped bundle under `dist/`, so proving a source change end to end needs
  `bun run build --build-only` and a `git restore dist` afterwards, or the release build refuses
  the dirty tree.
- The conformance runner keeps a list of fixture fields that "earn no parse", so a new expectation
  field such as `discovery` silently earns one until the list learns it. The fixture schema and
  that list are two places for one fact.
