# kabanos — Aggregation pipeline (feature spec)

This feature is a Compass-style aggregation builder for Elasticsearch/OpenSearch. The user stacks simple **stages** top to bottom. Every stage shows **its own live output**. At any time the user can switch to the generated **JSON** request or to **ES|QL**.

Design: `design/app/Aggregations.dc.html` (screen 7). It is a mockup; see CLAUDE.md for how to treat `.dc.html` files. It is interactive: press Play on the canvas to switch Stages / JSON / ES|QL.
Where it lives: a new **Aggregations** sub-tab on the index view (SPEC.md §7), next to Query.
Builds on: ClusterClient, EngineAdapter, MetadataCache (mappings), LibraryStore (SPEC.md §2).

---

## 1. Why stages need a compiler

MongoDB pipelines are a flat list. Elasticsearch aggregations are a **tree**: a query, then bucket aggs that nest sub-aggs, plus "pipeline aggs" that read sibling/child metrics. The UI shows a flat list, and a **compiler** turns that list into the tree:

- Each **Group by** stage opens a new nesting level.
- Each later stage attaches **inside the current level**: it runs once per bucket.
- The UI says so in each Group by card: "Each next stage runs inside every \<field\> bucket."

## 2. Stage types (v1)

| UI stage | Options in the form | Compiles to |
|---|---|---|
| **Filter** | conditions: field · operator (is, is not, one of, exists, missing, <, ≤, >, ≥, between, contains text) · value; match all / any | before the first Group by: `query.bool.filter` / `must_not` / `should`+`minimum_should_match`. After a Group by: a `filter` bucket agg wrapping the rest of the pipeline at that level |
| **Group by** | kind: Values (`terms`), Number ranges (`range`), Date ranges (`date_range`), Histogram, Date histogram, Named filters (`filters`), Multi-field (`composite`); field; size; order (count, key, or a metric from a later Metrics stage); missing values (skip/bucket as "(missing)"); min doc count | the matching bucket agg; opens a new level |
| **Metrics** | rows of `name = op(field)`. Ops: Count, Sum, Average, Min, Max, Stats, Median, Percentiles, Unique count, Value count | `value_count`, `sum`, `avg`, `min`, `max`, `stats`, `percentiles` (median = `[50]`), `cardinality` at the current level |
| **Keep only** (having) | metric · comparator · number; several rows with AND | `bucket_selector` with generated `buckets_path` and script `params.m0 > 1500000 && …` |
| **Sort & limit** | sort by metric or doc count, direction, keep N, skip M | `bucket_sort` (inside a level). At the root (no Group by): the query's `sort` / `size` / `from` |
| **Running total** | metric | `cumulative_sum` (only valid under histogram/date_histogram) |
| **Change over time** | metric, mode (difference / % change) | `derivative`, or `serial_diff` with lag 1 (only under histogram/date_histogram) |
| **Top documents** | N, sort, fields to show | `top_hits` (size capped at 100) |
| **Custom JSON** | a raw agg object | inserted verbatim at the current level; the escape hatch for anything else |

Each stage also has: `enabled`, `collapsed`, a user label, and "</> JSON". That last one edits only this stage's compiled fragment; saving converts it back to the form if possible, otherwise to a Custom JSON stage.

## 3. Data model

```ts
type Pipeline = {
  id: string; name: string; connectionId: string;
  target: string;                 // index, alias, or pattern
  stages: Stage[];
  preview: { sampled: boolean; probability?: number };
  createdAt: string; updatedAt: string; tags: string[];
};

type Stage =
  | { id: string; kind: 'filter'; enabled: boolean; match: 'all'|'any'; conditions: Condition[] }
  | { id: string; kind: 'groupBy'; enabled: boolean; name: string; group: GroupSpec }
  | { id: string; kind: 'metrics'; enabled: boolean; metrics: { name: string; op: MetricOp; field?: string; percents?: number[] }[] }
  | { id: string; kind: 'keepOnly'; enabled: boolean; rules: { metric: string; cmp: '>'|'>='|'<'|'<='|'=='|'!='; value: number }[] }
  | { id: string; kind: 'sortLimit'; enabled: boolean; by: string /* metric | '_count' | '_key' */; dir: 'asc'|'desc'; size: number; from?: number }
  | { id: string; kind: 'runningTotal' | 'changeOverTime'; enabled: boolean; metric: string; mode?: 'diff'|'pct' }
  | { id: string; kind: 'topDocs'; enabled: boolean; size: number; sort?: SortSpec; fields?: string[] }
  | { id: string; kind: 'custom'; enabled: boolean; name: string; json: object };
```

