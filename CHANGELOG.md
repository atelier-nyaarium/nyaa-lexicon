# Changelog

Only releases that ask something of you. A patch that changes nothing you can observe is not here.

## 2.0.0

The first major. Comments become facts, documents become searchable, and `docComment` is retired.

### What you get

`find_comments` searches what was written ABOUT the code: doctrine, rationale, warnings. Each hit
names the symbol the comment is attached to, or the module when it documents no symbol. A run of
wrapped line comments is ONE fact, and search runs over normalized text, so a sentence broken across
a line break is still one sentence.

`describe_symbol` gains a Notes section: what was written beside a symbol or inside its body, which
before this was reachable only by opening the file.

A symbol's documentation is now DERIVED from the comment attached above it rather than stored
separately, so the prose you read and the prose in the file cannot disagree.

`search_docs` searches the prose in your documents. A hit answers with the HEADING PATH it sits
under, `CLAUDE.md > Principles` rather than a line number, and says when the match came from a fenced
code block. This exists because half a project's doctrine usually lives in markdown, where no code
search could reach it.

A heading is a DECLARATION of the new `heading` kind, so it has a symbol id, a range covering its
whole section, and its parent heading as its container. `describe_symbol` on one shows its prose and
its child headings; `outline_module` on a document answers its table of contents, nested.

Eleven languages, up from eight in `1.14.0`. The three added here are markdown, the JSON family and
YAML, each read through a pinned library rather than a hand-written scanner. In JSON and YAML a key
is a declaration and its value is a literal, so a configuration setting is reachable by the tiers
that already existed.

### What it asks of you

**Your index rebuilds on first use.** The schema and the wire both moved. Nothing is lost that was
derived from source, and it costs one indexing pass.

**Recorded answers survive the rebuild, but EVERY citation of a declaration goes stale.** Answers
are the one thing not derivable from source, so they are salvaged and restored. Their citations are
a different matter: a declaration's fact id is a digest over everything that declaration is, and
retiring `docComment` removed a field from that tuple. Removing a field changes the digest even
where the field was absent, so this is not limited to documented symbols. Every stored answer that
cites a declaration will read as stale until `reaffirm_answer` re-points it at the current facts.
The prose is untouched; only the evidence needs re-citing.

**Your coverage numbers move, and not because your code changed.** `.md`, `.mdc`, `.markdown`,
`.json`, `.jsonc`, `.jsonl`, `.ndjson`, `.yml` and `.yaml` were previously claimed by no provider and
reported as unclaimed. They are indexed now, so both the file count and the unclaimed count shift on
your first scan. `.json5` is deliberately NOT claimed: the JSON parser reads comments and trailing
commas but not unquoted keys or single quotes, and claiming the extension would report facts for
files it half-understands.

**Your configuration files are now searchable content.** This follows from the line above, and it is
worth saying plainly rather than leaving you to infer it. A `credentials.json` or a `config/secrets.yml`
in your workspace is indexed like any other file, and `find_literals` will answer with its values. A
secret hardcoded in source has always been reachable this way, so the KIND of exposure is not new, but
the reach is. `.env` is not claimed and stays invisible.

**Reload every session promptly.** This major ships NO compatibility window: a 2.0 daemon does not
answer the 1.x wire. Sessions do not fight each other over it, because a client meeting a newer
daemon connects to it rather than replacing it, so you will not get two versions retiring each
other and rebuilding the index on every flip. But a session still running 1.x code cannot speak the
2.0 wire at all, so reload it rather than leaving it running.

### For provider authors

`comments` is a required tier, and `docComment` is gone from `Declaration`. Emit comment spans from
the same lexical authority that produces your values, never a second marker-scanning pass; a separate
scanner holds its own opinion about where strings end, and every disagreement becomes prose that is
not there. `docs/provider-protocol.md` carries the rules the conformance cases enforce.

There is a `docs` tier and a `heading` declaration kind. Declaring `docs` is for providers whose files
carry PROSE under headings; a comment in YAML is a comment, and belongs to the comment tier.

**Conformance now FAILS a tier you claim that it never asked you about.** A case with no fixture for
your language is skipped, so a provider could declare a tier, be asked nothing, and report a clean
run. A tier the corpus has no cases for at all is reported rather than failed, since that is the
corpus's gap and every provider shares it.

### On future majors

A future major MAY keep answering the previous major's read shape while sessions update, and
`protocol/CLAUDE.md` sets the rules for that window: one or two versions back, never more, deleted
when the window closes, with the removal date stated in the shim. A window is a migration aid, not
a museum. This release ships without one deliberately, and says so rather than implying otherwise.
