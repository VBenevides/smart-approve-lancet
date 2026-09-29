/**
 * ToolGate template-method branch matrix, exercised through the real
 * BashToolGate and EvalToolGate classes with stubbed collaborators.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionCtx, AgentToolResult, RiskAnalysis } from "./types.ts";
import { getI18n } from "./i18n.ts";
import type { Lang } from "./i18n.ts";
import { AutoDecisionPolicy } from "./policy.ts";
import type { SmartApproveConfig } from "./config.ts";
import { BashToolGate } from "./bash-tool.ts";
import { EvalToolGate } from "./eval-tool.ts";
import type { GateDeps, LancetVerdict, ToolGate } from "./gate.ts";

function makeConfig(overrides: Partial<SmartApproveConfig> = {}): SmartApproveConfig {
  return {
    enabled: true,
    mode: "interactive",
    autoBlockRisk: "high",
    autoFallback: "regex",
    autoInHeadless: false,
    coverage: { eval: true },
    protectedPaths: [],
    llmAnalysis: true,
    rememberDecisions: true,
    contextMaxChars: 3000,
    analysisTimeoutMs: 30_000,
    rpcIdleTimeoutMs: 600_000,
    model: "@tiny",
    lancet: { enabled: false },
    ...overrides,
  };
}

interface Calls {
  delegate: number;
  analyze: number;
  lancet: number;
  notify: string[];
  logs: string[];
  session: string[];
  permanent: string[];
}

interface Harness {
  deps: GateDeps;
  ctx: ExtensionCtx;
  calls: Calls;
  confirmResult: boolean;
  selectResult: string | number | undefined;
  selectChoices: string[][] | null;
}

interface HarnessOptions {
  hasUI?: boolean;
  isAllowed?: boolean;
  analyzeResult?: RiskAnalysis | null;
  lancetResult?: LancetVerdict;
  lancetError?: Error;
}

function makeHarness(
  configOverrides: Partial<SmartApproveConfig> = {},
  opts: HarnessOptions = {},
): Harness {
  const config = makeConfig(configOverrides);
  if ((opts.lancetResult !== undefined || opts.lancetError) && configOverrides.lancet === undefined) {
    config.lancet = { enabled: true };
  }
  const calls: Calls = { delegate: 0, analyze: 0, lancet: 0, notify: [], logs: [], session: [], permanent: [] };
  const harness: Harness = {
    deps: {
      config,
      allowList: {
        isAllowed: () => opts.isAllowed ?? false,
        rememberSession: (tool: string, key: string, cwd: string) => {
          calls.session.push(`${tool}:${key}:${cwd}`);
        },
        rememberPermanent: (tool: string, key: string, cwd: string) => {
          calls.permanent.push(`${tool}:${key}:${cwd}`);
        },
      },
      contextGatherer: {
        gather: () => ({ firstUser: null, recentAssistant: [] }),
        format: () => "",
      },
      modelInvoker: {
        analyze: async (): Promise<RiskAnalysis | null> => {
          calls.analyze += 1;
          return opts.analyzeResult === undefined
            ? { risk: "low", recommend: "allow" }
            : opts.analyzeResult;
        },
      },
      policy: new AutoDecisionPolicy(config),
      logger: { log: (message: string) => calls.logs.push(message) },
      lang: "en" as Lang,
      t: getI18n("en"),
    },
    ctx: {
      hasUI: opts.hasUI ?? true,
      cwd: "/work/project",
      ui: {
        confirm: async () => harness.confirmResult,
        select: async (_title: string, choices: string[]) => {
          harness.selectChoices = [choices];
          return harness.selectResult;
        },
        setStatus: () => undefined,
        notify: (msg: string) => {
          calls.notify.push(msg);
        },
      },
      invokeTool: async () => {
        calls.delegate += 1;
        return { content: [{ type: "text", text: "native-run" }] };
      },
    },
    calls,
    confirmResult: true,
    selectResult: undefined,
    selectChoices: null,
  };
  if (opts.lancetResult !== undefined || opts.lancetError) {
    harness.deps.lancet = {
      score: async () => {
        calls.lancet += 1;
        if (opts.lancetError) throw opts.lancetError;
        return opts.lancetResult as LancetVerdict;
      },
    };
  }
  return harness;
}

function run(
  gate: new (deps: GateDeps) => ToolGate,
  h: Harness,
  params: unknown,
  signal?: AbortSignal,
): Promise<AgentToolResult> {
  return new gate(h.deps).execute(params, signal, undefined, h.ctx);
}

function blockedLabel(r: AgentToolResult): string {
  const m = r.content[0].text.match(/^Blocked: (.+)\n/);
  assert.ok(m, `no Blocked label in: ${r.content[0].text}`);
  return m[1];
}

// ── BashToolGate ─────────────────────────────────────────────────────

test("bash: safe command delegates with zero analysis", async () => {
  const h = makeHarness();
  const r = await run(BashToolGate, h, { command: "ls -la" });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.delegate, 1);
  assert.equal(h.calls.analyze, 0);
});

test("bash: empty command returns (no command) without delegating", async () => {
  const h = makeHarness();
  const r = await run(BashToolGate, h, { command: "   " });
  assert.equal(r.content[0].text, "(no command)");
  assert.equal(h.calls.delegate, 0);
});

test("bash: hard-block wins over everything", async () => {
  const h = makeHarness({}, {
    isAllowed: true,
    lancetResult: { classification: "not_flagged", score: 0.01, reason: null },
  });
  const r = await run(BashToolGate, h, { command: "rm -rf /" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.details, { blocked: true, reason: blockedLabel(r) });
  assert.equal(h.calls.delegate, 0);
  assert.equal(h.calls.analyze, 0);
  assert.equal(h.calls.lancet, 0);
  assert.ok(h.calls.logs.some((message) => message.includes("source=rules")));
});

test("bash: allowlist hit delegates without dialog", async () => {
  const h = makeHarness({}, {
    isAllowed: true,
    lancetResult: { classification: "not_flagged", score: 0.01, reason: null },
  });
  const r = await run(BashToolGate, h, { command: "git push -f origin main" });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.delegate, 1);
  assert.equal(h.calls.analyze, 0);
  assert.equal(h.calls.lancet, 0);
  assert.ok(h.calls.logs.some((message) => message.includes("source=allowlist")));
  assert.equal(h.selectChoices, null);
});

test("bash: no behavior skips LANCET", async () => {
  const h = makeHarness({}, {
    lancetResult: { classification: "not_flagged", score: 0.01, reason: null },
  });
  const r = await run(BashToolGate, h, { command: "ls -la" });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.lancet, 0);
});

test("bash: disabled LANCET preserves every native review outcome", async () => {
  const hard = makeHarness({ lancet: { enabled: false } }, {
    isAllowed: true,
    lancetResult: { classification: "risky", score: 0.99, reason: null },
  });
  const hardResult = await run(BashToolGate, hard, { command: "rm -rf /" });
  assert.equal(hardResult.isError, true);
  assert.equal(hard.calls.lancet, 0);

  const allowed = makeHarness({ lancet: { enabled: false } }, {
    isAllowed: true,
    lancetResult: { classification: "risky", score: 0.99, reason: null },
  });
  const allowedResult = await run(BashToolGate, allowed, { command: "git push -f origin feature" });
  assert.equal(allowedResult.content[0].text, "native-run");
  assert.equal(allowed.calls.lancet, 0);

  const safe = makeHarness({ lancet: { enabled: false } }, {
    lancetResult: { classification: "risky", score: 0.99, reason: null },
  });
  const safeResult = await run(BashToolGate, safe, { command: "ls -la" });
  assert.equal(safeResult.content[0].text, "native-run");
  assert.equal(safe.calls.lancet, 0);

  const headless = makeHarness({ lancet: { enabled: false } }, {
    hasUI: false,
    lancetResult: { classification: "not_flagged", score: 0.01, reason: null },
  });
  const headlessResult = await run(BashToolGate, headless, { command: "git push -f" });
  assert.equal(headlessResult.isError, true);
  assert.deepEqual(headlessResult.details, { blocked: true, reason: "no-ui" });
  assert.equal(headless.calls.lancet, 0);

  const review = makeHarness({ lancet: { enabled: false } }, {
    lancetResult: { classification: "risky", score: 0.99, reason: null },
  });
  review.selectResult = "Allow for this session";
  const reviewResult = await run(BashToolGate, review, { command: "git push -f" });
  assert.equal(reviewResult.content[0].text, "native-run");
  assert.equal(review.calls.analyze, 1);
  assert.equal(review.calls.lancet, 0);
});

test("bash: LANCET not_flagged delegates without LLM analysis", async () => {
  const h = makeHarness({}, {
    lancetResult: { classification: "not_flagged", score: 0.1, reason: null },
  });
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.lancet, 1);
  assert.equal(h.calls.analyze, 0);
  assert.equal(h.selectChoices, null);
});

test("bash: LANCET risky blocks before LLM or dialog", async () => {
  const h = makeHarness({}, {
    lancetResult: { classification: "risky", score: 0.95, reason: null },
  });
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.details, {
    blocked: true,
    reason: "lancet-risky",
    source: "lancet",
    score: 0.95,
  });
  assert.equal(h.calls.delegate, 0);
  assert.equal(h.calls.analyze, 0);
  assert.equal(h.selectChoices, null);
});

test("bash: LANCET review continues through the existing approval path", async () => {
  const h = makeHarness({}, {
    analyzeResult: { risk: "medium" },
    lancetResult: { classification: "review", score: 0.5, reason: "uncertainty-band" },
  });
  h.selectResult = "Allow for this session";
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.lancet, 1);
  assert.equal(h.calls.analyze, 1);
  assert.equal(h.calls.delegate, 1);
  assert.ok(h.calls.logs.some((message) => /source=lancet classification=review .*latencyMs=\d+\.\d/u.test(message)));
  assert.ok(h.calls.notify.some((message) => message.includes("Review handoff")));
  assert.ok(h.calls.logs.every((message) => message.length < 400));
});

test("bash: LANCET review LLM allow executes without dialog", async () => {
  const h = makeHarness({}, {
    analyzeResult: { risk: "low", recommend: "allow" },
    lancetResult: { classification: "review", score: 0.5, reason: null },
  });
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.analyze, 1);
  assert.equal(h.calls.delegate, 1);
  assert.equal(h.selectChoices, null);
});

test("bash: LANCET review LLM block wins over delegation", async () => {
  const h = makeHarness({}, {
    analyzeResult: { risk: "low", recommend: "deny" },
    lancetResult: { classification: "review", score: 0.5, reason: null },
  });
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.details, {
    blocked: true,
    reason: "lancet-llm-block",
    source: "smart-approve-llm",
  });
  assert.equal(h.calls.analyze, 1);
  assert.equal(h.calls.delegate, 0);
  assert.equal(h.selectChoices, null);
});

test("bash: failed LANCET review asks in an interactive session", async () => {
  const h = makeHarness({}, {
    analyzeResult: null,
    lancetResult: { classification: "review", score: 0.5, reason: null },
  });
  h.selectResult = "Allow for this session";
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.analyze, 1);
  assert.equal(h.calls.delegate, 1);
  assert.ok(h.selectChoices);
});

test("bash: failed LANCET review blocks headless uncertainty", async () => {
  const h = makeHarness({ mode: "auto", autoInHeadless: true }, {
    hasUI: false,
    analyzeResult: null,
    lancetResult: { classification: "review", score: 0.5, reason: null },
  });
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.details, {
    blocked: true,
    reason: "lancet-llm-uncertain",
    source: "unavailable",
  });
  assert.equal(h.calls.analyze, 1);
  assert.equal(h.calls.delegate, 0);
});

test("bash: LANCET failure blocks instead of falling through", async () => {
  const h = makeHarness({}, { lancetError: new Error("model unavailable") });
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.details, {
    blocked: true,
    reason: "lancet-unavailable",
    source: "unavailable",
  });
  assert.match(r.content[0].text, /model unavailable/);
  assert.equal(h.calls.delegate, 0);
  assert.equal(h.calls.analyze, 0);
});

test("bash: malformed LANCET verdict fails closed", async () => {
  const h = makeHarness({}, {
    lancetResult: { classification: "review", score: Number.NaN, reason: null },
  });
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.details, {
    blocked: true,
    reason: "lancet-invalid",
    source: "unavailable",
  });
  assert.equal(h.calls.delegate, 0);
  assert.ok(h.calls.logs.some((message) => message.includes("classification=invalid score=n/a")));
});

test("bash: persisted LANCET off setting skips an injected scorer", async () => {
  const h = makeHarness({ lancet: { enabled: false } }, {
    lancetResult: { classification: "risky", score: 0.99, reason: null },
  });
  h.selectResult = "Allow for this session";
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.lancet, 0);
  assert.equal(h.calls.analyze, 1);
});

test("bash: enabled LANCET without a scorer fails closed", async () => {
  const h = makeHarness({ lancet: { enabled: true } });
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.details, {
    blocked: true,
    reason: "lancet-unavailable",
    source: "unavailable",
  });
  assert.equal(h.calls.analyze, 0);
  assert.equal(h.calls.delegate, 0);
});

test("bash: UI status failures do not bypass approval enforcement", async () => {
  const h = makeHarness({}, {
    lancetResult: { classification: "review", score: 0.5, reason: "uncertainty-band" },
  });
  h.selectResult = "Allow for this session";
  h.ctx.ui.setStatus = () => {
    throw new Error("status unavailable");
  };
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.delegate, 1);
  assert.ok(h.calls.logs.some((message) => message.includes("UI status failed")));
});

test("bash: headless interactive blocks dangerous commands", async () => {
  const h = makeHarness({}, { hasUI: false });
  const r = await run(BashToolGate, h, { command: "git push -f" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.details, { blocked: true, reason: "no-ui" });
  assert.equal(h.calls.delegate, 0);
});

test("bash: interactive deny blocks", async () => {
  const h = makeHarness();
  h.confirmResult = false;
  const r = await run(BashToolGate, h, { command: "git push -f" });
  assert.equal(r.isError, true);
  assert.equal((r.details as { reason: string }).reason, "git force / mirror push");
  assert.equal(h.calls.delegate, 0);
});

test("bash: interactive select session-allow remembers session", async () => {
  const h = makeHarness();
  h.selectResult = "Allow for this session";
  const r = await run(BashToolGate, h, { command: "git push -f" });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.delegate, 1);
  assert.equal(h.calls.session.length, 1);
  assert.match(h.calls.session[0], /^bash:git push -f:/);
});

test("bash: auto mode AI allow delegates and notifies", async () => {
  const h = makeHarness({ mode: "auto" });
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.delegate, 1);
  assert.equal(h.calls.analyze, 1);
  assert.equal(h.calls.notify.length, 1);
  assert.match(h.calls.notify[0], /Auto-allowed/);
});

test("bash: auto mode AI block returns auto-blocked", async () => {
  const h = makeHarness({ mode: "auto" }, { analyzeResult: { risk: "high", recommend: "allow" } });
  const r = await run(BashToolGate, h, { command: "git push -f" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.details, { blocked: true, reason: "auto" });
  assert.equal(h.calls.delegate, 0);
  assert.equal(h.calls.notify.length, 1);
  assert.match(h.calls.notify[0], /Auto-blocked/);
});

test("bash: home deletion is hard-blocked before LANCET and LLM", async () => {
  const h = makeHarness({ mode: "auto" }, {
    analyzeResult: null,
    lancetResult: { classification: "not_flagged", score: 0.01, reason: null },
  });
  const r = await run(BashToolGate, h, { command: "rm -rf ~" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.details, { blocked: true, reason: blockedLabel(r) });
  assert.equal(h.calls.delegate, 0);
  assert.equal(h.calls.analyze, 0);
  assert.equal(h.calls.lancet, 0);
});

test("bash: auto fallback regex allows review-tier when AI absent", async () => {
  const h = makeHarness({ mode: "auto" }, { analyzeResult: null });
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.delegate, 1);
});

test("bash: auto fallback block blocks review-tier when AI absent", async () => {
  const h = makeHarness({ mode: "auto", autoFallback: "block" }, { analyzeResult: null });
  const r = await run(BashToolGate, h, { command: "git push -f origin feature" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.details, { blocked: true, reason: "auto" });
});

test("bash: git force push to main is deny-tier", async () => {
  const h = makeHarness({ mode: "auto" }, { analyzeResult: null });
  const r = await run(BashToolGate, h, { command: "git push --force origin main" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.details, { blocked: true, reason: "auto" });
});

test("bash: abort after analysis returns aborted, no dialog", async () => {
  const h = makeHarness();
  const r = await run(BashToolGate, h, { command: "git push -f" }, AbortSignal.abort());
  assert.equal(r.content[0].text, "(aborted)");
  assert.deepEqual(r.details, { aborted: true });
  assert.equal(h.calls.delegate, 0);
  assert.equal(h.selectChoices, null);
});

// ── EvalToolGate ─────────────────────────────────────────────────────

test("eval: safe code delegates directly", async () => {
  const h = makeHarness();
  const r = await run(EvalToolGate, h, { language: "js", code: "const x = 1 + 1" });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.delegate, 1);
  assert.equal(h.calls.analyze, 0);
});

test("eval: subprocess + dangerous payload hard-blocks", async () => {
  const h = makeHarness();
  const r = await run(EvalToolGate, h, { language: "js", code: 'await Bun.$`rm -rf /`' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^Blocked:/);
  assert.equal(h.calls.delegate, 0);
  assert.equal(h.calls.analyze, 0);
});

test("eval: subprocess code asks via two-choice dialog", async () => {
  const h = makeHarness();
  h.selectResult = "Allow for this session";
  const r = await run(EvalToolGate, h, {
    language: "py",
    code: "import subprocess\nsubprocess.run(['ls'])",
  });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.delegate, 1);
  assert.ok(h.selectChoices, "select was not used");
  assert.equal(h.selectChoices[0].length, 2);
});

test("eval: auto mode AI-allow delegates subprocess code", async () => {
  const h = makeHarness({ mode: "auto" });
  const r = await run(EvalToolGate, h, { language: "js", code: "Bun.spawn(['ls'])" });
  assert.equal(r.content[0].text, "native-run");
  assert.equal(h.calls.delegate, 1);
  assert.equal(h.calls.analyze, 1);
});
