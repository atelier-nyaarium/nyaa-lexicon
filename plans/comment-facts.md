# Questionaire

## Question 0 - Attachment taxonomy (settled in chat, pre-questionaire)

Q: What attachment shapes must comment facts capture?
A: Four forms covering the owner's five cases: leading (above a declaration, including nested
inside parameter lists), trailing (same line, after code), inline (embedded mid-signature,
anchored to the nearest same-line symbol, placement recorded), standalone (no symbols around;
anchors to enclosing container, or module for headers, licenses, banners).

> "it should also detect inline comment or above comment or standalone comment. Symbols
> above/below, left of, on the same line etc." ... "a block comment that stands alone with no
> symbols around"

## Question 1 - Who computes attachment?

Q: Providers or core?
A: A - providers emit raw comment spans + text only (behind a `comments` tier); CORE computes
form + anchor + placement with one position-math resolver over stored declaration ranges.

> "sounds good. A"

Recommendation reason (chosen): every rule in the five cases is position math; eight provider
implementations of one idea is the drift class the comparator sweep just deleted; docstring
refinements can join later without changing the fact shape.

## Question 2 - What text does find_comments search over?

Q: Raw bytes, normalized, or both?
A: A - raw text stored verbatim AS the fact; a normalized column (markers, gutters, decoration
stripped, whitespace collapsed) is what search runs over. Display and citations show raw.

> "probably A? since comment: // ... foo / // bar ... would be split on the text wrap. So
> normalize allows 'foo bar' to match that."

COROLLARY the owner's example fixes: a run of adjacent line comments is ONE logical comment fact
spanning the run, grouped by core before attachment (same indent, consecutive lines, no code
between). Normalization joins the run's lines, so a phrase split across the wrap matches.

## Question 3 - Guess or refuse on ambiguous anchors?

Q: A comment with blank lines both sides, between two declarations: nearest-neighbor guess,
refuse to standalone, or standalone with recorded candidates?
A: A - standalone, anchored to the enclosing container, never guessing a symbol. Candidates can
be ADDED to the fact shape later without retiring anything; a guessed wrong anchor would be baked
into stored facts and citations from day one.

## Question 4 - Where do comment facts surface in v1?

Q: Search tool only, plus describe, or plus knowledge citations?
A: B - find_comments plus a describe_symbol attached-comments section (trailing and inline shown;
leading docs suppressed there since docComment already prints them). Knowledge citations (C) are
the immediate follow-up release, built on dogfooded attachment quality.

## Question 5 - The docComment overlap

Q: Unify now (major), leave as debt for the next major, or two homes forever?
A: A - unify NOW and pay the major. docComment becomes derived-at-read from the leading-attached
comment fact; providers stop extracting it; the field leaves the Declaration schema.

> "A. major"

## Question 6 - Knowledge retirement at the major [Superseded by verified reality]

Q: Accept the answers-table loss, build salvage now, or accept-and-backlog for the next major?
A: A was chosen on a WRONG premise of mine. The lap-2 audit corrected it: salvageKnowledge
already exists in the store rebuild path (store.ts:569-585) and deliberately restores answers
across every rebuild - "ANSWERS are written by people and models and are the one thing here that
cannot be regenerated." Knowledge SURVIVES this major by existing machinery, zero new work.
What this major does change: documented declarations' factIds re-mint (docComment leaves the
tuple), so salvaged answers citing them read STALE and reaffirm_answer repairs them - the
designed staleness flow. The owner's "don't care" is satisfied in the good direction.

> "A. Don't care, only user is me, and we never exercised the notes layer."

Rider Q&A: does an answer go stale when a comment above its symbol changes? Today yes,
indirectly: the declaration factId hashes docComment, so a doc edit re-mints the id and every
answer citing it reads STALE. After this release, precisely: comment facts carry their own ids
(range + raw hash), so an answer citing the COMMENT stales exactly when that comment changes or
moves, while an answer citing only the declaration stops staling on comment edits. Citation
granularity decides sensitivity - strictly better precision than today.

## Question 7 - The protocol-major transition war

Q: Accept bidirectional replacement thrash at protocol majors, ship the ordered-protocol rule, or
build dual-protocol serving?
A: B - accept THIS transition (shipped v1 clients are immutable; reload ends it), and ship the
ordered-protocol rule inside this major so future majors have no war.

> "B."

## Question 8 - A compat and migration window?

Q: No window, a one-major read-model window with connect-to-newer, or a dual surface?
A: B, with two owner refinements: (1) a scoped CLAUDE.md rule lands in the API folder stating the
window is NOT permanent back-compat history - it serves the last 1 or 2 versions only during
their update window, and old API surfaces are DELETED afterwards to avoid multi-versioning
pains. (2) THIS release ships clean, no compat machinery: existing clients do not carry the
window code yet, so the owner accepts the break for their sessions. The window policy and the
connect-to-newer rule exist FOR the future - majors or even minors.

> "No back compat for this release. We ship comment stuff clean. Version migration is for the
> future of majors or even minors."

# Plan (final after two audit laps: five lenses, then three)

Ships as PROTOCOL 2.0.0 plus package major. Release posture, all decided and audit-corrected:
- CLEAN BREAK this release, no compat machinery (Q8). Existing 1.x clients retire 2.0 daemons on
  sight (immutable shipped behavior); the transition loop costs two store rebuilds plus two warm
  scans per cycle (measured this session: a rebuild-and-warm is seconds on this repo, ~5s on a
  900-file workspace) and ends when sessions reload. Accepted with that stated cost; release
  notes say "reload every session promptly".
- KNOWLEDGE SURVIVES (Q6 superseded): salvageKnowledge already restores answers across rebuilds.
  Documented declarations' factIds re-mint, so salvaged citations read STALE and reaffirm
  repairs them. Release notes say that instead of the earlier retirement claim.
