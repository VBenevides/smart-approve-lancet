import type { ExtensionCtx } from "../types.ts";
import type { LoggerLike } from "../logger.ts";
import type { LancetResult } from "./classifier.ts";
import type { SmartApproveConfig } from "../config.ts";
import {
  installModel as installPinnedModel,
  modelDirectory,
  modelVerified,
  type InstallModelOptions,
  type InstallResult,
} from "./model-store.ts";
import { classifierLoaded, createLancetScorer, releaseClassifier } from "./runtime.ts";

export interface LancetConfigStoreLike {
  readonly config: SmartApproveConfig;
  update(partial: Partial<SmartApproveConfig>): void;
  persist(): boolean;
}

export interface LancetScorerLike {
  score(command: string, shell: "bash", signal?: AbortSignal): Promise<LancetResult>;
}

export type InstallModelFunction = (options: InstallModelOptions) => Promise<InstallResult>;

export interface LancetCommandDeps {
  configStore: LancetConfigStoreLike;
  logger: LoggerLike;
  agentDir: string;
  scorer?: LancetScorerLike;
  installModel?: InstallModelFunction;
  classifierLoaded?: () => boolean;
}

/** Handles explicit LANCET lifecycle actions without executing the checked command. */
export class LancetCommandHandler {
  private readonly directory: string;
  private readonly scorer: LancetScorerLike;
  private readonly installModel: InstallModelFunction;
  private readonly isClassifierLoaded: () => boolean;
  constructor(private readonly deps: LancetCommandDeps) {
    this.directory = modelDirectory(deps.agentDir);
    this.scorer = deps.scorer ?? createLancetScorer(this.directory);
    this.installModel = deps.installModel ?? installPinnedModel;
    this.isClassifierLoaded = deps.classifierLoaded ?? classifierLoaded;
  }

  async handle(args: unknown, ctx: ExtensionCtx): Promise<void> {
    const raw = String(args ?? "").trim();
    const separator = raw.search(/\s/u);
    const action = (separator < 0 ? raw : raw.slice(0, separator)).toLowerCase();
    const rest = separator < 0 ? "" : raw.slice(separator).trim();

    switch (action) {
      case "status":
        this.notify(ctx, this.status(), "info");
        return;
      case "setup":
        await this.setup(ctx);
        return;
      case "on":
        this.enable(ctx);
        return;
      case "off":
        await this.disable(ctx);
        return;
      case "check":
        await this.check(rest, ctx);
        return;
      default:
        this.notify(ctx, this.help(), "info");
    }
  }

  status(): string {
    const enabled = this.deps.configStore.config.lancet?.enabled === true;
    if (!enabled) {
      return [
        "Smart Approve LANCET: OFF",
        "Smart Approve is using its default review flow.",
      ].join("\n");
    }

    return [
      "Smart Approve LANCET: ON",
      `Model: ${this.isClassifierLoaded() ? "loaded" : "lazy / not loaded yet"}`,
      "",
      "Policy:",
      "  NOT_FLAGGED → allow",
      "  REVIEW      → Smart Approve LLM",
      "  RISKY       → block",
    ].join("\n");
  }

  private async setup(ctx: ExtensionCtx): Promise<void> {
    this.deps.logger.log("lancet setup started");
    try {
      const result = await this.installModel({
        agentDir: this.deps.agentDir,
        onProgress: (phase) => this.deps.logger.log(`lancet setup: ${phase}`),
      });
      const message = result.reason === "already-current"
        ? "[Smart Approve LANCET] Model is already installed and verified."
        : "[Smart Approve LANCET] Model downloaded, verified, and installed.";
      this.deps.logger.log(`lancet setup completed: ${result.reason}`);
      this.notify(ctx, message, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.log(`lancet setup failed: ${message}`);
      this.notify(ctx, `[Smart Approve LANCET] Setup failed: ${message}`, "warning");
    }
  }

  private enable(ctx: ExtensionCtx): void {
    if (!modelVerified(this.directory)) {
      const message = "[Smart Approve LANCET] Cannot enable: the pinned v0.4.2 model is not verified. Run /smart-approve-lancet setup first.";
      this.deps.logger.log("lancet enable refused: model is not verified");
      this.notify(ctx, message, "warning");
      return;
    }

    this.deps.configStore.update({ lancet: { enabled: true } });
    const persisted = this.deps.configStore.persist();
    this.deps.logger.log(`lancet enabled${persisted ? "" : " (not persisted)"}`);
    this.notify(
      ctx,
      persisted
        ? "[Smart Approve LANCET] Enabled. Behavior-positive Bash commands now fail closed if LANCET is unavailable."
        : "[Smart Approve LANCET] Enabled for this session, but the setting could not be saved.",
      persisted ? "info" : "warning",
    );
  }

  private async disable(ctx: ExtensionCtx): Promise<void> {
    this.deps.configStore.update({ lancet: { enabled: false } });
    const persisted = this.deps.configStore.persist();
    try {
      await releaseClassifier(this.directory);
    } catch (error) {
      this.deps.logger.log(`lancet release after off failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.deps.logger.log(`lancet disabled${persisted ? "" : " (not persisted)"}`);
    this.notify(
      ctx,
      persisted
        ? "[Smart Approve LANCET] Disabled. Bash uses the existing Smart Approve gate only."
        : "[Smart Approve LANCET] Disabled for this session, but the setting could not be saved.",
      persisted ? "info" : "warning",
    );
  }

  private async check(command: string, ctx: ExtensionCtx): Promise<void> {
    if (!command) {
      this.notify(ctx, "Usage: /smart-approve-lancet check <command>", "warning");
      return;
    }

    try {
      const verdict = await this.scorer.score(command, "bash");
      this.notify(ctx, this.formatCheck(command, verdict), "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.log(`lancet check failed: ${message}`);
      this.notify(ctx, `[Smart Approve LANCET] Check unavailable: ${message}`, "warning");
    }
  }

  private formatCheck(command: string, verdict: LancetResult): string {
    const preview = command.length > 120 ? `${command.slice(0, 117)}...` : command;
    const score = verdict.score === null ? "n/a" : verdict.score.toFixed(4);
    const reason = verdict.reason ? `, reason=${verdict.reason}` : "";
    return `[Smart Approve LANCET] ${verdict.classification}, score=${score}${reason}; command=${preview}`;
  }

  private help(): string {
    return "Usage: /smart-approve-lancet status | setup | on | off | check <command>";
  }

  private notify(ctx: ExtensionCtx, message: string, level: "info" | "warning"): void {
    try {
      ctx.ui.notify?.(message, level);
    } catch (error) {
      this.deps.logger.log(`lancet UI notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      ctx.ui.setStatus("smart-approve-lancet", this.deps.configStore.config.lancet?.enabled ? "on" : "off");
    } catch (error) {
      this.deps.logger.log(`lancet UI status failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
