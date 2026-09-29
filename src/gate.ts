/**
 * Smart Approve — shared approval gate (template method).
 *
 * ToolGate owns the decision pipeline that was previously bash-only:
 *
 *   hard-block -> LANCET (Bash, when enabled) -> allowlist -> no-behavior
 *   -> headless check -> LLM analysis -> verdict (auto policy or interactive
 *   dialog) -> remember -> delegate
 *
 * Concrete gates (bash, eval) supply the three tool-specific hooks:
 * analyze() / buildKey() / delegate(), plus the schema and subject
 * extraction.  The flow itself never varies, so every covered tool gets
 * identical approval semantics.
 */

import type {
  ExtensionAPI,
  ExtensionCtx,
  AgentToolResult,
  DangerAnalysis,
  RiskAnalysis,
  ZodLike,
} from "./types";
import type { SmartApproveConfig } from "./config";
import type { AutoDecisionPolicy } from "./policy";
import type { LoggerLike } from "./logger";
import type { I18n, Lang } from "./i18n";
import { confirmWithRemember, formatAnalysis } from "./dialog";

/** Narrow collaborator contracts (dependency inversion): concrete classes
 *  satisfy these structurally; tests can supply stubs. */
export interface AllowListLike {
  isAllowed(tool: string, content: string, cwd: string): boolean;
  rememberSession(tool: string, content: string, cwd: string): void;
  rememberPermanent(tool: string, content: string, cwd: string): void;
}

export interface ContextGathererLike {
  gather(ctx: ExtensionCtx, maxChars: number): unknown;
  format(sessionCtx: unknown, t: I18n): string;
}

export interface ModelInvokerLike {
  analyze(
    subject: string,
    subjectLabel: string,
    behaviorLabels: string[],
    contextSection: string,
    t: I18n,
    model: string,
    signal?: AbortSignal,
  ): Promise<RiskAnalysis | null>;
}

export type LancetClassification = "risky" | "not_flagged" | "review";

export interface LancetVerdict {
  classification: LancetClassification;
  score: number | null;
  reason: string | null;
}

/** Narrow local-model contract; the gate owns policy, the scorer owns inference. */
export interface LancetGuardLike {
  score(command: string, shell: "bash", signal?: AbortSignal): Promise<LancetVerdict>;
}


/** Shared collaborators injected into every gate instance. */
export interface GateDeps {
  config: SmartApproveConfig;
  allowList: AllowListLike;
  contextGatherer: ContextGathererLike;
  modelInvoker: ModelInvokerLike;
  /** Optional local LANCET scorer; only BashToolGate opts into it. */
  lancet?: LancetGuardLike;
  policy: AutoDecisionPolicy;
  logger: LoggerLike;
  lang: Lang;
  t: I18n;
}

/** Tool update callback, matching ToolDefinition.execute's onUpdate. */
export type ToolUpdateCallback =
  ((update: { content: unknown[]; details?: unknown }) => void) | undefined;

function scoreText(score: unknown): string {
  return typeof score === "number" && Number.isFinite(score) ? score.toFixed(4) : "n/a";
}

function logText(value: unknown): string {
  return String(value).replace(/\s+/gu, " ").slice(0, 160);
}

export abstract class ToolGate {
  // Public so concrete gates can be constructed by the orchestrator and
  // tests; the class is abstract, so it cannot be instantiated directly.
  constructor(protected readonly deps: GateDeps) {}

  // ── Tool identity (per concrete gate) ──────────────────────────────

  /** Tool name; must shadow a native built-in for delegation to work. */
  abstract readonly toolName: string;
  protected abstract readonly toolLabel: string;
  protected abstract readonly toolDescription: string;
  /** Mirrors the native tool's strict flag (undefined = not set). */
  protected get strict(): boolean | undefined { return undefined; }
  /** "both" = session+permanent remember; "session" = session only. */
  protected abstract readonly rememberScope: "session" | "both";

  // ── Tool-specific hooks (per concrete gate) ────────────────────────

