# Changelog

Only releases that ask something of you. A patch that changes nothing you can observe is not here.

## 2.0.2

`knowledge_gaps` answers for one file, and a parse failure is named where it matters.

### What you get

Every answer's note used to say `1 file failed to parse` and nothing more: not which file, not why,
not what to do. It now names the failed files with the provider's reason, up to three, points at
`overview` for the rest, and says what to do: fix what the reason names and save. A changed file is
re-read at once; an unchanged one is retried by the next scan, which a daemon runs when it starts
over a stored index and otherwise on its first request. An answer about a symbol or file that IS
one of the failures leads with that, so a declaration missing from a file that did not parse is not
mistaken for one that does not exist. A failure recorded against content the index already holds
at final depth is dropped once that content is found current, where before the count kept it.

A provider's warnings and info reach you. They are reported so one odd file cannot stop a scan, and
until now core kept only `error` and dropped the rest at the door, so a provider saying "this key
exists and I could not index it" was indistinguishable from one that found nothing. They are kept
beside the file's facts as notes: `outline_module` lists them for that file with the line, and
`overview` counts the files that carry any. A note is what was read and why, never a verdict.

A commented `.json` is read. `tsconfig.json`, `jsconfig.json`, `.vscode/*.json` and
`devcontainer.json` carry comments under an extension that names the strict dialect, and refusing
them put every one of those files outside the index with `InvalidCommentToken` as the only trace.
Every JSON dialect is now read leniently, the keys and values are answered, the comments are comment
facts, and the file gets one `info` note per kind saying what was read that the strict dialect lacks.
`.jsonc` gets no note: it is its own dialect. Files that parsed before produce the same facts.

A search cannot take the daemon down. A regex such as `/(a+)+b/` in `find_comments` used to hang the
process on a sixty-letter comment, with every other request queued behind it, because patterns ran
on the JavaScript engine, which backtracks. They run on RE2 now, which is linear in the text, so no
pattern stalls. A search term holding a NUL used to match everything, since SQLite reads a pattern
up to the first one; it is refused with the reason. A term past two thousand characters is refused
with the limit, instead of surfacing SQLite's own error.

A shutdown that lands while providers are still in their handshake reaps them. The supervisor only
knew the providers that had finished registering, so a stop during startup left the rest in flight
until their handshake timed out; it now holds what it has spawned and not yet registered, and
stops that too.

### What it asks of you

**Regex search is RE2 syntax.** Lookahead, lookbehind and backreferences are refused at compile,
with a message that says so. The flags that change a match, `i`, `m` and `s`, apply; `g`, `u` and
`y` are accepted and change nothing. Where RE2 reads a spelling differently from JavaScript: `\d`,
`\w` and `\b` are ASCII, `$` does not match before a final newline, `\u{...}` is refused, and
`\p{L}` works without a `u` flag. Alternation, classes, quantifiers, anchors and groups are the same.

**This adds no rebuild, and files read before this release show their notes after their next read.**
The notes table is added to your store in place. A file indexed before it existed has no notes
row, and rather than reading as clean, `outline_module` says its notes are unknown and `overview`
counts such files. Editing the file, or any scan that re-reads it, clears that.

Pass `module` alone and the answer is that file's own declarations without a healthy answer,
stale and doubted ones first and then the missing by how used they are, whether or not anyone has
asked about them yet. Before this, `module` only said which
`name` you meant, and alone it was dropped: the call answered the whole workspace's question
instead, with nothing but a header word to show it. The three scopes are now stated in the tool's
description, and every answer names its scope in its first words: `Workspace-wide`, `In <file>`,
or `Under <symbol>, leaves first`. A file the index does not hold says so rather than reading as
clean.

## 2.0.1

The daemon records its own memory, and a process that dies of it leaves a report.

### What you get

`diagnostics.json` beside each workspace's index, under the state directory: a bounded ring of
samples (the daemon's heap, every provider's resident size and peak, what the daemon was doing), a
ring of incidents (a provider death with its signal and last size), and a peak per process. It is
rewritten whole, through a temporary file and a rename, and never grows. Every node process the
daemon starts has node's diagnostic report turned on, so a heap death leaves a JSON in `reports/`
with the stack and the heap spaces at the moment, pruned to the newest eight. A provider nearing
the limit is asked for the same report while still alive. `LEXICON_HEAP_SNAPSHOT=1` adds a full
heap snapshot near the limit, gigabytes each, kept to the newest two.

`project_diagnostics` reads all of it back for a store key: peaks against the heap limit,
incidents newest first with what the daemon was doing, the sampled range, each node report's
trigger and heap, and each snapshot's size. From disk, with no daemon needed, because the daemon
is the thing that died.

### What it asks of you

**A report holds your process's command line, working directory and JS stack.** It holds every
environment variable too on node older than 22.13, which cannot leave them out; on 22.13 and newer
they are excluded, and `host.reportsExcludeEnv` in the collection says which you got. `reports/`
is created readable by you alone. Deleting a project store deletes its diagnostics and reports
with it.

**A request racing a provider's death no longer takes the daemon down.** It used to, through an
unhandled rejection inside `vscode-jsonrpc`; it now rejects typed. If you have seen a daemon stop
with `unhandled rejection: ... EPIPE` in `daemon.log`, that was this.

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
the reach is.

If that matters to you, the answer is the one you probably already use: in a git repository the scan
takes its file list from git, so a `.gitignore`d file is never read. `.env` is not claimed by any
provider either way. What IS indexed is a config file you have committed, which is worth a look if
you have ever committed one with a real value in it.

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