- FOR FUTURE MAJORS, shipped now, client-side only: the connect-to-newer-protocol rule in
  decideFromLock (a client meeting a NEWER protocol-major daemon rides it instead of retiring
  it; OLDER still replaces; the existing both-ways test flips direction). Inert until 3.0
  exists; the daemon-side window serving is 3.0's work, per the windowed-compat policy landing
  as protocol/CLAUDE.md: the window serves the last 1-2 versions during their update window
  only, old surfaces are DELETED after, never permanent warehousing.
- Major-train sweep rides in Phase 2: each provider agent inventories accepted-wrong assertions
  and TODO-shaped extraction debt.

## Phase 1 - Protocol ✅

- ProviderTiersSchema gains `comments: z.boolean()`; FileFactsSchema gains
  `comments: z.array(CommentSpanSchema).optional()`; CommentSpanSchema is `{ range, text }` -
  raw text verbatim, no factId (core mints ids).
- FACT_KINDS and FactKind gain "comment"; comment factId = composeFactId("comment", module,
  [raw text, range fields]). Parser accepts the new kind; grammar tests updated. CORRECTED at
  implementation time: the plan called for pre-hashing the text, but composeFactId already
  length-prefixes every field and sha256s the whole tuple, so a second hash would be a second
  spelling of one idea for no gain.
- DeclarationSchema drops docComment, and the declaration factId tuple drops it in the same
  change. MOVED TO PHASE 3 at implementation time: removing the field while providers still emit
  it and core still reads it breaks the build between phases, and "buildable at every step" is a
  house rule. The removal lands with its consumers repointed, in one commit.
- PROTOCOL_VERSION moves to 2.0.0 in protocol/src/version.ts, and the release step asserts it.
  CORRECTED at implementation time: the assertion runs the sound way round. "Every major bumps
  the protocol" fires falsely on an extraction-correction major, which retires facts without
  touching the wire, and a check that cries wolf gets bypassed. checkProtocolRelease instead
  refuses a MOVED protocol major shipped as anything but a major, compared against HEAD.
- Conformance: a comments checker with ZERO-EXTRA assertions; fixtures = the owner's five cases
  positive plus adversarial negatives (markers inside string literals, shebang lines,
  unterminated blocks, nested blocks). Compatibility tests: 2.0 rejects 1.x wire; additive
  within 2.x passes.
- GREW during Phase 2's audit laps, since the protocol is where a provider defect gets held for
  every language at once. `checkFacts` now also verifies that EVERY reported span's range slices
  its own text back out of the source, expected or not. Six more shared cases landed, each one
  written to fail before its fix: CRLF line endings, backslash-newline splicing in a comment and
  again in a string, comment columns in UTF-16 code units, a marker inside a nested interpolation,
  and a comment inside an interpolation hole. The reference provider gained comment lexing and its
  own line-ending tests, because the yardstick has to be right for the grades to mean anything.
- lockFile: ordered protocol rule + flipped-direction tests. protocol/CLAUDE.md written.

### Bug Classes

MECHANISM: the conformance corpus's shared-expectation model, patched in two consecutive audit
rounds. CLASS: an expectation stated once for every language, over a value that IS language
syntax. Round 1 (align) patched multiplicity, when a set comparison could not tell two identical
comments apart. Round 2 (red team) found the real shape: `//` expectations applied to `#`
fixtures, so every correct Python and GDScript provider would have failed. STRUCTURAL FIX landed
rather than deferred: comment expectations moved onto the FIXTURE, mirroring the existing
per-fixture declarations override, which makes the class inexpressible because the expectation
now lives where the syntax does. Nothing carried to architecture-fan-out.

## Phase 2 - Providers (workflow fan-out, one agent per provider) ✅

Emit raw comment spans from the lexer and declare the comments tier, PRESERVING declaration
ranges. Inventory accepted-wrong extraction assertions for the major train. Conformance green per
provider.