  /** zod schema builder (the host-injected zod is passed in). */
  protected abstract buildSchema(z: ZodLike): unknown;
  /** Extract the analyzable subject string from raw tool params. */
  protected abstract extractSubject(params: unknown): string;
  /** Working directory used for allowlist scoping. */
  protected abstract resolveCwd(params: unknown, ctx: ExtensionCtx): string;
  /** Per-tool behavior analysis. */
  protected abstract analyze(subject: string): DangerAnalysis;
  /** Allowlist key derived from the subject. */
  protected abstract buildKey(subject: string): string;
  /** Display label for the subject ("Command" / "Code"). */
  protected abstract subjectDisplayLabel(): string;
  /** LLM prompt section label for the subject. */
  protected abstract promptSubjectLabel(): string;
  /** Run the native tool with the original params. */
  protected abstract delegate(
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ToolUpdateCallback,
    ctx: ExtensionCtx,
  ): Promise<AgentToolResult>;
  /** Empty-subject path; default passes through to the native tool. */
  protected onEmpty(
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ToolUpdateCallback,
    ctx: ExtensionCtx,
  ): Promise<AgentToolResult> {
    return this.delegate(params, signal, onUpdate, ctx);
  }

  /** Whether this gate may consult the optional local LANCET scorer. */
  protected usesLancet(): boolean { return false; }

  // ── Registration ───────────────────────────────────────────────────

  /** Register this gate as a custom tool shadowing the native built-in. */
  register(pi: ExtensionAPI): void {
    pi.registerTool({
      name: this.toolName,
      label: this.toolLabel,
      description: this.toolDescription,
      parameters: this.buildSchema(pi.zod),
      approval: "exec",
      strict: this.strict,
      execute: (toolCallId, params, signal, onUpdate, ctx) =>
        this.execute(params, signal, onUpdate, ctx),
    });
  }

  // ── Template method: the shared decision pipeline ──────────────────

