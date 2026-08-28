# Changelog

Only releases that ask something of you. A patch that changes nothing you can observe is not here.

## 3.0.0

A protocol major, and a clean break with no migration window: reload every session, and update
any consumer pinned to the 2.x client (a 2.x client rides a 3.0 daemon forward as before; a 3.0
client refuses a 2.x install by name). Every store re-indexes once, since the store's
compatibility key moves with the major and C++ and C# symbol identities changed; recorded
answers survive as stale and heal where the facts they cite are unchanged.

A ref can now be bound to its bytes. `moduleDeclarations` answers one module's status, what one
read of the file found, the hash the index holds, the hash of the bytes that read loaded, and its
declarations, from one synchronous snapshot, so no field describes a different version than
another. `resolveChain` asks it and carries both hashes on every answer; its `none` answers say
why in a closed reason (`missing`, `binary`, `tooLarge`, `unclaimed`, `parseFailed`, `unread`,
`noMatch`), where the walk stopped and what was there to choose from, and each candidate carries
`segments`, a chain that reaches it alone. A run of segments matches a dotted name in full, an
out-of-line C++ definition resolves through the scope its id names, and `Physics::World::step` is
one symbol: C++ mints written qualifiers as descriptors and merges a definition into its
prototype; C# does the same for an explicit interface implementation and mints parameters with
the parameter descriptor. `awaitIndexed` answers a content refusal with the same reasons instead
of throwing; `indexFile` carries a closed `cause`. `DaemonError` carries a closed `cause`
(`unknownMethod`, `refusedModule`, `spawnFailed`, `connectionLost`, `daemon`). `connect` takes
`onWaiting`, fired during the spawn wait too, and a connection lost during the handshake is
reopened once like any other. A read is asked again over the reopened connection even when its
request had been sent; a write that had been sent is not repeated, since the daemon may have
applied it, and is reported as `connectionLost` with the outcome unknown. The method table says
which is which (`mutates`), and `ReadMethod` names the read set for a face that must never write.
`indexFile` also answers `fault` when the indexer itself failed on a file, distinct from a
provider outage or a parse failure, and a warmup pass that met either refuses every request until
the daemon is restarted rather than reporting the workspace covered. C++ overloads are told apart
by their canonical signature, parameter types with names and defaults dropped and integral
spellings folded plus the cv and ref qualifiers, so `f() const` and `f()` stay two symbols and
`f(unsigned)` and `f(unsigned int)` are one; same-named overloads are numbered by where they are
reported, which for a merged definition is its body.

Workspace containment: every path-valued request field is normalized to the index's own key and
refused before any read or write when it is absolute, escapes the workspace or carries a control
character; `refactorTrack("../x")` no longer snapshots a file above the root. Two names are two
modules, and a file the id grammar cannot spell is out of scope. Not a security fix: the socket is
loopback with a token and every client already runs as the user.

The client owns the bun it spawns: `bunExecutable(host, probe)` finds the running bun, or `bun` on
PATH, or `BUN_INSTALL/bin`, probes its version once per process and refuses a missing, malformed
or below-floor one by name; the daemon spawns its providers and its successor through the same
owner, `daemonCommand` answers a closed `command`, `unbuilt` or `noBunRuntime`, and
`classifyWorkspaceRoot` is exported so a consumer can learn before its first spawn that the daemon
would refuse `/` or `$HOME`. A session re-derives the lexicon install once per invocation instead
of freezing it at `connect`, so a plugin updated in place under a long-lived session spawns the
new bundle rather than the retired one. `hashContent` lives in the protocol package.

Nothing you see changes unless an answer was malformed. Every daemon method's request and response
shape now lives in one table in the protocol package, `DAEMON_METHODS`, and the daemon checks both
directions against it: a request that does not fit is refused before any handler runs, as before,
and an answer that does not fit is reported as an error naming the field, where before it was
shipped to you as a result. A project that depends on `@nyaa-lexicon/protocol` gets typed request
and response shapes for every daemon method, `RequestOf` and `ResponseOf` derived from the same
table, so a call against the daemon is checked where it is written. `docs/daemon-protocol.md`
describes the wire.

