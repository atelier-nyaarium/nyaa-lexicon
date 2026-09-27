# Parsing law

Every in-house parser follows these rules, and every provider reading through a gold parser follows
rules 4, 12 and 13 over what that parser gives it. If a parser teaches a rule this list does not
have, add it and bring the existing parsers up to it, rather than leaving the law describing code
that does not follow it.

## 1. Gold or in-house, never a patched approximation

A provider reads a language through one of two parsers:

- **Gold:** the language's own parser, or its spec's reference implementation, where Lexicon can
  call it: in-process, or through a toolchain that language's users already have. The TypeScript
  compiler, CPython's `ast` and `tokenize`, CommonMark's micromark, `yaml`, parse5, `jsonc-parser`.
- **In-house:** a parser written here to this law, reporting exactly the facts Lexicon needs. C,
  C++, C#, Rust, GDScript and Kotlin.

A third-party approximation of a grammar is neither. Its gaps become repairs, gap lexers and text
scans around it, each a rule of this law broken on purpose. Bash's unbash and XML's parse-xml each
move to in-house.

Gold when the real parser is callable where Lexicon runs, in-house when it is not. Bash has no
parser anyone can call, so Bash is in-house.

A document format is rejected for a library when no maintained one reports source POSITIONS, since
a declaration without a range is not a declaration. Markdown, YAML and JSON are read through pinned
reference implementations, because CommonMark alone answers setext headings, tilde fences, indented
code and markers inside HTML comments, and a hand-written scanner gets each of those wrong in turn.

Choosing a gold parser takes three questions.

**Does it report positions, and are they right?** The obvious one, and the one a correctness spike
covers.

**Does it survive the SHIPPING runtime?** A package's own entry decides this, not its code.
`jsonc-parser` declares a UMD `main`, so a node-target bundler inlines the wrapper without resolving
its inner requires, and the bundle is clean and dies on launch. Read the `exports` map before
committing to a dependency; a package without one hands the choice to the bundler. The build refuses
any bundle carrying a UMD wrapper for this reason.

**How does it scale?** `yaml` parses a single mapping in time QUADRATIC in its key count: 4000 keys
in 81ms, 16000 in 1.4 seconds, 100000 in about three minutes. It is still the right library, because
nothing else reads YAML correctly, but a cost like that has to be known and written down rather than
discovered by a repository that contains one large file.

XML is read through `@rgrove/parse-xml` and HTML through `parse5`, and both answer all three.
Both put offsets on every node, parse5 on every attribute too; both bundle for node with no
UMD wrapper; and 6 MB of either parses in under half a second. Their nesting cost is the one to
know: parse-xml recurses and overflows the stack at ten thousand nested elements under node, and
parse5 survives a hundred thousand but spends thirty-five seconds on them, so each reader counts
depth from its own parser's events through `NestingGauge` in `protocol/src/depth.ts` and refuses
past the shared limit.

parse-xml keeps no attribute offsets or start-tag end, so `formats/src/xml.ts` still finds attribute
value spans with its own start-tag scan. That scan runs only on text parse-xml accepted.

Kotlin is in-house. `providers/kotlin/src/lexer.ts` reads the specification's lexical grammar
through one `SourceCursor`, and `grammar.ts` reads its syntax grammar by recursive descent. Nodes
keep tree-sitter-kotlin 1.1.0's names, fields and leaves, the vocabulary the provider's walkers
read. Where that grammar and the specification disagree, the specification decides: `f<T>(x)` and
`f<T> { }` are calls, `!x.y()` negates the call, `$name` is a template, `\uXXXX` is one escape,
annotations before a declaration belong to it, `I by d {` opens the class body, and a primary
constructor may start on the next line.

- **Line breaks** end a statement only outside `(` and `[`. The lexer drops them inside, and `{`
  makes them count again.
- **`!in` and `!is`** are one token unless a name character follows, so `!inside` negates a name.
- **Nesting** past `MAX_NESTING` levels, counted by one `NestingGauge` the lexer and the grammar
  each hold, answers one problem instead of exhausting the stack. Prefix operators are read in a
  loop and cost no depth.
- **Every problem is an `error`.** A parser that follows the specification meets one only in text
  no valid source produces, so the file is refused.