Store it in SQLite next to library queries: a library item with `type: "aggregation"`. It is searchable by name, target, fields, and tags (FTS5), like other queries.

## 4. Compiler (`compile(pipeline, uptoStageIndex?) → { request, stageMap, errors }`)

- `request` is the full `_search` body with `size: 0`, unless the pipeline has no Group by (then it is a normal search with the root Filter / Sort & limit / Top documents).
- `stageMap` gives each stage its JSON path(s) in the request. It is used for the JSON view's gutter numbers and for highlighting.
- `uptoStageIndex` compiles only stages `0..k`. That is what each stage's preview runs.
- Agg names: use the stage's `name` (sanitize to `[a-z0-9_]+`, unique per level). Default names are `by_<field>`, `<metric name>`, `keep_<n>`, `top_<n>`.
- `buckets_path` uses names at the current level. Use `>` to reach into a single-bucket child, and `.` for multi-value metrics (`stats.avg`, `median_price[50.0]` → expose percentiles as `median_price.50`).
- Validation errors are reported per stage and shown in red on that card. Run stays enabled for the rest:
  - Keep only / Sort & limit / Running total / Change over time need a Group by above them.
  - Running total / Change over time need the nearest Group by to be a histogram or date histogram.
  - A metric field must be numeric for sum/avg/min/max/stats/percentiles.
  - A Group by field must be aggregatable. For a `text` field, suggest its `.keyword` sub-field.
  - Referenced metric names must exist at that level.
- **Security:** never take free-form Painless from the form. Scripts are generated from a fixed template that uses only `params.*` and numeric literals. Free-form scripts appear only if the user types them into a Custom JSON stage.

## 5. Decompiler (`decompile(requestBody) → { pipeline, unsupported[] }`)

- Used when the user edits the full JSON view, or pastes a request from the console.
- Walk the tree: `query` → Filter stages (where the condition shapes are known; otherwise a Filter stage in "raw query" mode). Then follow **one** bucket-agg chain depth-first. Siblings at the same level become Metrics / Keep only / Sort & limit / etc.
- Anything that does not map (several sibling bucket aggs, unknown agg types, scripts) becomes a **Custom JSON** stage at that level. Never drop anything.
- Round trip: `compile(decompile(x))` must be deeply equal to `x` for every fixture in `__fixtures__/aggs/*.json`.

## 6. Live preview per stage

- When a stage changes (debounced 400 ms), re-run the previews from that stage down. Use `compile(pipeline, k)` for each stage `k`.
- Concurrency 2. Cancel in-flight requests for stages that changed again (AbortController). Cache results by hash of `(connection, target, compiled prefix)` for 60 s.
- Preview limits so a preview never hurts the cluster: terms `size` capped at 10 (the real value is kept for Run), `top_hits` 3, filter sample `size: 3` with `track_total_hits: true`, request `timeout: "10s"`.
- **Fast preview (sampled)** toggle: wrap the aggs in `random_sampler` (ES ≥ 8.2) with a probability chosen to hit about 100k docs. Mark sampled numbers with `≈`. On OpenSearch, or older ES, use `sampler` (shard_size 10000) and say so.
- When live preview is off, previews update only on Run.
- **Run** executes the full pipeline without preview limits. Results open in the bottom result pane (Table / JSON / Chart later), with Export CSV / NDJSON and Copy as cURL.

