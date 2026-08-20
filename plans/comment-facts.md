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

## Phase 2 - Providers (workflow fan-out, one agent per provider)

Emit raw comment spans from the lexer and declare the comments tier, PRESERVING declaration
ranges. Inventory accepted-wrong extraction assertions for the major train. Conformance green per
provider.

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

## Phase 3 - Core

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

## Phase 5 - Verification

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