Another project can now depend on `@nyaa-lexicon/client` and reach a workspace's daemon with
`connect`, sharing the daemon the sessions there already use, or naming a store directory of its
own with `stateDir`; every daemon method is a typed call on the session it gets back. The daemon
it starts is the installed lexicon's, found through a record the MCP and the daemon write at start,
and a client a protocol major ahead of that install refuses with both versions rather than
spawning. `register_project` takes `stateDir` and `list_projects` shows it. The one change you
see: `list_project_stores`, `project_diagnostics`, `stop_project_daemon` and
`delete_project_store` take `store`, a key or a directory as the listing shows it, where they took
`key`. The daemon takes `--state-dir`, and a default store directory is now created `0700`.
`docs/client.md` is the consumer's document.

Lexicon runs on bun, and only on bun: 1.4.0 or newer on PATH is the one prerequisite, node is no
longer one. The plugin's server starts as `bun dist/main.js`, a client spawns the daemon with the
bun it runs on, and each entry point but the conformance CLI refuses any other runtime by name
rather than failing on its first import. An editor launches the language server as `bun <install>/dist/lsp.js`; a
configuration that says `node` stops working. Bun 1.4 carries `node:sqlite`, so the store is
unchanged and the whole suite now runs against it under `bun test`. The daemon's crash reports
change shape: node's report machinery is gone (bun treats its signal as a death, so a provider was
never asked for one), the daemon writes a high-water sample itself when its resident size nears
the host's memory (bun states no heap limit, so there is none to watch), `LEXICON_HEAP_SNAPSHOT=1`
writes a heap snapshot from the runtime, and `project_diagnostics` reads the collections older
daemons wrote as before (the reverse does not hold: an older `project_diagnostics` calls a
collection this daemon wrote unreadable until it updates). The bundle stamp in a daemon's lock is
a digest of the bundles' bytes,
so two hosts installing one release no longer retire each other's daemon on every connect.

## 2.2.0

XML, HTML and plain text are read, a search can be scoped to a declaration, and a daemon over a
partially indexed store no longer answers from the part it has.

### What you get

Every text file in scope that no provider claims is read as plain text: `LICENSE`, `Dockerfile`, a
`.sh`, a `.toml`, a `.csv`, and the source of a language with no provider yet. Each becomes doc
regions, one per paragraph, so `search_docs` reaches it, and no declarations, since plain text has
none. `overview` counts them on their own row and never ranks them among code. A `search_docs` hit
now names the line and column of the match inside its region, for markdown and HTML as much as for
text. The guards are the ones every file meets: a file with a NUL in its first 8 KiB is not text
and a file past 4 MB is too large, both named as failures; an ignored file never enters the scope;
a tracked secret needs a `deny` entry such as `**/*.pem` or `**/.env*` in `lexicon.json`.

XML and HTML files are indexed. Every element is a declaration, named by its `id`, `name` or `key`
attribute when it has one and by its tag otherwise, so `search_symbols("app_name")` lands on the
Android string resource and `outline_module` on a manifest reads as the manifest does. Every
attribute is a declaration beneath its element holding its value as a literal, so
`find_literals({ value: "42", key: "data-report-id" })` answers, and so does `within` on any of
them. XML text is a literal on its element; a malformed XML file reports the parser's position and
nothing else. An HTML heading is a `heading`, its prose the doc regions beneath it, searchable
through `search_docs` with the heading it sits under; `script` and `style` bodies are not read. A
value past sixteen thousand characters, an SVG path for instance, is left out with a note naming
its holder. The extensions claimed are `.xml .xsd .xsl .xslt .xhtml .svg .plist .xaml .resx
.csproj .fsproj .vbproj .props .targets .nuspec .wsdl` and `.html .htm`, which widens what a
workspace exposes: a `.plist` or a config XML holding a secret is now answerable, as a `.json` has
been since 2.0.0, and `deny` in `lexicon.json` is the way to keep one out.