### What each stage's output panel shows
| Stage | Output panel |
|---|---|
| Filter | "N documents" (hits.total, exact) + 3 sample docs showing only the fields used later in the pipeline |
| Group by | "N buckets · X docs covered · Y in other buckets" (`sum_other_doc_count`), bucket cards with key, doc_count, and a relative bar; "+N more". For a nested level: "N buckets per \<parent\>" (show min–max across parents) and the first parent expanded |
| Metrics | a table with one row per bucket of the current level: key(s), doc_count, each metric |
| Keep only | "K of N buckets kept" (compare with the previous stage's preview) + the table |
| Sort & limit | the table, in the new order |
| Running total / Change | the table with the new column; the first row's derivative is blank |
| Top documents | compact doc cards per bucket |
| Custom JSON | the raw response fragment for that agg |

### Flow bar
A row of chips over the stages: `Index 12.4M docs → 1 Filter 48,213 → 2 Group by city 10 buckets → …`, built from the preview results. Clicking a chip scrolls to its stage. The stage being edited is highlighted in amber.

### Response flattening (`flatten(response, pipeline) → rows[]`)
Walk the response along the Group by chain. Produce one row per leaf bucket combination (`city.name`, `month`, …metrics). This feeds the Metrics table, the result pane's Table view, and the CSV export.

## 7. JSON view
- Monaco editor with the compiled request. The left gutter shows the stage number for each line (from `stageMap`), and lines are tinted per stage.
- Edits are decompiled on blur or after a 1 s pause. If decompiling yields `unsupported`, show a notice ("2 parts kept as Custom JSON stages") rather than an error.
- The side panel "How stages map to Elasticsearch" lists each stage → its ES construct.

## 8. ES|QL view
- Available when the detected engine is Elasticsearch ≥ 8.11. Runs through `POST /_query`.
- Translation (`toEsql(pipeline) → { query, warnings[] }`): `FROM <target>`, Filter → `WHERE`, Metrics + Group by (terms / date histogram via `BUCKET()`) → `STATS … BY …`, Keep only → `WHERE` after STATS, Sort & limit → `SORT` / `LIMIT`.
- **Warnings, never silent changes:** for example, a nested Group by can't keep per-parent semantics (ES|QL `BY a, b` is flat), and Top documents / Running total have no direct equivalent. Show a warning per affected stage, as in the mockup.
- The ES|QL view is read-only in v1, with a "Copy" button and "Open in workspace". Two-way ES|QL editing is out of scope.
- OpenSearch: show **PPL** instead through `POST /_plugins/_ppl` when the SQL/PPL plugin is installed; otherwise hide the tab. PPL can be phase 2.

## 9. Field pickers and autocomplete
- Fields come from MetadataCache: the union of mappings for the target. If the same field has different types across indices, show a ⚠ with the conflicting types.
- Show only aggregatable fields (keyword, numeric, date, boolean, ip, geo_point for geo-only stages). Show text fields greyed out, with "use title.raw".
- Metric pickers show only numeric fields for numeric ops.
- Metric names typed in Keep only / Sort & limit autocomplete from metrics defined at that level.

## 10. Integration
- **Library:** "Save" stores the pipeline. It shows in the Query library with a ∑ icon and is searchable.
- **Routines:** a routine step can be "Run aggregation pipeline \<name\>", and its rows can be captured (for example `steps.agg.rows[0].avg_price`).
- **Workspace:** "Open in workspace" adds a request block with the compiled JSON.
- **Profile** button: runs with `"profile": true` and shows the time per aggregation next to each stage.
- Keyboard: ⌘↵ Run · ⌘⇧J cycle Stages/JSON/ES|QL · ⌘⌥↑/↓ move a stage · ⌘D duplicate a stage · ⌘⌫ delete a stage.
- Production safety: aggregations are read-only, so no confirmation is needed. Still honor read-only mode, and respect a per-connection "max preview concurrency" setting.

## 11. Suggested code layout
```
apps/desktop/src/features/aggregations/
  model.ts          Pipeline / Stage types + zod schemas
  compiler.ts       compile(), validation, stageMap
  decompiler.ts     decompile()
  esql.ts           toEsql() (+ ppl.ts later)
  preview.ts        debounced prefix runs, cache, cancellation, sampling
  flatten.ts        response → rows
  ui/               AggregationsTab, FlowBar, StageCard (one per kind), OutputPanels, JsonView, EsqlView, AddStageMenu
  __fixtures__/aggs/*.json
  __tests__/        compiler, decompiler round-trip, flatten, toEsql
```

## 12. Acceptance criteria
1. Building the pipeline in the mockup (Filter → Group by city → 3 Metrics → Group by month → Keep only avg_price > 1.5M → Sort & limit 5) through the forms produces exactly the JSON shown in the mockup's JSON view (names may differ only where the user named them).
2. Every stage shows output within 1 s of an edit on a local docker cluster with 1M docs, using sampled preview.
3. Disabling a stage removes it from the compiled request, and later stages re-validate.
4. Pasting any request from `__fixtures__/aggs` into the JSON view round-trips unchanged.
5. The ES|QL view shows a warning for every stage it can't translate faithfully. It never produces a query with different results without a warning.
6. Works on OpenSearch 2.x for every stage except ES|QL (and `random_sampler`, which falls back to `sampler`).
7. Unit-test coverage ≥ 90% for compiler / decompiler / flatten / esql.

## 13. Build order
1. model + compiler + fixtures/tests (no UI)
2. Stage cards (Filter, Group by, Metrics) + Run + result table
3. Live per-stage preview + flow bar
4. Remaining stage kinds + validation messages
5. JSON view with gutter + decompiler
6. ES|QL view + warnings, Profile, Library/Routines integration
