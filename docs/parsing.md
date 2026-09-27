# Parsing law

Every in-house parser follows these rules, and every provider reading through a gold parser follows
rules 4, 12 and 13 over what that parser gives it. If a parser teaches a rule this list does not
have, add it and bring the existing parsers up to it, rather than leaving the law describing code
that does not follow it.

## 1. Gold or in-house, never a patched approximation

A provider reads a language through one of two parsers:

- **Gold:** the language's own parser, or its spec's reference implementation, packaged as a
  library Lexicon bundles and calls in-process. The TypeScript compiler, CommonMark's micromark,
  `yaml`, parse5, `jsonc-parser`.
- **In-house:** a parser written here to this law, from the language's specification, reporting
  exactly the facts Lexicon needs. C, C++, C#, Rust, GDScript, Kotlin, Bash, XML, Python and
  PowerShell.

A third-party approximation of a grammar is neither. Its gaps become repairs, gap lexers and text
scans around it, each a rule of this law broken on purpose.

Gold when the real parser ships as a library, in-house otherwise. A toolchain the user installs is
not a library: CPython's `ast` answered only through a `python3` child, at that interpreter's
version, so Python is in-house. Bash has no parser anyone can call, so Bash is in-house.

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

HTML is read through `parse5`, which answers all three: offsets on every node and attribute, a node
bundle with no UMD wrapper, and 6 MB in under half a second. Its nesting cost is the one to know: it
survives a hundred thousand nested elements but spends thirty-five seconds on them, so the reader
counts depth from parse5's events through `NestingGauge` in `protocol/src/depth.ts` and refuses past
the shared limit.

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

Bash is in-house. `providers/bash/src/syntax/` reads the grammar in the Bash reference manual's
"Shell Syntax" chapter by recursive descent. Bash lexes by context, so there is no token list ahead
of the parser: the parser asks `scanner.ts` for the next piece in the mode it stands in, and the
scanner places every character it consumes as a token. Tokens are code, comment, continuation,
here-document body and delimiter line; only blanks and line breaks fall between them.

- **Reserved words** count only where a command starts.
- **Here-document bodies** are read at the line break ending the line that opened them, in opening
  order. Inside `$(`, a line spelling the delimiter then `)` ends the body as end-of-file does, as
  bash 5.2 reads it.
- **Backquotes** are read over their text with the escapes removed. Each decoded character keeps
  its source offset, so every node and token inside lands on the source it came from.
- **`NAME=(...)x`** assigns no array. Bash reads the list and what follows as one word.
- **Here-document delimiters** decide expansion by quoting alone: `<<$END` expands its body. An
  unquoted delimiter matches after line continuations join.
- **Nesting** past `MAX_NESTING`, counted by one `NestingGauge` across commands, substitutions,
  arithmetic and `[[ ]]`, answers one error. Operator chains and prefix runs are read in a loop, each
  link a level.

The bash-completion corpus (659 files, 1.5 MB) takes 180 ms for the bare parse and 430 ms for full
facts.

XML is in-house. `formats/src/xml/parser.ts` reads XML 1.0 (Fifth Edition) through one
`SourceCursor`, open elements on a stack rather than the call stack and counted by the gauge. Every
attribute keeps its name, value and quote positions and every element its tag ends, so the reader
signs and ranges from the tree alone.

- **Non-validating.** The internal subset is read for its entity declarations. Element, attribute
  list and notation declarations are read to their `>` and not checked.
- **References** are replaced in text and attribute values. In text, an entity whose replacement
  holds markup stays as written, as does an external one, and an undeclared one when an external
  subset or parameter entity may declare it.
- **Attribute values** are normalized per section 3.3.3: each white space character reads as a
  space, a line break as one.
- **Expansion** may write a million characters plus ten times the document's length. Past that, the
  outermost reference is refused, so nested entities cannot multiply into gigabytes.
- **The first well-formedness error** ends the parse, as the specification requires.

A corpus of 3,596 files from this machine (38.6 MB) takes 1.1 s for the bare parse.