`search_symbols`, `find_references`, `find_literals` and `find_comments` take `within`: a symbol id
from an earlier answer, or a declaration name. It scopes declarations to those inside it, uses to
those made from inside it, literals to those it holds, and comments to those attached under it, so
"every method in this namespace", "calls to X from inside Y" and "route strings under the routes
layer" are one question each. A named namespace scopes across every file that reopens it. A name
that could mean several declarations is refused with the candidates rather than answered for one
of them, and a scoped answer says when it stopped reading early. `find_literals` also takes `key`,
the exact name of the declaration holding the value, so "a field named `severity` whose value is
`warning`" is answerable in any language, and every literal it returns now names its holder and
the holder's kind instead of an opaque id.

The first pass of an index outlines every file, and requests were meant to wait for it. They
waited only on an empty store: any row at all was read as a completed pass, so a daemon whose
predecessor was stopped mid-scan, as a plugin update does, answered at once from the files that
had been read, and a search over a large codebase came back empty with nothing to say why. Requests
now wait, as retryable, until every discovered file has been attempted at least once. A store whose
last pass completed answers while discovery runs; a partial one waits for the files it lacks, and
the retry message counts them. A pass that fails answers a plain error naming the reason.

A symbol query that parses its own tree ahead of the background pass now waits up to a minute for
it, where it was ten seconds, and that minute bounds import resolution as well.

## 2.1.0

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

A daemon whose lock disappears under it stops. Removing a workspace's state directory by hand while
its daemon ran let the next client start a second daemon over a fresh index, while the first kept
answering from the unlinked one. A request that finds the lock gone, or naming another process, is
never answered: the daemon logs the reason, drops every connection and stops, and each client's
reconnect finds whoever serves now.

A shutdown that lands while providers are still in their handshake reaps them. The supervisor only
knew the providers that had finished registering, so a stop during startup left the rest in flight
until their handshake timed out; it now holds what it has spawned and not yet registered, and
stops that too.

`refactor_preview` answers what a rename or a move would touch before any transaction exists. A
rename preview has the files, the sites per file, and every blocker and warning, from the plan the
daemon already computed for the editor; a move preview has the removal, the insertion, the imports
re-pointed, and what the moved text depends on, by origin. Give `newName` or `toModule`. Until now
the only way to learn the blast radius was to open a transaction and do it.

`overview` tells code from data. A JSON or YAML key has been a `property` declaration since 2.0.0,
so a directory of fixtures led the largest-modules list and its keys dominated the symbol count,
with nothing on the page saying so. A provider now declares what its files are, `code`, `data` or
`document`, the store keeps that per file, and overview counts files and symbols per class, ranks
the largest code modules on their own, lists the largest data and document files under their own
heading, and says when data outweighs code and how a `deny` list in `lexicon.json` keeps fixtures
out. A store from an earlier release reports its files as unrecorded until the next scan, which a
daemon runs at start and which classes them without re-reading.

Every symbol id a provider hands the index is read once, at the boundary. A declaration's id must
name the file being parsed; a container, a reference's owner and a literal's container must be
declared in that same parse; a document anchor must be a heading there; a binding target may live
anywhere but must be an id, and every one of them must be spelled the one way `composeSymbolId`
spells it, so an attempted `%2F` slash escape or a needlessly quoted name can no longer mint a
second id for one symbol. Until now only the document anchor was checked, and each reader of the
other four re-decided what the string was allowed to be. A file whose parse breaks the rule is
refused as a parse failure naming the id, and its previous facts stand.

The Rust provider named a container for the methods of an `impl` whose type is declared in another
file, an id that named nothing in that parse; those methods now carry no container, and their
symbol ids are unchanged. Their fact digests are not, since a declaration's digest covers its
container, so an answer citing one of them reads as stale after the next read. By the release rule
that is a provider extraction change, which ships in a major.

Every provider discovers its files through one walk in the protocol package, which spells each
module the way its ids are spelled. A file whose name a symbol id cannot carry, one holding a
control character, is no longer listed; it could never have been parsed.

