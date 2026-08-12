# Questionaire

## Question 1 - Which query tools accept project selection?

Q: Should the optional `project` selector apply to every project-backed Lexicon query, or only `search_symbols`?
A: Every project-backed Lexicon query.

> All of them.

## Question 2 - How does project selection work?

Q: What should omission and explicit selection mean when several projects are bound?
A: Use an optional array of binding names. Omission selects the only binding and errors when several are bound. An empty array selects every bound project. A non-empty array selects those bindings.

> undefined - Default to the only binding if 1. Error if multiple are bound.
>
> [] - All repos
>
> ["switchboard", "evie-bot"] - Searches those 2 for their shared types

## Question 3 - What compatibility strategy applies?

Q: Should omitted multi-binding calls fail immediately for every tool, without a migration shim?
A: Make a clean break. Omitted calls fail when several projects are bound. Use `projects: []` for explicit all-project fan-out.

## Question 4 - Can mutation tools target several projects?

Q: Should mutation tools accept the array selector used by read tools?
A: No. `rename_symbol`, `record_answer`, `invalidate_answer`, and `reaffirm_answer` use a scalar project selector and can target only one binding.

> for these, dont do the array syntax.

## Question 5 - Must mutation tools name the sole binding?

Q: Should mutation tools require `project` even when only one project is bound?
A: No. The scalar is optional. Omission selects the sole binding and fails when several are bound.

> If only 1 is bound, allow omission.

## Question 6 - How are colliding binding names assigned?

Q: Which identifiers do selectors accept, and how should basename collisions be named?
A: Selectors accept binding names only. When several registered projects share a basename, number every member of the collision group: `app-1`, `app-2`, and so on. Never retain an unnumbered `app` that could select one arbitrarily.

> we accept binding name only.
>
> So not "app", "app-1". It has to be "app-1" "app-2"

## Question 7 - When do collision suffixes compact?

Q: Should collision suffixes remain permanent or compact as projects leave?
A: Keep names sticky during uptime. Compact them when the MCP server/plugin restarts. Agents then call `list_projects`, match the full path, and select the current binding name.

> Sticky during uptime. Compact upon restart of daemon.
>
> When agents list the projects again, they will see their project by full path and choose the right one.

## Question 8 - Which restart compacts binding names?

Q: Does compaction happen when a project daemon restarts or when the MCP server/plugin reloads?
A: Compact binding names when the MCP server/plugin restarts. Project-daemon restarts do not affect names.

> MCP restart then.

## Question 9 - What happens when a collision appears during a session?

Q: Should a newly registered same-basename project rename the live binding immediately or wait for reload?
A: Rename immediately. Existing `app` becomes `app-1` and the new project becomes `app-2` in that MCP session.

## Question 10 - What happens to bindings after a live collision rename?

Q: Should Lexicon preserve existing bindings or force the agent to reclarify its targets?
A: Clear every binding in that MCP session when a collision renames a bound project. Direct the agent to call `list_projects`, match full paths, and bind again.

> B.

# Plan

## Phase 1 - Build the session project catalog

- Make durable registration own stable project identity and full roots.
- Make one session catalog own binding names and bound state.
- Derive compact names when `buildServer` starts. Keep names sticky until that MCP server restarts.
- On a live basename collision, publish the complete numbered group atomically.
- If the rename touches a bound project, clear every session binding and return recovery guidance.
- Keep project-daemon identity and index storage independent from binding names.

## Phase 2 - Centralize project-backed tool registration

- Replace the repeated project routing registrations with one policy-driven registrar.
- Classify all project-backed tools explicitly as query or mutation.
- Add `projects?: string[]` to query tools and `project?: string` to mutation tools at registration time.
- Strip selector metadata before calling existing tool handlers.
- Keep binding and machine-wide store tools outside project query routing.

## Phase 3 - Enforce selection semantics

- Omitted selectors choose the sole binding and fail for zero or several bindings.
- `projects: []` selects every bound project.
- Non-empty arrays select the named bound subset in caller order.
- Validate the complete selection before invoking any backend.
- Reject duplicate, unknown, stale, or unbound names with recovery guidance.
- Mutation tools resolve at most one project and never fan out.

## Phase 4 - Make naming and recovery observable

- Show each session binding name beside its full root in `list_projects`.
- Report every live collision rename and binding clear in the registration result.
- Use the session catalog name consistently in result headings and errors.
- Update tool descriptions and project-selection examples for scalar and array selectors.
- Remove stale manually maintained tool counts or derive them from the registration source.

## Phase 5 - Prove the public MCP contract

- Add in-memory MCP tests for the complete tool list and selector schemas.
- Test query omission, all-project selection, subsets, order, and invalid targets.
- Test scalar mutation routing and zero-call failure behavior.
- Test collision numbering, live renames, cleared bindings, and restart compaction.
- Test simultaneous sessions keep independent binding-name catalogs over shared project identities.
- Plant a registration-policy violation and confirm the conformance test fails before trusting it.

## Phase 6 - Verify the shipped server

- Run adapter tests, the full test suite, and both halves of the lint gate.
- Build the committed shipping bundle without changing versions.
- Reload the plugin, confirm `tools/list` exposes the new schemas, and probe targeted and all-project queries against real bindings.
