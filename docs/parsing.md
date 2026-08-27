# Parsing law

Every hand-written parser here follows these rules. Each earned its place by catching something. If
a parser teaches a rule this list does not have, add it and bring the existing parsers up to it,
rather than leaving the law describing code that no longer follows it.

## 1. Check for a library before writing the parser

Ask what the grammar is first. A transport, a config format or a language has a maintained
implementation, and yours will not match its decade of edge cases. This law is for the grammars
that are genuinely ours.

The document formats obey this rule rather than the rest of this law: markdown, YAML and JSON are
read through pinned libraries, because CommonMark alone answers setext headings, tilde fences,
indented code and markers inside HTML comments, and a hand-written scanner gets each of those wrong
in turn. A format is only rejected for a library when no maintained one reports source POSITIONS,
since a declaration without a range is not a declaration.

Choosing one takes three questions, and the spike that picked these answered only the first.

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

XML is read through `@rgrove/parse-xml` and HTML through `parse5`, and their spike answered all
three. Both put offsets on every node, parse5 on every attribute too; both bundle for node with no
UMD wrapper; and 6 MB of either parses in under half a second. Their nesting cost is the one to
know: parse-xml recurses and overflows the stack at ten thousand nested elements under node, and
parse5 survives a hundred thousand but spends thirty-five seconds on them, so `markupTooDeep` in
`formats/src/depth.ts` counts tag depth before either runs and refuses past the shared limit.

## 2. One cursor owns character access

Nothing else indexes the text: no `text[i]`, no `indexOf`, no scattered `slice`. The cursor exposes
peek, next and a good flag, and tracks line, column and offset as it goes.

A structural search that bypasses the cursor is the defect this law exists to prevent. The first
bug found in this repo's own id parser was an `indexOf(")")` picking the wrong delimiter, which
collapsed two distinct symbols onto one id, and nothing in the code made it look wrong.

## 3. Three stages, collapsible only downward

    cursor -> tokens -> structure

A grammar small enough may skip the token stage, but the file must say so and say why. The cursor
stage is never skipped.

## 4. Regex is a character-class predicate, never a structural matcher

Legal: testing one character, or validating a candidate string the cursor already cut out, anchored
end to end. Illegal: a pattern that must know about nesting, balance, or the rest of the input. If
a capture group is doing structural work, the tool is wrong.

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

The corollary costs more than the rule: every hole in the string grammar surfaces as a false
comment. This caught four parsers here in one change, each a string form the lexer did not know it
had, including an interpolation hole holding a string of its own and a backslash-newline the
language splices inside strings as well as comments. Nothing the parser reports about itself
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
