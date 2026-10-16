import { JOURNAL_DDL } from "./journalSchema.js";
import { RELATION_TABLES } from "./relationRows.js";
import { KNOWLEDGE_SCHEMA } from "./subjects.js";

/** Added in place, so IF NOT EXISTS. */
const NOTES_TABLE = `
-- A provider's warnings and info for a file, replaced with its facts.
CREATE TABLE IF NOT EXISTS notes (
  module    TEXT NOT NULL,
  ordinal   INTEGER NOT NULL,
  severity  TEXT NOT NULL CHECK (severity IN ('warning', 'info')),
  message   TEXT NOT NULL,
  path      TEXT,
  startLine INTEGER,
  startChar INTEGER,
  endLine   INTEGER,
  endChar   INTEGER,
  PRIMARY KEY (module, ordinal)
);
CREATE INDEX IF NOT EXISTS notes_module ON notes(module);
`;

// Every range is stored whole. Keeping only a start meant the index could say where something was
// and never what text it occupied, which is the difference between navigating and editing.
const SCHEMA = `
-- Facts about the index itself rather than about any file. Free-form because the alternative is a
-- schema bump for every new thing worth remembering, and these are all short strings.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE files (
  module      TEXT PRIMARY KEY,
  runtime     TEXT CHECK (runtime IN ('esm', 'cjs')),
  contentHash TEXT NOT NULL,
  policyStamp TEXT,
  -- How the row's bytes were admitted when it was written; NULL is plain, as is a row from before it was kept.
  admittedAs  TEXT,
  indexedAt   INTEGER NOT NULL,
  -- Outline rows require a full parse.
  depth       TEXT NOT NULL DEFAULT 'full',
  -- What the owning provider declared its files are; NULL on a row written before that was kept.
  content     TEXT,
  -- Provider id, or NULL when absent.
  provider    TEXT,
  -- Git's word: 'yes', 'no' or 'unknown' with its reason; NULL on a row written without asking.
  generated        TEXT,
  generatedReason  TEXT,
  -- library, entry, or unknown; NULL when no role was reported.
  role             TEXT,
  roleHow          TEXT,
  roleSymbolId     TEXT,
  roleReason       TEXT,
  -- Digest of what other modules can bind to; NULL on a row written before it was kept.
  surface          TEXT,
  -- 1 when the parse carried export facts; 0 is unknown coverage.
  exportsKnown     INTEGER NOT NULL DEFAULT 0,
  -- The star-export list as JSON; NULL when the language has none.
  allList          TEXT
);
CREATE INDEX files_indexed_at ON files(indexedAt);
CREATE INDEX files_depth ON files(depth);
CREATE INDEX files_role ON files(role);

-- Parse failures persist until a successful parse or file removal.
CREATE TABLE parse_failures (
	module      TEXT PRIMARY KEY,
	reason      TEXT NOT NULL,
	failedAt    INTEGER NOT NULL,
	policyStamp TEXT,
	admittedAs  TEXT
);
${NOTES_TABLE}
-- What a write moved of a module's surface, until the road that wrote it has made durable the
-- dependents it owes. Written with the facts, so a daemon stopping first leaves the question here.
CREATE TABLE surface_moves (
  module    TEXT PRIMARY KEY,
  -- JSON arrays: names gained, names lost, modules bound into what the module held.
  gained     TEXT NOT NULL,
  lost       TEXT NOT NULL,
  boundInto  TEXT NOT NULL,
  -- 1 when the module held a surface before, so a provider may still hold a parse of what it was.
  heldBefore INTEGER NOT NULL CHECK (heldBefore IN (0, 1)),
  -- JSON: the scope keys the module contributed to before or after.
  scopes     TEXT NOT NULL DEFAULT '[]'
);

-- Modules owed a parse because a move left their bindings stale, until a parse reading references
-- is admitted.
CREATE TABLE rebind_owed (
  module     TEXT PRIMARY KEY,
  -- Null when payable now; else the provider a failed parse waits on.
  blockedBy  TEXT,
  -- 'outage' waits for that provider to answer again; 'refusal' for its own file or a restart.
  blockedFor TEXT CHECK (blockedFor IN ('outage', 'refusal')),
  -- The daemon and provider process that failed it; either restarting retries it.
  blockedIn  TEXT
);
-- Every admitted parse asks for its provider's outages, so the ask is an indexed read.
CREATE INDEX rebind_owed_blocked ON rebind_owed(blockedBy, blockedFor);

CREATE TABLE symbols (
  symbolId    TEXT PRIMARY KEY,
  -- Not the same thing as symbolId, deliberately. A symbol id names the SYMBOL and survives edits;
  -- a fact id names this row as it currently reads, so a changed signature is a changed fact.
  factId      TEXT NOT NULL,
  module      TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  visibility  TEXT NOT NULL,
  exported    INTEGER,
  containerId TEXT,
  signature   TEXT,
  startLine   INTEGER NOT NULL,
  startChar   INTEGER NOT NULL,
  endLine     INTEGER NOT NULL,
  endChar     INTEGER NOT NULL,
  -- The name alone. A rename rewrites this span, never the declaration's whole range.
  nameLine    INTEGER NOT NULL,
  nameChar    INTEGER NOT NULL,
  nameEndLine INTEGER NOT NULL,
  nameEndChar INTEGER NOT NULL,
  -- 1 when the name is nowhere in the source and the name columns hold the range start instead.
  synthesizedName INTEGER,
  -- All nullable. A metric a provider does not compute is absent, never zero, because zero
  -- branches and "not measured" are different facts.
  mLines      INTEGER,
  mParameters INTEGER,
  mNesting    INTEGER,
  mBranches   INTEGER,
  -- Evidence that a vanished declaration reappeared elsewhere; null before a full parse.
  patternDigest   TEXT,
  patternCoverage TEXT,
  -- Null reads the kind.
  contains        TEXT CHECK (contains IN ('members', 'locals')),
  -- Null: the provider named no safe insertion line.
  memberInsertLine INTEGER,
  -- The provider's own word for the form, such as an extension or a trait method.
  languageKind    TEXT,
  valueStatus     TEXT CHECK (valueStatus IN ('set', 'empty'))
);
CREATE INDEX symbols_module ON symbols(module);
CREATE INDEX symbols_name ON symbols(name);
CREATE INDEX symbols_fact ON symbols(factId);

CREATE TABLE refs (
  factId     TEXT NOT NULL,
  module     TEXT NOT NULL,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL,
  targetId   TEXT,
  fromId     TEXT,
  -- Null when the provider did not say.
  qualified  INTEGER,
  provenance TEXT NOT NULL,
  startLine  INTEGER NOT NULL,
  startChar  INTEGER NOT NULL,
  endLine    INTEGER NOT NULL,
  endChar    INTEGER NOT NULL,
  -- The binding the use resolves through, when proved: declaration or import, with the import
  -- edge's span and the member path as JSON.
  originKind      TEXT,
  originStartLine INTEGER,
  originStartChar INTEGER,
  originEndLine   INTEGER,
  originEndChar   INTEGER,
  originPath      TEXT
);
CREATE INDEX refs_module ON refs(module);
-- The whole reason for a database: this turns reverse lookup into an indexed read.
CREATE INDEX refs_target ON refs(targetId);
CREATE INDEX refs_from ON refs(fromId);
CREATE INDEX refs_name ON refs(name);
-- Not unique, here or on any fact table. Two identical statements in one file are the same fact
-- written twice, so one id for both is the right answer rather than a collision to design around.
CREATE INDEX refs_fact ON refs(factId);
CREATE INDEX refs_origin ON refs(module, originStartLine, originStartChar);

-- One row per import EDGE, not one per statement: a name, a namespace, a wildcard, an injection or a
-- side effect. The edge column holds the whole protocol edge as JSON; the others are what queries read.
CREATE TABLE imports (
  factId     TEXT NOT NULL,
  module     TEXT NOT NULL,
  specifier  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  loads      TEXT CHECK (loads IN ('static', 'deferred')),
  elided     INTEGER CHECK (elided IN (0, 1)),
  -- The source name and its span; null when the edge names no export.
  name       TEXT,
  startLine  INTEGER,
  startChar  INTEGER,
  endLine    INTEGER,
  endChar    INTEGER,
  -- The local binding and its span; null when the edge writes none.
  localName      TEXT,
  localStartLine INTEGER,
  localStartChar INTEGER,
  localEndLine   INTEGER,
  localEndChar   INTEGER,
  -- The edge as written, which export targets and reference origins name it by.
  spanStartLine INTEGER NOT NULL,
  spanStartChar INTEGER NOT NULL,
  spanEndLine   INTEGER NOT NULL,
  spanEndChar   INTEGER NOT NULL,
  bindsLocally  INTEGER NOT NULL,
  typeOnly      INTEGER NOT NULL DEFAULT 0,
  edge          TEXT NOT NULL,
  -- Where the specifier landed when written, as JSON; null when unresolved or external.
  landing       TEXT,
  -- A module landing's module.
  target        TEXT,
  -- A scope landing's key, JSON [providerId, kind, scopeId].
  targetScope   TEXT,
  -- An external resolution's indexable module: reachability only, never a landing.
  surfaceTarget TEXT
);
CREATE INDEX imports_module ON imports(module);
CREATE INDEX imports_name ON imports(name);
CREATE INDEX imports_local ON imports(localName);
CREATE INDEX imports_fact ON imports(factId);
CREATE INDEX imports_target ON imports(target);
CREATE INDEX imports_scope ON imports(targetScope);
CREATE INDEX imports_surface ON imports(surfaceTarget);
CREATE INDEX imports_span ON imports(module, spanStartLine, spanStartChar);

-- One row per export edge. The edge column holds the protocol edge as JSON; the others are what queries read.
CREATE TABLE exports (
  factId         TEXT NOT NULL,
  module         TEXT NOT NULL,
  form           TEXT NOT NULL,
  name           TEXT,
  targetKind     TEXT NOT NULL,
  targetSymbolId TEXT,
  edge           TEXT NOT NULL
);
CREATE INDEX exports_module ON exports(module);
CREATE INDEX exports_name ON exports(name);
CREATE INDEX exports_target ON exports(targetSymbolId);
CREATE INDEX exports_fact ON exports(factId);

-- Each scope a module contributes to, empty contributions included, so a scope with no member is
-- told apart from one nothing admitted.
CREATE TABLE scope_contributions (
  module   TEXT NOT NULL,
  scopeKey TEXT NOT NULL,
  PRIMARY KEY (module, scopeKey)
);
CREATE INDEX scope_contributions_key ON scope_contributions(scopeKey);

CREATE TABLE scope_members (
  module   TEXT NOT NULL,
  scopeKey TEXT NOT NULL,
  memberId TEXT NOT NULL
);
CREATE INDEX scope_members_module ON scope_members(module);
CREATE INDEX scope_members_key ON scope_members(scopeKey);

-- Advanced by every write a contributor makes, so a plan can tell its scope moved.
CREATE TABLE scope_generations (
  scopeKey   TEXT PRIMARY KEY,
  generation INTEGER NOT NULL
);

-- Each module's effective exports, from the export resolver: a name, its meaning and origin as
-- JSON, and its certainty. A null name is an unnamed route, such as unknown coverage.
CREATE TABLE effective_exports (
  module         TEXT NOT NULL,
  name           TEXT,
  meaning        TEXT,
  origin         TEXT NOT NULL,
  originSymbolId TEXT,
  certainty      TEXT NOT NULL
);
CREATE INDEX effective_exports_module ON effective_exports(module);
CREATE INDEX effective_exports_origin ON effective_exports(originSymbolId);

-- Modules whose effective exports a write may have moved, until settlement recomputes them.
-- heldBefore: the index held the module before the write that owed it.
CREATE TABLE projection_debt (
  module     TEXT PRIMARY KEY,
  heldBefore INTEGER NOT NULL
);

-- Text as facts rather than as bytes. A name inside a string is not a reference, so without this
-- table an __all__ entry and a connect("thing_happened") argument are in no index anywhere.
CREATE TABLE literals (
  factId      TEXT NOT NULL,
  module      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  value       TEXT NOT NULL,
  -- Kept apart from value so a range query is arithmetic rather than a string comparison, where
  -- "10" sorts before "9" and 0xFF never equals 255.
  number      REAL,
  containerId TEXT,
  startLine   INTEGER NOT NULL,
  startChar   INTEGER NOT NULL,
  endLine     INTEGER NOT NULL,
  endChar     INTEGER NOT NULL
);
CREATE INDEX literals_module ON literals(module);
CREATE INDEX literals_value ON literals(value);
CREATE INDEX literals_number ON literals(number);
CREATE INDEX literals_fact ON literals(factId);
CREATE INDEX literals_container ON literals(containerId);

-- Doctrine lives here. Every other fact table answers "what is this code", and this one answers
-- "what did someone say about it", which was the one question that always fell back to grep.
CREATE TABLE comments (
  factId     TEXT NOT NULL,
  module     TEXT NOT NULL,
  -- Verbatim, markers included, because a citation quoting a comment must quote the file.
  raw        TEXT NOT NULL,
  -- Markers and wrapping removed. Search runs over this so a phrase split across a line break is
  -- still one phrase; display and citations use raw.
  normalized TEXT NOT NULL,
  form       TEXT NOT NULL,
  placement  TEXT NOT NULL,
  -- Null when the module is the container: a header, a licence, a banner. Absence is the answer
  -- here rather than a missing one, which is why nothing guesses a symbol to put in it.
  anchorId   TEXT,
  startLine  INTEGER NOT NULL,
  startChar  INTEGER NOT NULL,
  endLine    INTEGER NOT NULL,
  endChar    INTEGER NOT NULL
);
CREATE INDEX comments_module ON comments(module);
CREATE INDEX comments_anchor ON comments(anchorId);
CREATE INDEX comments_fact ON comments(factId);
CREATE INDEX comments_form ON comments(form);

-- A document's prose. Separate from comments because the answer shape differs: a comment result
-- names the symbol it documents, and a doc result names the heading PATH it was found under.
CREATE TABLE docs (
  factId     TEXT NOT NULL,
  module     TEXT NOT NULL,
  -- Verbatim, so a citation quoting a region quotes the file.
  raw        TEXT NOT NULL,
  -- Whitespace collapsed. Search runs over this so a sentence wrapped across lines is one phrase.
  normalized TEXT NOT NULL,
  -- Constrained, because rowToDoc reads any non-zero as true and would launder a bad write.
  fenced     INTEGER NOT NULL CHECK (fenced IN (0, 1)),
  -- Null before the first heading and in a document with none, which is the region belonging to the
  -- module. Absence is the answer, not a missing one, so nothing guesses a heading to put here.
  anchorId   TEXT,
  startLine  INTEGER NOT NULL,
  startChar  INTEGER NOT NULL,
  endLine    INTEGER NOT NULL,
  endChar    INTEGER NOT NULL
);
CREATE INDEX docs_module ON docs(module);
CREATE INDEX docs_anchor ON docs(anchorId);
CREATE INDEX docs_fact ON docs(factId);

-- The knowledge layer's tables, keyed by subject and owned by subjects.ts.
${KNOWLEDGE_SCHEMA}

${RELATION_TABLES}

${JOURNAL_DDL}
`;

/**
 * Every table a file contributes rows to, keyed by module.
 *
 * One list, because replaceFile and forgetFile must clear exactly the same set. Written out
 * separately, a table added to one and not the other leaves a deleted file's rows in the index
 * forever, still answering searches.
 */
const FACT_TABLES = [
	"refs",
	"symbols",
	"imports",
	"exports",
	"scope_contributions",
	"scope_members",
	"literals",
	"comments",
	"docs",
	"notes",
] as const;

export { FACT_TABLES, NOTES_TABLE, SCHEMA };
