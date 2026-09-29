# Smart Approve benchmark — non-shell surface expansion

This patch keeps the existing public shell benchmark and adds deterministic cases for the Smart Approve surfaces that shell-command datasets do not exercise:

- `eval` — Python and JavaScript/Bun subprocess/system-command detection
- `hub op:start` — dangerous applications, interpreter execution flags, dangerous args, and sensitive cwd
- `write` — protected-path interception, safe lookalikes, `.env.example`, and symlink aliases
- `edit` — the same protected-path gate exercised independently through the edit hook

The additional suite contains 97 cases. It is intentionally reported separately from the public shell datasets because it is a hand-authored coverage/accuracy suite, not a published external benchmark.

## Files in this patch

Copy these into the existing benchmark directory:

```text
benchmark.py
smart_approve_surface_bridge.mjs
surface_cases.jsonl
```

Keep your existing `smart_approve_bridge.mjs`, `package.json`, and LANCET integration. The new bridge is only for the non-shell surfaces.

## Safety

No benchmark command/code/tool payload is executed.

- `eval` native delegation is replaced with a stub.
- `hub`, `write`, and `edit` are tested by invoking Smart Approve's registered `tool_call` handlers directly.
- Protected-path prompts use a fake UI that records that approval was requested and responds `deny`.
- The bridge creates only harmless fixture files/symlinks under its isolated temporary benchmark HOME.

## Run

The non-shell suite is enabled by default:

```bash
python benchmark.py --mode smart-approve --runs 3
```

Compare Smart Approve and Smart Approve + LANCET:

```bash
python benchmark.py \
  --mode smart-approve,smart-approve-lancet,lancet-only \
  --runs 3
```

`lancet-only` is skipped for the non-shell suite because LANCET Nano is a shell-command classifier. `smart-approve-lancet` still runs the Smart Approve eval/hub/write/edit coverage, which should be equivalent to Smart Approve on those surfaces.

Quick smoke test:

```bash
python benchmark.py \
  --limit-per-dataset 20 \
  --limit-per-surface 4 \
  --mode smart-approve,smart-approve-lancet,lancet-only
```

Skip the new suite when you only want the existing shell benchmark:

```bash
python benchmark.py --no-surface-suite
```

## Output

Existing shell results are unchanged. Additional files are written under `surfaces/`:

```text
benchmark-results/<timestamp>/surfaces/
├── surface-results.jsonl
├── surface-results.csv
├── surface-summary.json
└── smart-approve-surface-bridge.log
```

The terminal prints:

- a separate table for `eval`, `hub`, `write`, and `edit`;
- an integrated table that combines shell rows with the non-shell surface rows.

The integrated comparison uses the same mode for both datasets when available. Its `lancet-only` row intentionally combines the LANCET-only shell result with the Smart Approve surface result, making the gain from combining LANCET shell coverage with Smart Approve's other surfaces visible through the score and `SCORE Δ` columns.

Both tables report:

- risky caught;
- safe stopped;
- LANCET-style triage score;
- p50/p95 decision latency;
- errors.

The integrated table uses weighted safe/risky row counts across the shell and surface suites. Its combined p50/p95 latency values are weighted estimates from the component summaries.

## Label philosophy

The safe controls deliberately include benign subprocess/process-launch cases such as `subprocess.run(["echo", "hello"])`, `curl --version`, and `ssh -V`. Smart Approve may intentionally interrupt some of them. Those interruptions are counted as safe false-stops so the suite measures policy precision rather than merely mirroring Smart Approve's existing rules.