Switchboard's `android/` (569 files, 3.5 MB) takes 620 ms for the bare parse, 1.15 s for an outline
and 1.56 s for full facts. kotlinx-coroutines (1,082 files, 4.1 MB) takes 540 ms, 1.0 s and
1.31 s. Neither corpus has a problem.

## 2. One cursor owns character access

Nothing else indexes the text: no `text[i]`, no `indexOf`, no scattered `slice`. The cursor exposes
peek, next and a good flag, and tracks line, column and offset as it goes.

A structural search that bypasses the cursor is the defect this law exists to prevent. An
`indexOf(")")` picks the wrong delimiter and collapses two distinct symbols onto one id, and
nothing in the code makes it look wrong.

## 3. Three stages, collapsible only downward

    cursor -> tokens -> structure

A grammar small enough may skip the token stage, but the file must say so and say why. The cursor
stage is never skipped.

## 4. Regex is a character-class predicate, never a structural matcher

Legal: testing one character, or validating a candidate string the cursor already cut out, anchored
end to end. Illegal: a pattern that must know about nesting, balance, or the rest of the input. If
a capture group is doing structural work, the tool is wrong.

Tests obey it too. A residue sweep reads code through `protocol/src/astResidue.ts`, the TypeScript
parser's tree. A pattern, where a rule needs one, runs over one identifier's or one string's text.

## 5. Prefer a grammar that cannot need balancing

When a token could contain its own delimiter, restrict the token rather than teaching the parser to
balance it. That fails loudly at the writing end instead of silently at the reading end.

## 6. Every token carries its source position

Line, column and offset, minted where the token is read. A failure names an offset, because `null`
alone is not a diagnosis.

## 7. Every scan loop provably advances

Each iteration either consumes a character or returns. Assert it rather than reasoning about it,
since the reasoning stops being true the first time somebody adds a branch.

## 8. A reader stops at its delimiter and never consumes it

The caller consumes the separator. A reader that swallows its own delimiter leaves the cursor past
the token, so any failure reported afterwards brackets the wrong span and points one character off.

## 9. A parser must be able to put characters back

Deciding a token is complete can require reading past its end, so the cursor owns a mark and a
rewind that restores line and column as well as position. Rewinding position alone drifts both by
exactly the amount re-read.

## 10. The diagnosis is canonical; the convenient form is a shim

`parseXResult` returns the failure and `parseX` returns null. Writing the shim first is how a
parser ends up with no diagnosis at all, because nothing forces one into existence.

## 11. The inverse lives beside the parser, and round-trip is the test

Compose against parse, stringify against parse. The property to test is that one is the other's
inverse across the whole input space you accept, including the ugly parts: embedded delimiters,
quoting, unicode normalization, and the empty case.

## 12. One lexer decides both what is a string and what is a comment

A comment is defined by what is NOT a string, so a second pass that scans for markers reports the
contents of string literals as prose the moment the two disagree. Emit comments from the same
LEXICAL AUTHORITY that produces the values: the same token list where there is one, or the same
library's own parser where the values come from a tree. YAML reads values from the document and
comments from the CST, which are two entry points into one grammar and so cannot disagree; a hash
inside a quoted scalar or a block scalar stays content, which is the whole point of the rule.

Bash has no comment in unbash's tree at all, so the provider derives them from the library's own
spans: every word, part and body the tree tokenized is opaque, and a `#` outside them opens a
comment. The scan decides nothing about quoting; it looks only where the library left no token.
`providers/bash/src/__tests__/mask.test.ts` proves the marking exhaustive with a walk that knows
only the tree's shape, over the machine's bash-completion corpus, because each span the walk had
forgotten to mark leaked a false comment.

The corollary costs more than the rule: every hole in the string grammar surfaces as a false
comment. The holes to look for are an interpolation hole holding a string of its own, and a
backslash-newline the language splices inside strings as well as comments. Nothing the parser
reports about itself
contradicts a false comment, because the bad span is internally consistent, so the only guard is a
case that plants a marker inside each string form the language has.

