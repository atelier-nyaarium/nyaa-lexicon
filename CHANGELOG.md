# Changelog

Only releases that ask something of you. A patch that changes nothing you can observe is not here.

## 2.0.0

The first major. Comments become facts, and `docComment` is retired.

### What you get

`find_comments` searches what was written ABOUT the code: doctrine, rationale, warnings. Each hit
names the symbol the comment is attached to, or the module when it documents no symbol. A run of
wrapped line comments is ONE fact, and search runs over normalized text, so a sentence broken across
a line break is still one sentence.

`describe_symbol` gains a Notes section: what was written beside a symbol or inside its body, which
before this was reachable only by opening the file.

A symbol's documentation is now DERIVED from the comment attached above it rather than stored
separately, so the prose you read and the prose in the file cannot disagree.

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

**Reload every session promptly.** This major ships NO compatibility window: a 2.0 daemon does not
answer the 1.x wire. Sessions do not fight each other over it, because a client meeting a newer
daemon connects to it rather than replacing it, so you will not get two versions retiring each
other and rebuilding the index on every flip. But a session still running 1.x code cannot speak the
2.0 wire at all, so reload it rather than leaving it running.

### For provider authors

`comments` is a required tier, and `docComment` is gone from `Declaration`. Emit comment spans from
the tokenizer you already have rather than a second marker-scanning pass; a separate scanner holds
its own opinion about where strings end, and every disagreement becomes prose that is not there.
`docs/provider-protocol.md` carries the rules the conformance cases enforce.

### On future majors

A future major MAY keep answering the previous major's read shape while sessions update, and
`protocol/CLAUDE.md` sets the rules for that window: one or two versions back, never more, deleted
when the window closes, with the removal date stated in the shim. A window is a migration aid, not
a museum. This release ships without one deliberately, and says so rather than implying otherwise.