  async execute(
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ToolUpdateCallback,
    ctx: ExtensionCtx,
  ): Promise<AgentToolResult> {
    const { config, allowList, contextGatherer, modelInvoker, lancet, policy, logger, lang, t } = this.deps;

    const subject = this.extractSubject(params);
    if (!subject.trim()) {
      logger.log(`${this.toolName}: empty subject, passing through`);
      return this.onEmpty(params, signal, onUpdate, ctx);
    }

    const effectiveCwd = this.resolveCwd(params, ctx);
    const hasUI = ctx.hasUI;
    logger.log(`${this.toolName}: subject="${subject.slice(0, 80)}" cwd=${effectiveCwd} hasUI=${hasUI}`);

    const analysis = this.analyze(subject);
    const label = analysis.labels[0]?.[lang] || analysis.labels[0]?.en || "danger";
    const subjectLabel = this.subjectDisplayLabel();

    // 1. Hard-block wins over the allowlist (entries can predate a rule
    //    upgrade or be hand-edited into the allow file).
    if (analysis.hardBlocked) {
      logger.log(`${this.toolName}: source=rules hard-blocked (${label})`);
      return this.textError(`Blocked: ${label}\n${subjectLabel}: ${subject}`, { blocked: true, reason: label });
    }

    // 2. LANCET is a universal second opinion after hard blocks. A
    //    missing/invalid result fails closed; it never falls through to the
    //    existing review path as if the model had not run.
    let lancetReview = false;
    const lancetEnabled = config.lancet?.enabled === true;
    if (this.usesLancet() && lancetEnabled) {
      if (!lancet) {
        logger.log(`${this.toolName}: source=unavailable error=LANCET scorer not configured`);
        return this.textError(
          `Blocked: LANCET unavailable (scorer not configured)\n${subjectLabel}: ${subject}`,
          { blocked: true, reason: "lancet-unavailable", source: "unavailable" },
        );
      }
      const inferenceStartedAt = performance.now();
      let verdict: LancetVerdict;
      try {
        verdict = await lancet.score(subject, "bash", signal);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.log(
          `${this.toolName}: source=unavailable latencyMs=${(performance.now() - inferenceStartedAt).toFixed(1)} error=${logText(message)}`,
        );
        return this.textError(
          `Blocked: LANCET unavailable (${message})\n${subjectLabel}: ${subject}`,
          { blocked: true, reason: "lancet-unavailable", source: "unavailable" },
        );
      }

      const latencyMs = (performance.now() - inferenceStartedAt).toFixed(1);
      const score = scoreText(verdict?.score);
      const reason = typeof verdict?.reason === "string" && verdict.reason
        ? logText(verdict.reason)
        : "none";
      if (
        !verdict ||
        (verdict.classification !== "not_flagged" &&
          verdict.classification !== "review" &&
          verdict.classification !== "risky") ||
        typeof verdict.score !== "number" ||
        !Number.isFinite(verdict.score)
      ) {
        logger.log(
          `${this.toolName}: source=unavailable classification=invalid score=${score} reason=${reason} latencyMs=${latencyMs}`,
        );
        return this.textError(
          `Blocked: LANCET returned an invalid verdict\n${subjectLabel}: ${subject}`,
          { blocked: true, reason: "lancet-invalid", source: "unavailable" },
        );
      }

      logger.log(
        `${this.toolName}: source=lancet classification=${verdict.classification} score=${score} reason=${reason} latencyMs=${latencyMs}`,
      );
      if (verdict.classification === "risky") {
        return this.textError(
          `Blocked: LANCET flagged the command as risky (score=${score})\n${subjectLabel}: ${subject}`,
          {
            blocked: true,
            reason: "lancet-risky",
            source: "lancet",
            score: verdict.score,
          },
        );
      }

      if (verdict.classification === "review") {
        lancetReview = true;
        this.safeNotify(
          ctx,
          `[Smart Approve LANCET] Review handoff: Smart Approve approval required (score=${score}${verdict.reason ? `, reason=${logText(verdict.reason)}` : ""}).`,
          "info",
        );
      }
    }

    // 3. Allowlist hit → delegate directly, unless LANCET requires review.
    if (
      !lancetReview &&
      config.rememberDecisions &&
      allowList.isAllowed(this.toolName, this.buildKey(subject), effectiveCwd)
    ) {
      logger.log(`${this.toolName}: source=allowlist, delegating to native`);
      return this.delegate(params, signal, onUpdate, ctx);
    }

    // 4. No dangerous behavior → delegate directly (zero interruption),
    //    unless LANCET requires review.
    if (!lancetReview && analysis.behaviors.length === 0) {
      return this.delegate(params, signal, onUpdate, ctx);
    }

    // 5. Dangerous but reviewable. Headless contexts block unless auto
    //    mode is configured to decide by AI.
    const autoMode = config.mode === "auto";
    if (!hasUI && !(autoMode && config.autoInHeadless)) {
      logger.log(`${this.toolName}: blocked (no UI) — ${label}`);
      return this.textError(`${t.blockedNoUI(label)}\n${subjectLabel}: ${subject}`, { blocked: true, reason: "no-ui" });
    }

    // 6. LLM risk analysis (optional; inside execute(), free of the 30s
    //    EXTENSION_HANDLER_TIMEOUT_MS handler budget).
    let aiResult: RiskAnalysis | null = null;
    let analysisText: string | null = null;
    if (config.llmAnalysis) {
      this.safeStatus(ctx, "smart-approve", t.analyzing);
      try {
        const sessionCtx = contextGatherer.gather(ctx, config.contextMaxChars);
        const contextSection = contextGatherer.format(sessionCtx, t);
        const behaviorLabels = analysis.labels.map((l) => l[lang] || l.en);
        logger.log(`${this.toolName}: analyzeRisk subject="${subject.slice(0, 80)}" behaviors=[${behaviorLabels.join(",")}]`);
        aiResult = await modelInvoker.analyze(
          subject, this.promptSubjectLabel(), behaviorLabels, contextSection, t, config.model, signal,
        );
        analysisText = formatAnalysis(aiResult, t);
        logger.log(`${this.toolName}: analysisText=${analysisText ? "OK" : "null"}`);
      } catch (e) {
        logger.log(`${this.toolName}: LLM analysis failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.safeStatus(ctx, "smart-approve", undefined);
      }
    }

    // 6a. Interrupted while analyzing → abort, no decision.
    if (signal?.aborted) {
      logger.log(`${this.toolName}: aborted during analysis`);
      return { content: [{ type: "text", text: "(aborted)" }], details: { aborted: true } };
    }

    // 7. LANCET review resolves the LLM result to allow/block/ask. A failed
    //    or uncertain review falls back to a user confirmation when UI exists.
    if (lancetReview) {
      const reviewVerdict = policy.decideReview(aiResult);
      logger.log(`${this.toolName}: LANCET review verdict=${reviewVerdict ?? "unavailable"} (${label})`);
      if (reviewVerdict === "allow") {
        return this.delegate(params, signal, onUpdate, ctx);
      }
      if (reviewVerdict === "block") {
        return this.textError(
          `Blocked: Smart Approve LLM denied the command\n${subjectLabel}: ${subject}`,
          { blocked: true, reason: "lancet-llm-block", source: "smart-approve-llm" },
        );
      }
      if (!hasUI) {
        logger.log(`${this.toolName}: blocked (LANCET review uncertain without UI) — ${label}`);
        return this.textError(
          `${t.blockedNoUI(label)}\n${subjectLabel}: ${subject}`,
          { blocked: true, reason: "lancet-llm-uncertain", source: "unavailable" },
        );
      }
    } else if (autoMode) {
      const decision = policy.decide(aiResult, analysis.denyTier);
      logger.log(`${this.toolName}: auto decision=${decision.verdict} reason=${decision.reason} (${label})`);
      if (decision.verdict === "allow") {
        this.safeNotify(ctx, t.autoAllowed(label), "info");
        return this.delegate(params, signal, onUpdate, ctx);
      }
      this.safeNotify(ctx, t.autoBlocked(label), "warning");
      return this.textError(`${t.autoBlocked(label)}\n${subjectLabel}: ${subject}`, { blocked: true, reason: "auto" });
    }

    const title = t.confirmTitle(label);
    const body = analysisText
      ? `${analysisText}\n\n────────\n${subjectLabel}: ${subject}\n\n${t.allowPrompt}`
      : `${t.analysisUnavailable}\n\n${subjectLabel}: ${subject}\n\n${t.allowPrompt}`;

    const decision = await confirmWithRemember(ctx, title, body, t, config.rememberDecisions, this.rememberScope);
    if (!decision.ok) {
      logger.log(`${this.toolName}: user denied — ${label}`);
      return this.textError(t.userDenied(label), { denied: true, reason: label });
    }

    if (decision.remember === "session") {
      allowList.rememberSession(this.toolName, this.buildKey(subject), effectiveCwd);
    } else if (decision.remember === "permanent") {
      allowList.rememberPermanent(this.toolName, this.buildKey(subject), effectiveCwd);
    }

    // 7a. Interrupted after approval → do not execute.
    if (signal?.aborted) {
      logger.log(`${this.toolName}: aborted after approval, not executing`);
      return { content: [{ type: "text", text: "(aborted)" }], details: { aborted: true } };
    }

    // 8. Execute — delegate to the native tool.
    logger.log(`${this.toolName}: approved, delegating to native`);
    return this.delegate(params, signal, onUpdate, ctx);
  }

  private safeStatus(ctx: ExtensionCtx, id: string, text: string | undefined): void {
    try {
      ctx.ui.setStatus(id, text);
    } catch (error) {
      this.deps.logger.log(`${this.toolName}: UI status failed — ${logText(error instanceof Error ? error.message : error)}`);
    }
  }

  private safeNotify(ctx: ExtensionCtx, message: string, level: "info" | "warning"): void {
    try {
      ctx.ui.notify?.(message, level);
    } catch (error) {
      this.deps.logger.log(`${this.toolName}: UI notification failed — ${logText(error instanceof Error ? error.message : error)}`);
    }
  }

  private textError(text: string, details: Record<string, unknown>): AgentToolResult {
    return { content: [{ type: "text", text }], details, isError: true };
  }
}
