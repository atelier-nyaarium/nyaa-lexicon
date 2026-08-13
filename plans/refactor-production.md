# Refactor system: production ready across all languages

The bar, set by the owner: no release while any tool on any language answers NotImplemented.
"Production ready" means the whole table below reads yes.

| | replace syntax gate | rename | move |
|---|---|---|---|
| TypeScript | yes | yes | yes |
| Python | yes | yes | yes |
| GDScript | yes | yes | yes |

**The bar is met.** No tool on any language answers a blanket NotImplemented; `notImplementedMove`
appears nowhere in `providers/`. What remains NotImplemented is per-case and honest: a construct a
provider understands but will not rewrite (namespace imports, star re-exports, `__all__` string
entries), which is the closed-enum reason doing its job.

## Workflow

Core and coordination stay in the main session; per-language provider engineering is delegated to
Codex threads confined to their own subtrees. Model policy, set by the owner:

- `gpt-5.6-sol` ("Sonnet-Sol") for first-time critical engineering: inventing a mechanism.
- `gpt-5.6-luna` ("Sonnet-Luna") for coasting: extending a shape that already exists.
- A model switch means dropping the thread and starting fresh with a handoff; Codex pins the
  model per thread.
- The main session is the triage gate: every Codex report is verified against the code, and a
  spec disagreement is resolved here, never by the thread adjusting the expectation.

Three languages now; more are added the moment this workflow proves out.

## Lanes

1. **Move conformance case table.** The 16-row table deferred from the transactions plan, plus a
   tsconfig-alias row (17 total). Runnable today against TypeScript. Rows are the executable spec
   the provider threads build against. Skip rule: a `NotImplemented` refusal skips, never fails,
   so honest partial providers stay green-with-skips.
2. **Python.** (a) Deterministic symbol-id disambiguators, which retires the shared-id refusal in
   `replacementGuard` for callables. (b) `moveEdits`: import model is `import m`,
   `from m import name`, aliases, relative imports, `__init__` re-exports, `__all__`.
3. **GDScript.** (a) Syntax diagnostics from the hand-rolled parser's own stages, tier flipped to
   true, closing the SyntaxUnchecked hole in replace. (b) `moveEdits`: no import statements;
   `class_name` registration may need zero site edits, `preload`/`load` path literals are string
   rewrites the contract already carries as literal sites.
4. **Fixtures and polish.** DONE. Annotated-constant fixture landed (45fc2b0) and
   exported-declarations documented as a deliberate skip, since GDScript has no export concept and
   absence is its honest answer; `_claimedHash` removed end to end (20ea615); move cosmetics landed
   after lane 2 cleared the corpus (79219c5).
5. **Release.** One `bun run build` when the table is all yes. Includes the banner fix already in
   source (`c85fa94`).

## What driving it found that the suites did not

Every lane was verified by suites AND by driving `dist/main.js` over real MCP, and the second one
kept finding things:

- `refactor_move` on a GDScript `class_name` class relocated ONLY the `class_name` line, orphaning
  every method behind it. The root declaration's range was one line, because the script IS the
  class. 52 provider tests and 6 corpus rows passed over that defect.
- The same move then blocked on `DynamicDependency` for `int`. The core listed every benign unbound
  reference as a dependency, so a provider had to block on builtins; the inventory now excludes the
  reasons the index never claims to place.
- GDScript's bind pass returned the parse-time `NotImplemented` placeholder after searching the
  whole workspace. It now answers why nothing matched: `DynamicallyTyped` for a member whose
  receiver is unknown, `NotIndexed` for a bare name.
- Python's `positionAt` searched at the offset rather than before it, minting a negative character
  for a module whose first byte is a newline.

## Rulings made (contract owner decisions, binding on threads)

- **Disambiguators are method-kind only.** The grammar follows SCIP: the disambiguator is the
  paren slot callables already render. Python lane 2a covers callable duplicates (`def`
  redefinition, conditional `def`, same-scope nested duplicates) and nothing else. Non-callable
  duplicates keep colliding and keep being refused by the core; that is honest.