The conformance corpus plants comment-shaped text inside every string form its table names for a
language, beside three real comments, and fails a provider on any marker reported or real comment
missed. Every provider passes it; writing it found one hole, a C# raw string opened with four or
more quotes closed at the first three, so the rest of the file read as a comment. It closes on a
run as long as its opener now.

One id names one declaration. A name path declared twice in one file, a merged TypeScript
interface or a function redefined in Python, minted one id, and the store kept whichever came last
in silence. The id grammar gains an occurrence, `Cart[2]#`, for the second and later declarations of
a name path, counted in source order; the first keeps its bare id, so no id that never repeated
changes. The wire settles it for every provider, what sits inside a re-minted declaration follows
it, and the core refuses a parse that still carries one id twice. Declarations that used to vanish
are indexed now; a binding inside a re-minted block still names what the provider bound, which is
the first occurrence until that provider learns to count. A parameter and a type parameter carry an
occurrence too, `(x)[2]` and `[T][2]`, since a macro invocation read as a function repeats a
parameter name and the whole file was refused for it; a type parameter named by digits alone is
refused so that bracket stays unambiguous. A member defined outside its class but inside a
re-minted namespace, the C++ out-of-line form, follows the namespace too; it used to keep an owner
id the parse no longer declared, and the file was refused for that.

A C or C++ file whose preprocessor branches open a construct two different ways, `#if` one `if(`
and `#else` another, closed once after the `#endif`, used to fail whole: every branch was in the
token stream, so the delimiters never balanced. Both providers now resolve conditional groups
before parsing. Alternatives whose every branch is whole, its own brackets balanced, are all kept,
as they were, so a `#ifdef _WIN32` implementation and its `#else` are both indexed and a name
declared in both still binds as ambiguous. When a branch is a fragment, only the first is kept, or
the one after `#if 0`, since that is the comment idiom; what is in a dropped branch is not indexed,
which is stated in `docs/parsing.md`. An `#if` with no `#endif` is reported and drops nothing. The
C++ provider also splices a backslash-newline before tokenizing, as the language does, so a macro
body continued over several lines is one directive: the `struct` and functions written inside such
a body used to be declared as if they were code, and are not any more. That is an extraction change
for unchanged source, so a C++ file holding one reads as stale until its next read. A real
single-header test framework that failed on all of this indexes now.

A C++ macro invoked at file, namespace or class scope with no semicolon, `SUPPRESS_WARNING("x")`
on a line of its own, used to be declared as a function whose body was whatever brace came next,
so every declaration up to the matching close was swallowed into it. A SHOUT_CASE call not followed
by a body or a declarator is a statement now and declares nothing; one followed by `{` is still the
function-like declaration it was. The same test framework went from 629 declarations to 1670 once
those bodies let go. Extraction changes for unchanged source, so such a file reads as stale until
its next read.

A C++ declaration with `__declspec`, `__attribute__`, `alignas` or `[[...]]` used to treat the
specifier as a function-like declaration, so the actual variable or function could disappear. The
specifier is consumed now, its arguments do not become references, the declaration keeps its
source range from the first specifier, and an `extern "C"` linkage string before one is read as the
linkage it is. An `extern "C" { ... }` block is read as part of the scope around it; its closing
brace used to end the parse of the whole file, so a C header wrapped in one lost everything inside
and after it. Extraction changes for unchanged source, so such a file reads as stale until its
next read.

A C# file now resolves conditional groups by the same whole-branch rule as C and C++. Whole
alternatives stay indexed, while fragment alternatives keep the first branch or the branch after
`#if false`, and removed branches contribute no declarations, directives, comments or literals.
Newtonsoft-style feature gates have whole alternatives, so both alternatives remain in the stream.

The C provider read `extern "C" {` as the next declaration's prefix, so the body and the rest of
the header disappeared. A linkage block is transparent now, including when a C header wraps its
body in the `__cplusplus` guard. The libuv header went from 42 declarations to 1447, its 319
prototypes among them. Extraction changes for unchanged source, so the file reads as stale until
its next read.

