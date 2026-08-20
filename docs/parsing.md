# Parsing law

Every hand-written parser here follows these rules. Each earned its place by catching something. If
a parser teaches a rule this list does not have, add it and bring the existing parsers up to it,
rather than leaving the law describing code that no longer follows it.

## 1. Check for a library before writing the parser

Ask what the grammar is first. A transport, a config format or a language has a maintained
implementation, and yours will not match its decade of edge cases. This law is for the grammars
that are genuinely ours.

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
contents of string literals as prose the moment the two disagree. Emit comments from the same token
list that produces literals.

The corollary costs more than the rule: every hole in the string grammar surfaces as a false
comment. This caught four parsers here in one change, each a string form the lexer did not know it
had, including an interpolation hole holding a string of its own and a backslash-newline the
language splices inside strings as well as comments. Nothing the parser reports about itself
contradicts a false comment, because the bad span is internally consistent, so the only guard is a
case that plants a marker inside each string form the language has.