- **Found while ruling:** `encodeDescriptor` silently drops a disambiguator on non-method kinds,
  and the TS extractor sets ordinals on every kind, so duplicated types/terms collapse onto one id
  today. Board entry `bd_66ae12ba...` holds the follow-up decision (throw vs extend). Not in the
  release path.
- **Declaration ranges stop at a blank line.** A comment block separated from the declaration by a
  blank line belongs to the file, not the symbol. Shipped in `c85fa94` for TypeScript; Python and
  GDScript build ranges from the node and do not share the defect.

## Thread ledger

| thread | agent id | model | scope | state |
|---|---|---|---|---|
| A: move case table | codex_b6ab4174bf98539a417b7888fe55ca8b | gpt-5.6-sol | protocol/src/conformance, protocol/src/__tests__ | LANDED: 17 rows, 16 pass, 1 mismatch reported |
| B: python disambiguators | codex_94250922d00562dc521188b1bbb722ff | gpt-5.6-sol | providers/python | LANDED: all six cases, ruling received mid-flight |
| C: gdscript diagnostics | codex_2a5f24221296fff7e84e154e43b1b886 | gpt-5.6-sol | providers/gdscript | LANDED: four diagnostics, tier true, case SKIP -> PASS |
| D: python moveEdits | codex_ae1e69c4b2e03d64daa384c8bc551a58 | gpt-5.6-luna | providers/python, moveCorpus | LANDED: 15 corpus rows; its sandbox could not run Vitest, so 4 harness defects and 1 real bug were caught here |
| E: gdscript moveEdits | codex_3f96af51ee0ee3d61fa14c9d5236a352 | gpt-5.6-luna | providers/gdscript, own corpus file | LANDED: 6 rows, 52 tests, loader honesty tightened on its own review |

Sol was used for the inventing steps only, per the owner's usage budget; both move
implementations ran on Luna against the case table as executable spec. A model switch means a new
thread: Codex pins the model for an agent's lifetime.

Threads were told: no commits, dist/ is a disposable byproduct, spec mismatches are REPORTED not
absorbed, planted violations must go red before a test is trusted.

### Triage results (first Sol round)

- Thread A hand-spelled six symbol ids in the corpus; the id-grammar residue test caught it in
  thread C's full-suite run. Two of the six carried the WRONG kind suffix (`add.` for a function,
  `Cart.` for a type), which is the drift the rule exists to stop. Fixed by composing.
- Thread A's one MISMATCH was a real provider bug: `rewriteImportSite` ignored `importKind`, so a
  star re-export was repointed wholesale, silently rebinding every other symbol the barrel
  re-exported. Fixed: namespace, wildcard and sideEffect sites now block. Table is 17/17.
- Thread B's honest caveat: previously the LAST duplicate won the declaration slot, so knowledge
  recorded against a colliding bare id may describe the last occurrence while bare now means
  FIRST. Accepted; only previously-colliding duplicates are affected.
- The `node dist/providers/*/main.js` initialize timeout all three threads hit is the Codex
  sandbox (stdin EOF on fd 0), not the artifact: the same commands pass outside it.
- End-to-end proof of lane 3a: refactor_replace with broken GDScript through the shipped MCP
  server now answers "Not replaced: the replacement does not parse", where before it applied and
  shrugged SyntaxUnchecked. Duplicate reason strings per unclosed bracket are noisy; polish note.

## Verification order (unchanged from CLAUDE.md, repeated because threads cite it)

1. `bun run lint` (both halves), `bun run test`.
2. `node dist/conformance.js node dist/providers/<language>/main.js` per touched provider.
3. `node dist/grade.js <switchboard checkout>` when extraction/resolution/service changes.
4. Drive the built server over real MCP. A green gate is not evidence.

## Still to schedule

- Lane 2b Sol thread (Python moveEdits) once the case table and 2a land, so it builds against
  executable spec with stable ids.
- Lane 3b Sol thread (GDScript moveEdits) once the case table lands.
- GDScript fixture pair and polish entries (Luna-grade).
- The core keeps `refactor_move`'s orchestration language-neutral throughout; anything that smells
  like a language branch in core is a provider contract field instead.
