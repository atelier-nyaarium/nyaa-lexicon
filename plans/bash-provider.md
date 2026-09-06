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

## Phase 1 - Provider on unbash

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

## Phase 2 - Comment spans

- Upstream: a pull request to webpro-nl/unbash recording each skipped comment's `[pos, end)` on
  `ParsedScript.comments`, from the lexer's own `opensComment` decision, and placing every
  here-document body (`bodyPos`, `bodyEnd`, `closed` on `Redirect`) so the provider's own scan
  goes. Pin the release that carries it once it is seven days old.
- Provider: `comments: true`, the spans mapped through `coordinatesOf`, the corpus comment cases and
  the string-forms guard green.
- Fallback only if upstream refuses: the mask of Question 3, with the corpus as the proof it holds.

## Phase 3 - Shebang claim

- Protocol: a `shebangs` claim beside `filenames` and `sharedExtensions`: an extensionless file whose
  first line names one of the listed interpreters is claimed, ranked with a filename claim. The
  walk reads one line of each extensionless candidate; the routing rules in `provider-protocol.md`
  gain the sentence.
- Provider: `bash`, `sh`, `env bash`, `env sh`.
- Conformance: one case proving the claim and one proving an extensionless file with another
  interpreter is not taken.
- Protocol minor: a new optional field, tolerated by older providers.

## Phase 4 - Switchboard: the structural shape

In the switchboard repository, its own plan. Named here because Question 2 decided it.

- The gateway depends on `unbash` at the same exact pin.
- `operationShape` becomes a structural reading: every simple command in the tree, including inside
  command substitution, subshells and pipelines; wrappers peeled to the real program (`sudo`, `env`,
  `nice`, `nohup`, `time`, `command`, `exec`); each program with its first non-flag argument.
- A grant covers the set the request named. A request whose set is not a subset of the grant's
  asks again. That is the guard the owner deferred.
- `operationShape` stays the phone's display shape until the console's copy reads the same set.