A GDScript script with no `class_name` is a class named after its file, and it used to claim a
`selectionRange`, the span of its name, at a position where no name is written. The field is
absent now, for any declaration whose name is not in the source; a rename of one is refused as
`NameNotInSource`, a same-line comment is never anchored to it, and an editor reveals its range
instead. The store gained a flag column in place, so earlier stores keep working; a script indexed
before this release keeps its invented span until the file is next read, and its fact digest moves
then. The same rule reached TypeScript: an anonymous default export's name span is the `default`
keyword, and a declaration with no name token carries no span rather than its whole statement.

A workspace is its real path. A checkout opened through a symlink and through its target minted
two store keys, so two daemons indexed one repository and an answer recorded in one was invisible
from the other. The key, the daemon's lock and the project registry all resolve symlinks first
now; case is whatever the filesystem reports and is never folded. Only a workspace whose path
differs from its real path gets a new key, and for that workspace this release is a rebuild: the
old store directory stays behind until `delete_project_store` removes it.

A C++ header with a `.h` extension beside C++ sources is now read by the C++ provider. It previously
went to the C provider, which refused C++ in it. This is the shared-extension claim any provider
can declare.

A move target is checked as a workspace path before anything is planned. `refactor_move` took
`toModule` as given, so `../outside.ts` or an absolute path planned a write past the workspace;
the same rule `refactor_insert` already applied to a module it would create now owns both.

A search count says how sure it is. `search_symbols` printed the size of its probe as the total,
so a name matching 500 symbols read as "51 symbols"; the literal search had the same bug and was
fixed earlier, and comments, docs and imports each derived their own truncation sentences. One
owner now derives the count from how the rows were read: `exact` when the store counted, `at least
N` when the page or the scan stopped the counting, and the answer's heading and notes come from
that value. A heading reads `at least 51 symbols` where it used to read `51 symbols`.

One module reads a workspace file for indexing, with a binary guard and a size bound. The watcher
used to decode every changed file as UTF-8 to hash it, lockfiles and images included, while the
indexer read the same file again its own way; neither refused a binary or a giant, and one large
YAML file could stall every other request for minutes behind a parse that is quadratic in its keys.
Both now read through one owner: a file with a NUL in its first 8 KiB is recorded as failed with
`not text`, a file past 4 MiB with its size and the limit, and each is named in every answer's note
like any other parse failure. A residue test fails the build on a second reader.

A data file nested past a thousand brackets is refused before any parser recurses. The JSON and
YAML readers relied on catching the stack exhaustion a deep structure produces; most of the time
that is a catchable error, and the rest of the time it kills the process, which a test runner on a
busy machine met as a dead worker. The readers now count nesting first, outside strings and
comments, and report `nested too deeply to index` without recursing.

### For provider authors

**A module no symbol id can name is a request error, not a diagnostic.** The shared server refuses
an absolute path, one that escapes the workspace, or one carrying a control character before your
handler runs, and conformance asks every provider for `../escaped` to prove it. Diagnostics are for
the file's content.

**A declaration's `name` is source-form; its id is NFC.** They agree for composed source and differ
for decomposed, and this is written down rather than repaired: anything matching by name normalizes
first, and providers do not normalize names, since a changed name for unchanged source is a major.

**Conformance tells a stalled run from a failed case.** A request that times out, or a provider
process that dies, is reported as `STALL` with the machine's load and how far into the run it was,
counted apart from failures, and the CLI exits 3 rather than 1. The runner retries `initialize` once
before calling it stalled. `FAIL` means the provider was reached and what came back was wrong.

### What it asks of you

**Secret-shaped files are not filtered, on purpose.** A committed `credentials.json` or
`config/secrets.yml` is indexed like any other file and its values are answerable, as 2.0.0 said.
A blocklist of filenames was considered and refused: it never matches what a given repository
calls its secrets and would read as assurance it cannot give. The control is the one you already
use: a `.gitignore`d file is not scanned (an import that names one is still followed), and `.env`
is claimed by no provider.

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
