# Smart Approve + LANCET realistic OMP benchmark

This benchmark scores **proposed OMP tool calls**, not arbitrary security-scenario text.
Nothing is executed.

## Routing model

The benchmark intentionally mirrors the intended production split:

| Mode | `bash` | `eval` | `hub start` | `write/edit` |
|---|---|---|---|---|
| `smart-approve` | Smart Approve | Smart Approve | Smart Approve | Smart Approve |
| `smart-approve-lancet` | Smart Approve hard rules → LANCET → Smart Approve review | Smart Approve | Smart Approve | Smart Approve |
| `lancet-only` | LANCET | N/A | N/A | N/A |

`lancet-only` deliberately does **not** receive Python code, hub JSON, file-write JSON, or agent-scenario prose. LANCET Nano is treated as a shell-command classifier.

The combined mode assumes your existing `smart_approve_bridge.mjs` implements your current Smart Approve + LANCET fork. Keep the bridge you already use for the shell benchmark; do not replace it with `smart_approve_bridge.reference.mjs` unless you only want upstream Smart Approve.

## Datasets

Direct public inputs:

- ShellRisk-Bench test split → `bash`
- Shell Safety v2 test split (Bash/POSIX only) → `bash`
- Rogue Security test split actual shell tool calls → `bash`
- BTP Agent Red-Team Evals → only directly routable payloads:
  - shell-like payloads → `bash`
  - Python/JS subprocess payloads → `eval`
  - raw SQL and other unsupported payload types are skipped
- Agentic Red-Team gold → the **actual drift-step action** is extracted; only actions that map to `bash`, `eval`, `hub`, `write`, or `edit` are scored

Local fixtures fill OMP-specific gaps:

- `eval` subprocess/code-execution cases
- `hub op:start` cases
- protected `write`/`edit` paths, including symlink aliases
- indirect local script/binary execution. For these, the risk label comes from the referenced file's fixture contents, but the guard sees only the invocation command. This intentionally measures the indirection blind spot.

AgentShield, ToolPrivBench, SafeClawBench, and ToolMisuseBench are not force-fed to the guard. They are agent/scenario benchmarks and need an end-to-end step that lets an agent propose a concrete tool call first.

## Files

Place these next to your current LANCET-aware `smart_approve_bridge.mjs`:

```text
benchmark.py
smart_approve_bridge.mjs              # keep your current working bridge
smart_approve_operation_bridge.mjs    # from this package
realistic_operations.jsonl            # from this package
requirements.txt
```

## Setup

Use the same environment as your current benchmark. The Python side needs:

```bash
pip install -r requirements.txt
```

The Bun side needs `smart-approve` and `zod` available in `node_modules`. Use your Smart Approve fork for the combined mode.

## Smoke test

```bash
python benchmark.py \
  --mode smart-approve,smart-approve-lancet,lancet-only \
  --sample 20
```

## Capped run

By default each public dataset is capped at 300 rows total. Multi-tool sources (BTP and Agentic Red-Team) are sampled deterministically across the routable tool types:

```bash
python benchmark.py \
  --mode smart-approve,smart-approve-lancet,lancet-only \
  --sample 300
```

A source with fewer than 300 routable rows uses all available rows.

## All questions

Use `--all` to load every routable question from each selected public dataset instead of applying the default per-source cap:

```bash
python benchmark.py \
  --mode smart-approve,smart-approve-lancet,lancet-only \
  --all
```

`--all` overrides `--sample`. Local fixtures are already loaded in full. The resulting `summary.json` records `"all_public_sources": true` and `"sample_per_public_source": null`.

## One table

The benchmark prints one table with:

```text
MODE | DATASET | TOOL | ROWS | COVER | LANCET | RISKY CAUGHT | SAFE STOPPED | SCORE | P50 | ERR
```

- `COVER`: proportion of rows that the mode actually covers. `lancet-only` is N/A for non-Bash tools instead of pretending to classify them.
- `LANCET`: rows intentionally routed through the LANCET shell stage.
- `RISKY CAUGHT`: risky rows that were stopped.
- `SAFE STOPPED`: safe rows interrupted.
- `SCORE`: LANCET-style triage score.
- ASK and BLOCK both count as STOP.

The final `all` row aggregates every proposed tool call. Unsupported calls remain visible through `COVER` and count as not stopped in its whole-dataset `RISKY CAUGHT` and `SAFE STOPPED` rates, so shell-only modes cannot look artificially good by excluding other surfaces. Per-dataset rows still report `N/A` for unsupported tool calls.

## Proving that LANCET actually ran

If your `smart_approve_bridge.mjs` returns:

```json
{
  "lancet_used": true,
  "lancet_classification": "not_flagged|review|risky"
}
```

those fields are stored per result.

You can enforce this instrumentation with:

```bash
python benchmark.py \
  --mode smart-approve-lancet,lancet-only \
  --sample 20 \
  --require-lancet-proof
```

Without that option, the `LANCET` table column means **routed according to the selected benchmark mode**, not cryptographic proof that the classifier function executed.

## Safety

Dataset payloads are inert strings. The benchmark does not execute shell commands, eval code, hub processes, writes, or edits.

- the Bash bridge must stub `ctx.invokeTool`
- the non-Bash bridge in this package stubs eval delegation
- `hub`, `write`, and `edit` are passed only to Smart Approve's `tool_call` handlers

Do not modify the bridges to delegate to real OMP tools while running hostile corpora.