C, C++ and C# conditional groups nest. Alternatives are kept when each branch is whole, meaning its
delimiters balance after nested groups resolve. When a branch is a fragment, the first branch is
kept, or the branch after exact `#if 0` in C and C++ or `#if false` in C#; C# spells the comment
idiom `#if false`. The other branches are removed before parsing. A group
inside a dropped branch is dropped with it. Only the conditional directive lines stay in a dropped
branch, so every other line, including `#define` and `#include`, is not indexed. An `#if` with no
`#endif` is reported and nothing in it is dropped. A stray `#elif`, `#else` or `#endif` is reported
and ignored. The C++ tokenizer deletes a backslash-newline before tokenizing, as translation phase
two does, so a directive continued over several lines is one line to the parser and a macro body
never reads as code; surviving tokens keep their physical positions.

## 13. Decide from tokens, never from the raw text around a position

A decision about a position reads the tokens or the tree around it, never the characters before or
after it. A look back through raw text finds a comment's words, a string's contents or the previous
line's end, and reads each as code.

When core needs a fact the text alone would answer only by looking around, the provider reports it
from its own tokens: whether code shares a comment's line, where a container's members end, which
`<` its parser read as a type bracket, whether a reference is qualified.

# Writing a provider

## Adding a language

Pick the tier first (rule 1). Then:

- **Package:** `providers/<language>/src/main.ts`, serving its handlers through `serveProvider` and
  `runProviderOnStdio`. Parsed state lives in a `moduleStore`; `provider-state-residue.test.ts`
  refuses state beside it.
- **Tiers:** declare only what the provider answers. A skipped tier answers NotImplemented with a
  reason.
- **Conformance:** add the language's fixtures to the shared cases in `protocol/src/conformance/`,
  including a `FORMS` entry in `stringForms.ts` with a marker inside every string form.
  `bun run protocol/src/conformance/cli.ts -- bun run providers/<language>/src/main.ts` must report
  zero FAIL.
- **Bundle:** `bun run build --build-only` rebuilds `dist/`. Core's live tests and the daemon run
  the bundle, so a stale `dist/` tests old code.

## Facts core decides from

Core reads no source text around a position. Each of these comes from the provider's own tokens or
tree.

- **Positions:** UTF-16 code units. A byte order mark is no token. Under CRLF a line ends before its
  `\r`.
- **Comments:** every comment carries `codeBefore` and `codeAfter`. Absent reads as code beside it,
  which detaches a doc comment.
- **`blankLines`:** lines no token touches, comments and literals included. The empty remainder after
  a final line break is not a line.
- **`memberInsertLine`:** on every container. Its closer's line when the closer starts it, or the
  line after an indented body's last statement. Absent when there is no safe point.
- **Headers:** `renderHeader` with `omit` for comments, `splices` for text removed outright (a line
  continuation), `verbatim` for literals, `folds` for literal containers, and `angles` for each `<`
  and `>` the parser read as a type bracket.
- **References:** `qualified` when the tree reaches the use through a member accessor. Absent reads
  as exposed to a rename.

## Mistakes this law was written after

Each shipped at least once and broke on the next edge case.

1. **A tokenizer built from regexes.** Patterns over lines or whole files to find strings, comments
   or declarations. Use one lexer on the Cursor (rules 2 and 3), or the gold parser's tokens.
2. **Reading around a position.** `text[i - 1]`, `lastIndexOf`, "the line ends with `:`", "only
   whitespace before this". Ask the neighbouring token, or report a fact (rule 13).
3. **Deciding from rendered text.** Cutting a type's display at `<`, or matching words in text
   already joined from tokens. Walk the tokens that made it.
4. **A second scanner for one question.** A comment scan, string scan or bracket counter beside the
   real lexer. They disagree on the first unusual form (rule 12).
5. **Counting every `<` as a bracket.** Classify type brackets once, and have every splitter ask it.
6. **Sweeping an edit or span list for overlap by hand.** `planEdits` and `unionOf` in
   `protocol/src/edits.ts` own it; `edit-plan-residue.test.ts` refuses a copy.
7. **Leaving a fact absent.** Emit every field the tier allows, on every row.
8. **An untested string form.** Every hole in the string grammar is a false comment. Plant a marker
   in each form.
9. **A whole-file rescan per declaration or reference.** Build one index per parse, and time the
   language's corpus.
10. **Trusting unit tests alone.** Diff every fact over a real corpus before and after, and explain
    each one that moved.
11. **Changing extraction without a major.** A new kind, name, range, binding or literal for
    unchanged source ships as a major release.
12. **Patching a library's missing positions with text scans.** That is the approximation tier.
    Move the language to gold or in-house instead.