Python is in-house. `providers/python/src/syntax/` reads the reference manual's "Lexical analysis"
chapter and "Full Grammar specification": `tokenizer.ts` through one `SourceCursor`, reporting the
tokens CPython's `tokenize` reports, and `parser.ts` by recursive descent. Nodes, fields and
positions follow CPython's `ast`, with UTF-16 offsets.

- **Grammar** is the newest release's, 3.14: t-strings, type parameter defaults and unparenthesized
  `except` types parse.
- **Positions** match CPython 3.12's `ast` on every node. A block ends at its last token past
  layout, a trailing `;` included.
- **Type comments** attach where CPython's `type_comments` mode accepts them; one anywhere else is a
  comment, not an error. Their text is read in `eval` and `func_type` modes, and each name lands
  where the comment spells it. `# type: ignore` comments land in `Module.typeIgnores` with their
  tags, spanning the comment where CPython gives a line.
- **`\N{...}`** reads names and aliases from the Unicode Character Database 16.0, generated into
  `unicodeNameData.ts` by `scripts/unicodeNames.ts`.
- **Nesting** past `MAX_NESTING`, counted by one `NestingGauge` in the parser, answers one error. A
  tree deeper than the limit, as a long operator or `elif` chain builds, is refused after the parse.
  Both chains are read in loops.

`/usr/lib/python3` (4,272 files, 53 MB) takes 5.2 s for the bare parse and 13.5 s for full facts.
Every file's tree matches CPython 3.12's `ast` field by field. On 75,000 mutated files and
statements, the parser accepts and refuses what 3.12 does, the 3.13 and 3.14 additions aside.

PowerShell is in-house. PowerShell's parser is a .NET assembly, not a library Lexicon can bundle.
`providers/powershell/src/syntax/` reads the grammar as that parser does: the parser asks the
tokenizer for the next token in the mode it stands in (command, expression, type name, class
signature), and backs up to reread a stretch in another mode. Nodes take PowerShell's class names and
extents.

- **Grammar** is PowerShell 7.6's: ternaries, `??`, `?.`, pipeline chains, `clean` blocks, number
  suffixes. Workflows and DSC configurations still parse.
- **A string's `$(...)`** is read as its own scan over the string's text, doubled quotes undone.
  Each character keeps its file mark, so every token and node inside lands on its source.
- **The first syntax error** refuses the file. Semantic checks, `#Requires` validation and signature
  blocks are PowerShell's rules about meaning and metadata, not grammar, and are not applied. The
  text past the error is still read as commands, so its comments and blank lines hold.
- **Numbers** take PowerShell's types and values: hex and binary at full width read a sign bit, a
  double past its range is infinite, and a suffix's type must hold the value.
- **An empty block** spans the gap between its braces, the last character excluded, unless the
  braces touch column-wise, as PowerShell measures it. Columns follow the cursor, so a lone CR is
  content.
- **Nesting** past `MAX_NESTING`, counted by one `NestingGauge` in the parser, answers one error. A
  tree deeper than the limit, as a long operator chain builds, is refused after the parse.

A corpus of 1,854 files (16 MB: Windows modules, Pester, PSScriptAnalyzer, PowerShell's own tests,
ImportExcel, posh-git, PowerShellEditorServices) takes 2.9 s for the bare parse and 6.6 s for full
facts. pwsh 7.6.6's trees match node for node, type and extent, on every file it accepts; Windows
PowerShell 5.1's match on all but 7.x syntax. On 60,000 mutated files, the parser refuses what
7.6.6's parser refuses. On 5,840 generated number literals, types and values match 7.6.6's.

## 2. One cursor owns character access

Nothing else indexes the text: no `text[i]`, no `indexOf`, no scattered `slice`. The one cursor is
protocol's `SourceCursor`, for source files and machine-written ids alike. It exposes peek, next and
a good flag, and tracks line, column and offset as it goes, in the positions `coordinatesOf` gives.
A token's text read again comes from `textOf`, which answers only for text already passed; a
failure's context comes from `failure`. A parser keeps the source private to its cursor, so a stray
slice does not compile.

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

Bash's comments are tokens from the scanner that reads its words. Over the machine's
bash-completion corpus, `providers/bash/src/__tests__/mask.test.ts` proves that tokens leave only
blanks and line breaks uncovered, that every node spans its own text, and that no comment starts
inside a word.

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
