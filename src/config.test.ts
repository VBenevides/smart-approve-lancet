import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { ConfigStore } from "./config.ts";
import type { ExtensionCtx } from "./types.ts";
import { LancetCommandHandler } from "./lancet/commands.ts";
import type { LancetResult } from "./lancet/classifier.ts";
import type { LoggerLike } from "./logger.ts";
import type { InstallModelFunction } from "./lancet/commands.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "smart-approve-config-"));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

const logger: LoggerLike = { log: () => undefined };

function context(notices: string[]): ExtensionCtx {
  return {
    hasUI: true,
    ui: {
      confirm: async () => false,
      setStatus: () => undefined,
      notify: (message) => notices.push(message),
    },
  };
}

function riskyVerdict(): LancetResult {
  return {
    classification: "risky",
    score: 0.99,
    reviewThreshold: 0.5,
    riskyThreshold: 0.9,
    reason: null,
    experimental: true,
    executionAuthorized: false,
  };
}

describe("LANCET configuration", () => {
  test("defaults disabled and preserves unknown fields when toggled", () => {
    const directory = path.join(temporary, "merge");
    fs.mkdirSync(directory, { recursive: true });
    const configPath = path.join(directory, "smart-approve.json");
    fs.writeFileSync(configPath, JSON.stringify({
      lancet: { enabled: true },
      customField: { keep: true },
      protectedPaths: ["custom.key"],
    }));

    const loaded = new ConfigStore(logger, directory);
    assert.equal(loaded.config.lancet?.enabled, true);
    loaded.update({ lancet: { enabled: false } });
    assert.equal(loaded.persist(), true);

    const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved.customField, { keep: true });
    assert.deepEqual(saved.lancet, { enabled: false });
    assert.deepEqual(saved.protectedPaths, ["custom.key"]);

    const defaults = new ConfigStore(logger, path.join(temporary, "defaults"));
    assert.equal(defaults.config.lancet?.enabled, false);
  });
});

describe("LANCET lifecycle commands", () => {
  test("status reports exact disabled, lazy, and loaded states without initialization", () => {
    const directory = path.join(temporary, "status");
    const store = new ConfigStore(logger, directory);
    let loadedProbeCalls = 0;
    const lazyHandler = new LancetCommandHandler({
      configStore: store,
      logger,
      agentDir: directory,
      classifierLoaded: () => {
        loadedProbeCalls++;
        return false;
      },
    });

    assert.equal(
      lazyHandler.status(),
      "Smart Approve LANCET: OFF\nSmart Approve is using its default review flow.",
    );
    assert.equal(loadedProbeCalls, 0);

    store.update({ lancet: { enabled: true } });
    assert.equal(
      lazyHandler.status(),
      [
        "Smart Approve LANCET: ON",
        "Model: lazy / not loaded yet",
        "",
        "Policy:",
        "  NOT_FLAGGED → allow",
        "  REVIEW      → Smart Approve LLM",
        "  RISKY       → block",
      ].join("\n"),
    );
    assert.equal(loadedProbeCalls, 1);

    const loadedHandler = new LancetCommandHandler({
      configStore: store,
      logger,
      agentDir: directory,
      classifierLoaded: () => true,
    });
    assert.equal(
      loadedHandler.status(),
      [
        "Smart Approve LANCET: ON",
        "Model: loaded",
        "",
        "Policy:",
        "  NOT_FLAGGED → allow",
        "  REVIEW      → Smart Approve LLM",
        "  RISKY       → block",
      ].join("\n"),
    );
  });

  test("refuses on before verification and setup uses the injected installer", async () => {
    const directory = path.join(temporary, "commands-on");
    const store = new ConfigStore(logger, directory);
    const notices: string[] = [];
    let setupCalls = 0;
    const installModel: InstallModelFunction = async (options) => {
      setupCalls++;
      options.onProgress?.("verify");
      return { installed: true, reason: "downloaded", directory: path.join(directory, "model") };
    };
    const handler = new LancetCommandHandler({ configStore: store, logger, agentDir: directory, installModel });
    const ctx = context(notices);

    await handler.handle("on", ctx);
    assert.equal(store.config.lancet?.enabled, false);
    assert.match(notices.at(-1) ?? "", /Cannot enable/u);

    await handler.handle("setup", ctx);
    assert.equal(setupCalls, 1);
    assert.match(notices.at(-1) ?? "", /downloaded/u);
  });

  test("off persists immediately and check scores without executing the command", async () => {
    const directory = path.join(temporary, "commands-off");
    const store = new ConfigStore(logger, directory);
    store.update({ lancet: { enabled: true } });
    assert.equal(store.persist(), true);
    let checked = "";
    const handler = new LancetCommandHandler({
      configStore: store,
      logger,
      agentDir: directory,
      scorer: {
        score: async (command) => {
          checked = command;
          return riskyVerdict();
        },
      },
    });
    const notices: string[] = [];
    const ctx = context(notices);
    ctx.ui.setStatus = () => {
      throw new Error("status unavailable");
    };

    await handler.handle("off", ctx);
    assert.equal(store.config.lancet?.enabled, false);
    const saved = JSON.parse(fs.readFileSync(store.configPath, "utf8")) as { lancet?: { enabled?: boolean } };
    assert.equal(saved.lancet?.enabled, false);

    await handler.handle(`check ${"x".repeat(200)}`, ctx);
    assert.equal(checked, "x".repeat(200));
    assert.match(notices.at(-1) ?? "", /risky, score=0\.9900/u);
    assert.ok((notices.at(-1) ?? "").length < 180);
  });
});