SHIPPED: all eight emit from their own tokenizer, never a second marker scanner. Gate clean, 1503
tests, all eight providers at 0 conformance failures. Five defects were found and fixed across the
audit laps (c's CRLF, cpp's comment splicing, cpp's string splicing, csharp's interpolation holes,
typescript's reduced-depth claim), each one first reproduced as a shared case that went red.
Four provider corpus tests now range-check ~86,000 comment spans from real repositories on every
run. The architecture lap concluded with NO structural change: see `### Bug Classes` below for the
refutation, which is the substantive output of that lap.

RESEQUENCED at implementation time: docComment DELETION moves to Phase 3, joining the schema
removal already moved there. Deleting production here would leave describe showing no
documentation until Phase 3 derives it, so every commit in between would ship a regression.
Phase 2 is therefore purely additive, and Phase 3 removes the old path in the same commit that
lights the new one. The producer inventory the audit built is carried there:
c parser.ts ~549-553, cpp parser.ts ~330-348, python extract.py ~768-782,
typescript extract.ts ~76-90, csharp parser.ts 737-764/841/967/1010/1105/1296/1356/1413,
gdscript line-syntax.ts 38-54 + declarations.ts 416, kotlin parser.ts 377/622/1439,
rust parser.ts 546-584. (Line numbers moved when spans were added; Phase 3 should re-locate by
`grep -n docComment`.)

### Extraction debt inventoried for the major train

Reported by the provider agents while emitting spans. All ride this major or are noted as
deliberate.

RIDING THIS MAJOR (extraction output changed for unchanged source, which is what a major is for):
- kotlin: a non-raw double-quoted string now scans its `${...}` template, changing literal VALUES
  at 62 sites across two real corpora. NOT optional: the old lexing ended the string at the first
  quote inside a template and reported the remainder as a COMMENT, which is precisely the
  false-positive class the suite exists to catch.
- rust: `/**/` was classified as a doc opener, consumed its closing star, and ran to EOF swallowing
  the rest of the file. Fixed while emitting.

FOUND, NOT FIXED (declaration-tier work, out of this feature's scope):
- kotlin: a primary-constructor `override val name` is read as parameter `override` and the real
  property is lost. Confirmed against real code in kotlinx-coroutines.
- kotlin: an unterminated line string swallows the rest of the file.
- rust: `////` reads as an outer doc comment; `/***/` still misclassified; multi-line block doc
  comments never attach to their declaration; a space char literal is lost.
- typescript: negative numeric literals extract as their positive digits, so a numeric range query
  cannot find them; BigInt literals produce no literal at all; interpolated template head text is
  never a literal.
- csharp: shebang is directive trivia, not comment trivia, so C# will not report one.

### Align lap: what the four-lens audit actually found

Two real defects, one wrong test, and one lens correct about a symptom but wrong about its cause.
The fixes went to the SUITE where a per-provider test would have been the obvious move, because
eight hand-written tests drift and one shared case cannot.

- **C carried the CRLF carriage return into comment text**, alone among the eight, so the same
  comment minted a different fact id depending on the checkout's line endings. Its ranges did not
  resolve against the file either, which no expectation would have caught.
- **C++ did not splice backslash-newline** in a line comment though C did and the rule is the
  language's, so it reported a second comment the language does not have and left the continuation
  looking like code.
- **TypeScript omitted `comments` at reduced depth and shipped a test asserting the omission.**
  Absent means the tier is FALSE, which contradicts its own `comments: true`; the `literals: []`
  and `references: []` beside it are the convention, and `depth` is what carries "a full pass is
  owed". Behavior and test both corrected.
- **C# `isTrivia`/`parseScope` changes were flagged as drift and are not.** The lexer had been
  classifying preprocessor directives as COMMENTS. Emitting spans forced that lie into the open,
  so directives became their own kind, and the two edits preserve prior behavior under the
  corrected kind rather than changing it.

Two shared cases now hold the line for every provider and every future language:
`a-carriage-return-ends-a-line-comment-and-is-not-its-text` and
`a-spliced-line-comment-is-one-comment`. Both were proven failable by reverting the fix. The
CRLF case independently caught the same bug in the suite's own reference provider, which is the
evidence that it is a natural mistake rather than one provider's slip.

`checkFacts` also now verifies EVERY reported span's range slices its own text back out of the
source, expected or not. Right text under a lying range attaches to the wrong symbol, and Phase 3
does position math on exactly these ranges.

REJECTED as overcautious: "tests call the extractor rather than parseFile" (each provider has a
wire-level test, and lexer edge cases belong at the lexer); "these tests pass if emission is
reverted" (they are negative cases, which is what a negative case does).

NOTED, not fixed here: rust's thrown-parse fallback returns `comments: []` like every other tier
on that path. It is the pre-existing "a total parse failure is indistinguishable from an empty
file" class, already backlogged against the TS provider, not something spans introduced.

The pre-commit pass then caught a bug in the CRLF fix itself: the reference provider stripped a
LONE trailing carriage return, which terminates nothing and is comment text everywhere else. Only
a CR paired with the newline ends the line. The reference provider is the yardstick the graded
cases are measured against, so it now has its own line-ending tests.

`source` on `checkFacts` stays optional deliberately. Its sixteen unit tests build synthetic spans
to exercise the text multiset, and a real source would fail them all on ranges they are not about.
The range check has its own four tests instead, each proven failable.

### Red team lap: two more false positives, and a large negative result

Six lenses attacked the claim rather than checking it, four of them by RUNNING providers over real
code instead of reading them. The negative result is the substantive part: roughly 34,000 spans
from real files across five languages (typescript 3,539, python 13,545, c 5,061, cpp 3,277,
csharp 8,783) with ZERO range mismatches, zero invalid markers and zero silent drops, plus no
break from astral characters, BOM, combining marks, empty files, 10,000-line files, mixed line
endings, or 100-deep nesting.

Three real defects, all the same class the tier exists to prevent, all now shared cases:

- **C++ ended a string at a backslash-newline**, so a marker on the continuation line became a
  comment. Splicing happens before tokenizing, so a string can legally hold a marker on a LATER
  line. C already handled this because its escape reader eats the newline; C++ bailed explicitly.
- **C# never tracked interpolation holes at all.** It noted the `$` prefix and discarded it, so
  `$"a // {"b"} d"` ended at the quote inside the hole and the rest of the line was read as source.
- **C# therefore also lost comments INSIDE a hole**, which Kotlin already reports. A hole is code,
  so its prose is prose. C# now scans holes, nesting braces and strings, and reports what it finds.

The C# fix changes an interpolated string's literal VALUE (`"value {Name}"` becomes `"value "`),
which is the same change Kotlin already made on this train and rides the same major: a hole is
code, and what it renders to is not knowable here.

REJECTED after checking against the code: `/*/` reported as one unterminated comment running to
EOF is CORRECT, not a bug. Two more, a 5MB comment returning nothing from typescript and timing
out gdscript, did NOT reproduce at the provider layer - typescript's extractor returns one
5,242,882-character span in 27ms, and gdscript's scan is linear (1MB in 87ms). Both were artifacts
of the agents' own JSON-RPC harnesses. C and C++ ignoring `depth` is real but not a lie: they do
full work and correctly omit the `depth` marker, so the answer is complete rather than mislabelled.

### Bug Classes

**Mechanism:** eight independent hand-written lexers, each of which must get "what is a string"
right before it can get "what is a comment" right.

**Class: an incomplete string grammar becomes a false comment.** A comment is defined by what is
NOT a string, so every hole in a language's string rules surfaces as prose that is not there. This
phase patched it FOUR times, in four different providers:

1. kotlin - a non-raw string ended at the first quote inside a `${...}` template, and the
   remainder was reported as a comment.
2. rust - `/**/` was read as a doc opener, consumed its own closer, and ran to EOF.
3. cpp - a string ended at a backslash-newline, so a marker on the continuation line was prose.
4. csharp - interpolation holes were never tracked, so a quote inside one ended the string.

Four rounds in one mechanism is a design signal, not luck. Worth stating plainly: the comment tier
did not CREATE these. Each was already mis-lexing strings, which silently produced a wrong literal
nobody checked. Emitting comments turned a quiet wrong value into a loud wrong claim, which is why
four of them fell out in one phase. That is the tier earning its keep, and also the argument that
more remain in the languages nobody attacked this round.

**Class: parallel lexers that must agree and have no test forcing them to.** c and cpp are near
twins, and cpp was missing backslash-newline splicing in BOTH its comment reader and its string
reader while c had both. Two instances, one cause: nothing compared them.

**What would eliminate them: nothing available here, and that answer is load-bearing.** Five
shapes were assessed independently. All five came back "better-tested, not inexpressible",
INCLUDING the one recommended here first, which is why the recommendation is now withdrawn rather
than merely qualified.

- **Declare each language's string-form inventory on the contract and derive a case per (language,
  form).** Withdrawn. The contract cannot prove its own omissions are honest: a provider that
  simply does not declare `interpolated` never generates the case that would catch it, and nothing
  detects the omission. The enum is leaky too, mixing delimiters, embedded grammar, preprocessing
  and prefixes, whose real combinations (verbatim plus interpolated, raw plus prefixed) either
  explode or go unspecified.
- **One dense marker gauntlet per language.** A test pattern, not a framework. Nothing requires it
  to be thorough and nothing detects a lazy one.
- **A structural invariant over the provider's own output.** Refuted concretely. Comment/literal
  non-overlap does not fire on ANY of the four bugs: in each, the string ends EARLY, so the false
  comment sits after the literal rather than inside it. Token tiling does not fire either, because
  a lexer that labels every byte a comment tiles perfectly. Deriving both tiers from one token list
  is worth doing for ownership, but the bug is already IN that list.
- **Differential testing against an external tokenizer.** The only shape that tests the real
  property, and the environment cannot support it: no rustc and no Kotlin toolchain, and grammars
  reachable only through a sibling checkout that CI would not have. Each adapter also becomes a
  second hand-written interpretation layer that can suppress the very disagreement it exists to
  find.

**The finding worth keeping.** A false comment violates a property that is external to the
provider's own answers: the span must sit where the LANGUAGE's lexical grammar has a comment opener
active, rather than inside a string, a char literal, or an interpolation hole. Nothing derivable
from the provider's own arrays can see that, which is exactly why the range check over ~86,000
corpus spans is blind to it and why both red-team bugs sailed through. Any future attempt has to
bring an outside opinion about the grammar, or it is theatre.

**Ranked follow-up, deliberately NOT in this plan:** a planted-marker generator. It plants unique
markers inside every string form a language has and in real comments, then reuses the exact-multiset
check already in `check.ts`. Because the generator knows where it planted, it is an oracle without
needing an external one, which is what makes it cheaper than differential testing and sharper than
a hand-authored gauntlet. It stays out of this train because it is test-only value against a
PROTOCOL 2.0.0 that is already shipping, and because the six cases plus the corpus gate cover the
known instances. The residual risk is accepted and named: forms nobody has attacked yet are
untested, in all eight languages.

## Phase 3 - Core ✅

SHIPPED. Two owner modules: `commentText` normalizes, `commentAttach` decides form and anchor.
Attachment runs in the INDEXER rather than the store, because the source text is the only thing
that can answer "is there a blank line between these two" and the indexer is the last place holding
it. The store stays persistence.

Verified against real repositories rather than fixtures, which is what proved the two-disjunct
leading rule actually covers both range conventions:

Final numbers, after the grouping and annotation fixes that the audit laps below produced:

| corpus | language | comments | leading | trailing | inline | anchored |
|---|---|---|---|---|---|---|
| kotlinx-coroutines | kotlin | 7045 | 2699 | 238 | 7 | 6866 |
| libuv | c | 4990 | 655 | 93 | 19 | 4312 |
| newtonsoft-json | csharp | 4683 | 2104 | 22 | 0 | 3660 |
| ripgrep | rust | 2666 | 1925 | 3 | 0 | 2292 |
| nyaa-lexicon | typescript | 2351 | 1235 | 0 | 0 | 1617 |
| requests | python | 635 | 54 | 14 | 0 | 528 |

Both conventions produce leading attachments in volume, which is the evidence the rule needed:
c, typescript and csharp INCLUDE the doc in the declaration's range (first disjunct fires),
while rust, kotlin and python EXCLUDE it (second disjunct fires, read from the source text).

Zero trailing in this repo and in ripgrep-scale numbers elsewhere is not a defect: the house rule
here puts comments on their own line, and trailing appears immediately in corpora that write them.

The convention table is no longer prose. A shared conformance case, `a-doc-comment-and-its-
declaration-relate-one-of-two-ways`, asserts that a declaration's range either covers its doc
comment or begins on the line after it. Measured by temporarily accepting only the first half, the
suite reported exactly the split the plan predicted: INCLUDE for c, typescript and csharp; EXCLUDE
for cpp, python, gdscript, rust and kotlin. Neither answer is corrected. A THIRD answer now fails
the suite, which is the point: it would lose every doc comment in that language while every
existing check stayed green.

The runner's parse predicate was also DERIVED rather than hand-listed while adding that case. The
Phase 1 painpoint recorded that a new expectation kind costs five edits and that missing two of
them makes cases pass while asserting nothing; this case would have been the third instance, so
the list became one array that every expectation kind joins by existing.

### Red team lap: the grouping rule was wrong past two lines

The find that mattered: **a run of three or more line comments broke into pairs.** After the first
merge the group spans two lines, and the merge test asked the GROUP whether it was still one line,
so the third line could never join. Two-line runs merged, which is exactly why every test written
by hand passed: all of them used two. Ten thousand comment lines produced five thousand facts.

That one bug also explains the wrong-anchor reports from a separate lens, which described a
"multi-line displacement pattern" in 44 of 81 sampled C++ comments. It was fragments, not anchors.

Fixed by holding the run's own state (`indent` and `lastLine`) apart from the range that grows as
lines join. Real corpora consolidated on the spot: this repo went 2588 comment facts to 2347, and
kotlinx-coroutines 7353 to 7045, with `leading` rising slightly because runs that used to end as a
straggler now reach their declaration.

Also fixed:
- A single-line BLOCK comment merged into a line-comment run, contradicting the rule written
  directly above the function. `isBlockComment` now lives in the normalizer, which is where marker
  shapes are already owned.
- `describe` derived documentation for every MEMBER, one query each, for prose that members do not
  render. N+1 queries for text nothing prints.
- `////` stripped as `///` and left a slash standing where a word should be.
- MCP's describe printed the FIRST LINE of a doc comment, which was a cap until normalization
  removed every line break; it then printed whole multi-paragraph comments to a caller paying per
  token. Now cut at the first sentence, with an honest marker when cut mid-sentence.

REJECTED after checking: an ASCII-art box losing its borders and a doc bullet losing its asterisk
both lose DECORATION and no words, which is what the normalizer is for and what search needs.
JSDoc `@returns` now appearing in normalized text is a real difference from the retired field, and
is kept: describe cuts at the first sentence anyway, and a search for a tag should find it.
`LIKE '%text%'` cannot use an index, which is true and is the same contract literals already have.
Tab-versus-spaces indent not merging is defensible: they are different columns.

### The decorator gap, found by re-auditing after the grouping fix

Re-running the two lenses that had found real things paid for itself. With fragments gone, a fresh
sample of 47 real comments found 14 genuinely wrong, and the cause was one rule: an annotation
between a doc comment and its declaration was treated as a wall.

`@Suppress("FunctionName")` sits between `MainScope`'s KDoc and `MainScope` in kotlinx-coroutines,
and Kotlin's declaration range does not cover it, so the doc went standalone. The same shape is
`#[derive(...)]` in Rust, `@decorator` in Python, an attribute in C#, a macro line in C. The plan
listed "decorator gaps" as a required fixture and the implementation only handled the sub-case
where the range starts AT the decorator.

The rule is now language-neutral: a BLANK line still breaks the bond, because that is the reader's
own paragraph break and Q3 settled that a fenced comment names neither neighbour. A line with
something written on it does not break it, unless another declaration starts there, because then
that declaration has already claimed the gap. An annotation, attribute, macro or modifier is none
of those things.

Recovered documentation, measured:

| corpus | leading before | leading after |
|---|---|---|
| kotlinx-coroutines | 1803 | 2699 |
| ripgrep | 1399 | 1925 |
| libuv | 526 | 655 |

### Bug Classes

**Mechanism:** the attachment rules in `commentAttach`, every one of which is a statement about a
RELATIONSHIP between several things: a run of N comment lines, a comment and the scopes nested
around it, a mix of comment kinds, and a gap with something in it.

**Class: a fixture built at the minimal arity cannot tell "handles the pair" from "handles the
rule".** Patched three times in this phase, each time by someone else's input rather than by the
tests:

1. A comment inside a scope was read as documentation for the declaration AFTER that scope closed.
   Every fixture written by hand was flat, top level, no nesting.
2. A run of three or more line comments split into pairs. Every fixture written by hand used
   exactly two lines, which is the one length that cannot distinguish the two behaviours.
3. A single-line block comment joined a line-comment run, contradicting the rule written directly
   above the function. No fixture ever mixed comment kinds.
4. An annotation between a doc comment and its declaration broke the bond, losing the doc of every
   decorated symbol. Every gap fixture was empty or blank; none had anything WRITTEN in it.

Four rounds, one cause: the tests demonstrated each rule at its smallest instance and stopped.
Two is not a run, one scope is not nesting, one kind is not a mix, and an empty gap is not a gap. The corpus runs caught none
of them either, because a fragment and a whole comment both look like a plausible fact from the
outside; only a human reading the file, or an agent told to go break it, could see the difference.

**Assessed, and one shape LANDED.** Five shapes were weighed. Unlike the provider string-grammar
class, this one is pure position math over inputs core fully controls, and that difference turned
out to be real: one shape eliminates mechanisms rather than merely testing them.

**Shipped: partition the runs before merging any of them.** Membership in a run is now decided by
reading each comment's OWN span, in a pass that completes before a single group exists. The old
shape grew a group and then asked that same growing group whether it was still one line, so the
answer changed underneath the question. There is now no merged range in scope to ask, which makes
the pair-splitting bug inexpressible rather than caught, and a typed `joinable` decides block
versus line once, which does the same for the mixed-kind bug. Two of the four are gone as
mechanisms. Corpus output is byte-identical across three languages, so this bought structure
rather than behaviour.

**Not shipped, and why:**

- **Universal invariants** are the weakest option and the assessment is worth keeping: of six
  candidates (every span in exactly one fact, disjoint ordered ranges, raw equals its slice, fact
  count bounded, determinism, anchored-within-or-above), NONE would have failed on any of the four
  bugs. Fragments are individually well-formed, source-backed, ordered and deterministic. That is
  precisely why they survived every corpus run.
- **A committed corpus statistics baseline** would have caught all four numerically, since every
  one moved the totals. But it only ever says "something moved, go look", and a compensating error
  keeps the counts while moving comments to the wrong symbols. Worth having as a tripwire, never as
  the oracle.
- **A self-oracle layout generator** is weaker than it first appears. Its oracle is only sound for
  layouts whose right answer is unique, and several natural layouts have no true answer, only this
  project's policy: a comment between two declarations with no blank line is the plain example.
  Worse, if the generator derives expectations from the same position math, it reproduces the bug
  faithfully at scale. This also qualifies the planted-marker generator backlogged for the provider
  class: that one IS a sound oracle, because it plants the marker and therefore knows, while this
  one would have to decide intent it cannot observe.

The refactor was then handed to a hostile pass, which found no behavioural differential on any
valid input across five attack points: shape metadata taken from first and last member, the
single-versus-merged raw paths, non-joinable comments chaining, empty and duplicate and unordered
input, and out-of-range starts. Its one finding is a span ending past the end of its own line,
where the whole run now degrades to singletons rather than keeping a merged valid prefix. Both
answers are arbitrary for a provider lying about its own file, and the singleton path is the one
that never fabricates text: raw is either the provider's own span text or an exact source slice,
never a join of the two. Conformance now fails any provider whose span does not slice back, so the
input cannot ship in the first place.

**Ranked follow-up, backlogged rather than built:** seeded mutation checks. Four permanent mutants,
one per shipped defect (read the growing range, drop the scope check, let blocks join runs, treat
every written gap line as a wall), with the suite required to fail each. It is the only proposal
that tests the TESTS, which is the actual failure here: each of the four was proven failable by
hand at the moment of its fix, and a hand proof decays the moment the code moves.

## Phase 3 - Core (as planned)

- Attachment runs AT INDEX TIME inside the replaceFile flow, with the module's source text in
  hand (coordinatesOf over it) - this is what makes the adjacency checks decidable: "nothing
  between" is read from the text, not inferred from stored endpoints.
- Range-convention table, recorded and pinned by a per-provider test: ranges INCLUDE leading
  docs in c, typescript, csharp; EXCLUDE them in cpp, python, gdscript, rust, kotlin. The
  two-disjunct leading rule covers both: comment.start == decl.range.start (include-convention),
  or comment block adjacent above decl.range.start with only blank/comment lines between
  (exclude-convention, verified against the source text).
- Grouping: adjacent same-indent line-comment runs, no code between, one logical fact (the
  owner's wrap example is the fixture).
- Forms: leading; trailing/inline (same line, nearest symbol, left wins, placement recorded);
  body comments = standalone anchored to the enclosing declaration; ties and blank-isolated
  comments = standalone to container, module at top level - never a guess.
- Fixtures: decorator gaps, GDScript indentation boundaries, CRLF, block comments opened after
  code, Python tail comments (documented limitation: they anchor to the parent scope).
- Normalizer: one owner module; markers, gutters, decoration stripped, whitespace collapsed;
  unrecognized shapes pass through unstripped.
- Store: comments join FACT_TABLES with full replaceFile/forgetFile lifecycle (anchors are
  rewritten by reindex, never migrated - invariant with a test); raw + normalized columns, form,
  anchorId NULLABLE (module-level anchors have no symbol), placement, range; SCHEMA_VERSION
  bump; search is the literals contract (LIKE substring, bounded JS-regex scan with
  scanIncomplete). docComment column and StoredDeclaration field removed; describe derives doc
  text from the leading-attached fact; indexReads, MCP render, and LSP hover (server.ts ~200)
  repointed.
- The PROVIDER-side docComment producers are deleted here too, in the same commit, not in Phase 2.
  Phase 2 was resequenced to be purely additive precisely so this deletion lands with the code that
  replaces it; splitting them would ship a release where describe shows no documentation at all.
  All eight producers, relocated by `grep -rn docComment providers/`, plus the schema field itself.
  The declaration RANGE conventions stay untouched: Phase 3 reads them, it does not change them.

## Phase 4 - Surface

- Daemon method `findComments`: request { text?, regex? (XOR, compileSearchRegex validation and
  flags), form?, module? (exact path), limit? (default 50, max 200) }; response { query echo,
  comments: [{ factId, module, range, form, placement, raw (first 8 lines, then "... k more
  lines"), anchor: { symbolId, name, signature, line } | null }], total (matches seen in the
  scan), truncated, scanIncomplete }; ordered by module then range start.
- Wiring named as deliverables: dispatch case, ToolBackend member, projectTools registration,
  render, no-journal-independent (read tool), endToEnd/tools/server test updates.
- describe_symbol gains the attached-comments section: trailing, inline, body-standalone;
  leading suppressed (derived doc prints). Tool descriptions carry the index-coverage honesty
  line (unclaimed files and comment-tier-less providers are invisible; rg wins for exhaustive
  byte audits).

## Phase 4 - Surface ✅

SHIPPED. `findComments` through every layer: read model, service, daemon dispatch, MCP tool with
its renderer, and the Notes section on describe. Gate clean, all eight providers green.

The literals search contract, deliberately: text or regex but never both, a bounded regex scan that
declares `scanIncomplete`, a page that never reports its own cap as a total, and a preview capped
by lines AND width.

### What the audit laps changed

**Two counts were lying.** The substring path fetched `limit + 1` rows and reported that probe as
`total`, so a search with 1523 matches said 51. It now runs a real `COUNT(*)` through the same
WHERE builder as the page, which is what makes a count and its page unable to disagree. Verified on
this repo: a search for "the" reports 1523 with 50 shown.

**An empty search never said it had stopped early.** The renderer returned "No comment matched"
from an early return that sat above the `scanIncomplete` check, so a regex scan that read 20,000
rows, gave up, and matched nothing reported a clean absence. Two lenses found it independently.
`renderLiterals` had the identical bug, copied from it, and both are fixed: the sentence a stopped
scan owes its caller is needed MOST where it was easiest to drop.

Also fixed: the XOR of text and regex moved into the read model so no entry point can skip it;
limits are rounded and NaN-guarded rather than reaching SQLite as a type it refuses; ordering
includes the column, since two comments can share a line; the Notes section is capped at ten with
the remainder reported; and the preview bounds width, because a minified file's whole comment is
one line of tens of thousands of characters.

### The honest verdict on whether it beats ripgrep

Tried against this repository, on real questions:

- **"residue test"** returns whole merged explanations, each naming the symbol or module it is
  attached to. Ripgrep returns matching LINES from the middle of wrapped paragraphs, so this is
  plainly better: the fact is the whole thought, not the line the word landed on.
- **"band-aid"** returns NOTHING, and the doctrine is real: it lives in CLAUDE.md. Markdown is not
  claimed by any provider, so half this project's doctrine is invisible to a comment search. The
  tool description's coverage line covers it, but the practical shape is worth stating plainly:
  for a codebase whose rules live in prose files, ripgrep still wins.
- A natural-language question matches nothing, because this is substring and regex search rather
  than retrieval. That is what it says it is, and worth remembering before reaching for it.

### Known and accepted

A caller-supplied regex with catastrophic backtracking (`/(a+)+$/`) can hang on a long comment.
JavaScript's engine backtracks where ripgrep's automaton does not, `find_literals` has carried the
same exposure since it shipped, and the caller is a local agent searching its own repository. Named
here rather than half-mitigated with a silent length cap that would turn a hang into a wrong answer.

REJECTED after checking: `anchor: null` on a module-level comment is the designed answer, not a
gap. Q3 settled that nothing guesses a symbol, and the tool description says so.

### Bug Classes

**Mechanism:** the paged search result. `page` for literals and `pageComments` for comments are two
hand-written implementations of one idea, each producing `total`, `truncated` and `scanIncomplete`
from a capped read, plus two renderers writing the "here is what I cut" sentences separately.

**Class: a bound applied, and the report about it written by hand somewhere else.** Four instances
this phase, and the telling part is that TWO of them were inherited by copying the literals path
rather than invented:

1. `total` was the probe size (`limit + 1`) reported as a count, so 1523 matches read as 51.
   Literals has the same bug today.
2. The empty-result early return sat ABOVE the `scanIncomplete` check, so a search that read 20,000
   rows and gave up reported a clean absence. Literals had the same bug; both fixed.
3. The preview capped lines and said nothing about width, so one minified line passed the cap.
4. The limit itself was clamped but not rounded, so a fractional one reached SQLite as a datatype
   error where a clamp belonged.

Every one is the same shape: something was bounded, and the sentence describing the bound was
written independently of the bounding. Where the two are written apart, they drift apart.

**Assessed. The live bug was fixed; the refactor was deliberately NOT built.**

`find_literals` carried instance 1 in shipped code: exact-value and numeric-range searches fetched
`limit + 1` and reported that probe as `total`, so forty matches read as six. That is a wrong
answer users get today, every assessment called leaving it unacceptable, and it is now fixed with a
real `COUNT` on both paths plus regression tests. `incompleteNote` already owns the incomplete-scan
sentence for both tiers.

The larger refactor is backlogged, and the reason is worth keeping because it corrected two of the
three assessments. Both argued the change should "ride PROTOCOL 2.0.0 as a clean break". It cannot:
`LiteralsResult` and `findLiterals` appear NOWHERE in `protocol/`, verified by grep. They are core
and adapters, not the provider wire, so the major gives no free pass and the blast radius is real
and enumerable. The deciding argument was sequencing: a cross-tier seam introduced immediately
before the verification and release phases arrives at release untested, while Phase 5 already
carries all eight providers, grade checks, live hunts and a blind-corpus pass.

The shape, for whoever picks it up: a count whose certainty is part of the value, in the same
spirit as this project's Unknown-with-a-reason, PLUS one primitive owning its construction. All
three assessments agreed the union alone eliminates nothing, since `{ kind: "exact", count:
probeSize }` stays type-valid; it becomes structural only when one primitive derives certainty from
the read strategy, and only if it takes typed evidence rather than an optional `trueTotal` an
absent argument would silently default.

## Phase 5 - Verification ✅

- Gate: biome ok, tsc ok. 1568 tests.
- Conformance from the shipped bundle, all eight providers, 0 failures.
- `grade.js` against the switchboard checkout: 8 of 8 PASS. Extraction changed in this train, so
  this was mandatory rather than optional, and it says no known answer moved.
- The four caller hunts against this repo all answered. The banner hunt is the one worth keeping:
  the regex `/^Functions & Helpers$/` matches only because normalization stripped the `////` rule
  line AND the markers, leaving exactly that string. Without the normalizer it could not match.

### The blind corpus, which is what the feature was for

evie-bot indexed: 827 files, 51,324 symbols, 2,208 comments, 1,637 anchored. No file opened, no
grep, only lexicon's own output.

A regex sweep for retry and backoff taught the shape of its operation runner. Then one `describe`
on `runOperation` returned seven body comments that between them state:

- every fresh caller MUST claim through `tryClaimPendingOperation`, and the comment NAMES all five
  (button dispatch, auto-shutdown timers, the bridge, createServer, the retry handler), with
  arriving unclaimed rejected loudly rather than silently minting a claim that bypassed the funnel;
- a race guard for two dispatches in one tick, "a timer firing the same tick as a button click";
- why a stale pending placeholder must be released, or the slot sticks with buttons greyed and no
  retry path until the bot restarts;
- why a non-retryable failure skips the sixty-second retry.

That is the invariant, its enforcement, its race, and its failure modes, for a codebase never
opened. Before this tier, `describe` would have returned the JSDoc and NONE of those seven, because
they are body comments and the old `docComment` field could not see them. The blind test asks
whether it can teach you a codebase you have never read; on this evidence, yes, and the comments
are what did the teaching.

## Phase 5 - Verification (as planned)

Unit gate, conformance across all eight providers, grade.js (extraction changed - mandatory),
live dogfood of the four caller hunts against this repo (refuses-over-clamping line, TODO/FIXME
sweep, doctrine-sentence ownership, core/ banners), blind-corpus pass on evie-bot.

## Phase 6 - Release

bun run build major with the protocol-version assertion. Release notes: stores rebuild (knowledge
survives, citations of documented declarations go stale and reaffirm repairs), the clean-break
transition ("reload every session promptly", thrash cost stated), the docComment unification,
the future windowed-compat policy. Follow-up release (not this one): comment factIds citable by
record_answer.

## Painpoints

Recorded, not fixed. Both were felt building Phase 1.

**A new expectation kind costs five edits, and missing two of them fails SILENTLY.** Adding
`comments` to the conformance suite meant touching the case schema, the fixture schema, the
checker, the runner's `parses` predicate, and the runner's check guard. I edited the first three,
and the two runner sites are the ones that decide whether a case RUNS AT ALL. Missing them made
all six new cases pass while asserting nothing, and no audit lens caught it: the suite reported
green, the cases reported PASS, and only reading the runner during crust collection found it. The
same shape is already there for `typeOf` and `parseErrors`, each hand-wired into the same
predicate. The fix is for a case to declare what it needs parsed, or for the predicate to be
derived from the expectation fields present, so a new kind cannot be half-registered. Until then,
anyone adding an expectation kind must grep `parses` in `ConformanceRunner` first.

**A required tier is an N-file edit with no default.** Adding one boolean to `ProviderTiers`
broke nine declaration sites and three test fixtures before it type-checked. That is correct for
honesty (a provider must state its own coverage), but the cost lands entirely on whoever adds the
tier, and nothing tells them where the sites are except the compiler, one file at a time. A
generated "every provider's tiers" table, or a test asserting the set of declaration sites, would
turn the compiler's scavenger hunt into one list.

Felt building Phase 2.

**The gate fails on formatting that the formatter would fix, and says only "lint FAILED: biome".**
Four times this phase the gate went red purely because my own edits were unformatted, never because
anything was wrong. Each one costs a full lint, a `lint:fix`, and another lint to confirm, and the
summary output buries the two format lines under twenty-seven pre-existing warnings. CLAUDE.md
already warns to read both halves of the gate, but the real friction is different: the half that
fails most is the half a script fixes. Running `lint:fix` before `lint` unconditionally would make
the gate mean "your code is wrong" again.

**Nothing lets you run one conformance case.** `cli.ts` takes only the provider command and calls
`loadCorpus()` whole, so checking whether one case passes across eight languages means eight full
suites and a grep, at roughly thirty seconds each. Every fix this phase was verified that way. A
`--case <id>` filter is a few lines against `RunOptions.cases` and would have paid for itself
several times over in this phase alone.

**CLAUDE.md sent me through `dist/` for conformance for no reason** - fixed while writing this,
since a doc that misleads is the misalignment class this project hunts. The run instructions listed
`node dist/conformance.js` under the heading "Bun has no node:sqlite, so anything touching the store
cannot run under bun run", but conformance never touches the store. It runs from source under bun
with identical results and no build. I rebuilt about eight times before reading `cli.ts` and finding
its own header documenting the source form.

**The four provider corpus tests are four different shapes.** Adding the same range check to c,
cpp, csharp and rust meant reading four unrelated structures: csharp has a dedicated `corpus.test.ts`,
cpp buries its corpus test at the bottom of `provider.test.ts`, c buries its at the bottom of a
much longer `provider.test.ts` behind a two-root loop, and rust has its own file with a different
skip idiom. Same test, four spellings, no shared helper. This is the c/cpp twin problem wearing
test clothes, and a shared `checkCommentRanges(provider, files)` helper would collapse it.

**No supported way to drive one provider ad hoc.** Two red-team findings claimed a provider broke
on a large input, and disproving both meant writing my own probe, because every agent that wants to
call `parseFile` once has to hand-roll a vscode-jsonrpc handshake. Two of them got that harness
wrong and reported the harness's failure as the provider's. A tiny `parse-with.js <provider> <file>`
alongside `index-workspace.js` would make that class of finding self-checking.

Felt building Phase 3.

**The corpus tests skip silently, against this project's own stated doctrine.** Every provider
corpus test is `existsSync(root) ? it : it.skip`, so a checkout without `temp/` runs the whole suite
green with zero corpus coverage. The residue-test rule in CLAUDE.md says the opposite in as many
words: "every sweep also asserts it FOUND files to check, so a run matching nothing fails instead of
quietly reporting clean". The corpus tests are the same shape and do not follow it. They are now
the only thing verifying ~86,000 comment spans, so the silence is louder than it used to be. The
honest fix is a single test asserting that AT LEAST ONE corpus was present, failing when none were,
so the skips stay per-corpus but total absence cannot pass.

**`replaceFile` takes eight positional parameters, five of them defaulting to an empty array.**
Adding `comments` meant appending after `depth`, so a caller that wants comments writes
`replaceFile(module, hash, declarations, [], [], [], "full", comments)`. Four adjacent array
arguments of different meaning, positionally distinguished, with nothing to catch a swap: passing
imports where literals go is silent at compile time and at runtime. It is the single write path by
design, which is right, but the signature has outgrown positional arguments and wants an options
object for everything after the module and hash.

Felt building Phase 4.

**Adding one query tool costs eleven edits across eight files.** The extensibility question is
"what does the next thing cost", and the answer here is: a `ToolBackend` member, an input schema, a
description constant, a handler, a renderer, an import line and a registration in `projectTools`, a
daemon request schema and a dispatch case, a core barrel export, and the same method again in BOTH
backends in `mcp/main.ts` (one daemon-backed, one in-process). Then three test fixtures, plus the
explicit tool-name list in the server test. Nothing about that is wrong individually, and the
type checker catches most omissions, but a query tool is the canonical new thing here and it is not
one registration. A registry entry carrying its own schema, handler and renderer, with the backend
method derived, would make the next one cheap.

The one omission the compiler could NOT catch was the tool-name list in `server.test.ts`, and that
test is the reason it was caught at all. Worth keeping in mind as the pattern for anything else
that enumerates tools by hand.

**The `--comments` flag I added to `index-workspace` is a shape I would not accept from someone
else.** It occupies the positional symbol-name slot and is matched by string equality, because the
CLI has no argument parser and I did not want to add one mid-phase. It earned its keep immediately
(it is how the whole tier was verified against real repositories), which is exactly why it will now
stay. A three-line flag parse would make the next verification affordance additive rather than
another positional special case.

**`index-workspace` throws its index away and nothing says so.** It opens `:memory:`, which is the
right choice for a one-shot tool, but the file header describes it as "index a workspace and answer
one question about it" with no hint the store does not persist. I wrote a probe against the on-disk
store, found no comments table, and briefly believed the feature had not landed at all. The header
should say it, and while it is being touched, the daemon's own store should be introspectable:
after a SCHEMA_VERSION bump the RUNNING plugin daemon still serves the old schema and there is no
way to ask which one it is holding.


