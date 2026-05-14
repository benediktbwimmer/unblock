# Matcher Lowering Contract

Matcher execution is split into four layers:

1. Parser: `parseMatcherQuery` reads the user DSL and produces the raw
   `QueryNode` syntax tree.
2. Normalizer: `parseNormalizedMatcherQuery` canonicalizes values that should
   be stable across dialects, such as task IDs, tag IDs, parent IDs, graph
   targets, and hierarchy targets.
3. Planner: `parseMatcherPlan` attaches non-DSL task-list filters to the
   normalized query. The plan is dialect-neutral.
4. Lowerer: a dialect-specific `MatcherLowerer` turns the plan into SQL plus
   parameters that return matching task IDs for one project.

The service-layer matcher remains the semantic reference. SQL lowerers must
match `matchMatcherQuery` for supported features, and tests should compare SQL
results with service evaluation on the same fixture data.

## Dialect Responsibilities

Lowerers must:

- Scope every query by `projectId`.
- Respect `includeArchived` and `includeFinished` filters in the plan.
- Return task IDs only. The service layer still owns final `TaskView` assembly
  and sorting.
- Use parameterized SQL only.
- Preserve boolean precedence from the parsed AST.
- Reject unsupported features explicitly rather than silently falling back to
  partial semantics.

Postgres and SQLite can differ in generated SQL, recursive CTE syntax details,
and JSON support. They must not differ in user-visible matcher semantics.

## Feature Classes

The normalizer records the feature classes used by a query:

- `field`: task fields, tags, assignments, source metadata, status, priority,
  parent, and comment count.
- `time`: lifecycle timestamp comparisons and presence checks.
- `comment`: comment author and comment recency predicates.
- `graph`: dependency and unblock traversal.
- `hierarchy`: descendant predicates.
- `boolean`: `and`, `or`, and `not` composition.

This feature list is intentionally advisory. Lowerers should inspect the AST,
but the feature list is useful for diagnostics, benchmark reporting, and staged
rollouts.
