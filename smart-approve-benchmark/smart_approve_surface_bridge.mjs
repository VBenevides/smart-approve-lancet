#!/usr/bin/env bun
/**
 * Safe bridge for Smart Approve Lancet's non-bash security surfaces.
 *
 * Covered surfaces:
 *   - eval (registered shadow tool)
 *   - hub op:start (tool_call hook)
 *   - write protected paths (tool_call hook)
 *   - edit protected paths (tool_call hook)
 *
 * SECURITY INVARIANT: no benchmark payload is ever executed. Registered-tool
 * delegation through ctx.invokeTool() is stubbed, and hook surfaces are invoked
 * directly without calling their underlying tools.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import process from "node:process";
import { z } from "zod";

const tools = new Map();
const handlers = new Map();
const commands = new Map();
const events = new EventEmitter();

const noop = () => undefined;
const asyncNoop = async () => undefined;

const logger = new Proxy(
  {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child() {
      return logger;
    },
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      return noop;
    },
  },
);

const api = {
  zod: z,
  logger,
  events,
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
  registerCommand(name, definition) {
    commands.set(name, definition);
  },
  registerShortcut: noop,
  registerFlag: noop,
  registerMessageRenderer: noop,
  registerAssistantThinkingRenderer: noop,
  registerComposerShape: noop,
  registerProvider: noop,
  registerFileWriteFallback: noop,
  registerFileDeleteFallback: noop,
  setLabel: noop,
  getFlag: () => undefined,
  getActiveTools: () => [],
  getAllTools: () => [],
  setActiveTools: noop,
  getCommands: () => [],
  getSessionName: () => "smart-approve-surface-benchmark",
  setSessionName: noop,
  sendMessage() {
    throw new Error("surface benchmark: sendMessage called during extension load");
  },
  sendUserMessage() {
    throw new Error("surface benchmark: sendUserMessage called during extension load");
  },
  appendEntry() {
    throw new Error("surface benchmark: appendEntry called during extension load");
  },
  exec() {
    throw new Error("surface benchmark: exec called during extension load");
  },
};

function flattenResultText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .slice(0, 4000);
}

const home = os.homedir();
const fixtureRoot = path.join(home, ".smart-approve-benchmark-fixtures");
const workspace = path.join(fixtureRoot, "workspace");
const protectedTarget = path.join(home, ".ssh", "id_rsa");
const safeTarget = path.join(workspace, "src", "safe-target.txt");
const protectedSymlink = path.join(workspace, "notes.txt");
const safeSymlink = path.join(workspace, "safe-link.txt");

function ensureFile(filePath, text = "a\n") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, text, "utf8");
}

function ensureFixtures() {
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(workspace, "subdir"), { recursive: true });
  for (const file of [
    protectedTarget,
    path.join(home, ".ssh", "id_ed25519"),
    path.join(home, ".kube", "config"),
    path.join(home, ".kube", "README.md"),
    path.join(home, ".aws", "credentials"),
    path.join(home, ".aws", "config"),
    path.join(home, ".git-credentials"),
    path.join(home, ".netrc"),
    path.join(home, ".npmrc"),
    path.join(home, ".pypirc"),
    path.join(home, ".config", "gh", "hosts.yml"),
    path.join(home, ".config", "gcloud", "credentials.db"),
    path.join(workspace, ".env"),
    path.join(workspace, ".env.production"),
    path.join(workspace, ".env.example"),
    path.join(workspace, "README.md"),
    path.join(workspace, "src", "app.ts"),
    safeTarget,
    path.join(workspace, ".ssh-notes"),
    path.join(workspace, "certs", "client.pem.example"),
    path.join(workspace, "docs", "credentials.txt"),
    path.join(workspace, "config", "settings.json"),
    path.join(workspace, "config", "auth.json"),
    path.join(workspace, "secrets", "client.pem"),
    path.join(workspace, "secrets", "private.key"),
    path.join(workspace, "secrets", "client.p12"),
    path.join(workspace, "secrets", "passwords.kdbx"),
  ]) {
    ensureFile(file);
  }

  for (const link of [protectedSymlink, safeSymlink]) {
    try {
      fs.rmSync(link, { force: true });
    } catch {}
  }
  fs.symlinkSync(protectedTarget, protectedSymlink);
  fs.symlinkSync(safeTarget, safeSymlink);
}

function expandString(value) {
  if (typeof value !== "string") return value;
  return value
    .replaceAll("$HOME", home)
    .replaceAll("$WORKSPACE", workspace)
    .replaceAll("$SYMLINK_PROTECTED", protectedSymlink)
    .replaceAll("$SYMLINK_SAFE", safeSymlink);
}

function expandValue(value) {
  if (typeof value === "string") return expandString(value);
  if (Array.isArray(value)) return value.map(expandValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandValue(v)]));
  }
  return value;
}

function makeContext({ interactive = false } = {}) {
  let delegated = false;
  let asked = false;

  const ui = {
    notify: noop,
    setStatus: noop,
    clearStatus: noop,
    confirm: async () => {
      asked = true;
      return false;
    },
    select: async (_title, _message, options) => {
      asked = true;
      if (Array.isArray(options) && options.length) {
        const last = options[options.length - 1];
        if (last && typeof last === "object" && "value" in last) return last.value;
        return last;
      }
      return "deny";
    },
    input: async () => {
      asked = true;
      return undefined;
    },
    editor: async () => {
      asked = true;
      return undefined;
    },
  };

  const ctx = {
    hasUI: interactive,
    cwd: workspace,
    agent: {
      kind: interactive ? "main" : "sub",
      id: "smart-approve-surface-benchmark",
      name: "smart-approve-surface-benchmark",
      depth: 0,
    },
    ui,
    invokeTool: async (_params, _options) => {
      delegated = true;
      return {
        content: [{ type: "text", text: "SMART_APPROVE_BENCHMARK_DELEGATE_SUPPRESSED" }],
        details: { benchmark: true, executed: false },
      };
    },
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
    },
    modelRegistry: undefined,
    model: undefined,
    models: [],
    localProtocolOptions: undefined,
    getContextUsage: () => undefined,
    getAsyncJobSnapshot: () => null,
    compact: asyncNoop,
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasQueuedMessages: () => false,
    abort: noop,
    shutdown: asyncNoop,
    getSystemPrompt: () => "",
    addAdditionalContext: noop,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
  };

  return {
    ctx,
    wasDelegated: () => delegated,
    wasAsked: () => asked,
  };
}

async function loadSmartApprove() {
  const mod = await import("smart-approve-lancet/dist/index.js");
  const factory = mod.default ?? mod;
  if (typeof factory !== "function") {
    throw new TypeError("smart-approve-lancet default export is not an extension factory");
  }
  await factory(api);
  return {
    evalTool: tools.get("eval"),
    toolCallHandlers: handlers.get("tool_call") ?? [],
  };
}

ensureFixtures();

let loaded;
try {
  loaded = await loadSmartApprove();
} catch (error) {
  process.stderr.write(`Failed to load smart-approve-lancet: ${error?.stack ?? error}\n`);
  process.exit(1);
}

let packageVersion = "unknown";
try {
  const pkg = await import("smart-approve-lancet/package.json", { with: { type: "json" } });
  packageVersion = pkg.default?.version ?? pkg.version ?? "unknown";
} catch {}

process.stdout.write(
  `${JSON.stringify({
    type: "ready",
    package: "smart-approve-lancet",
    version: packageVersion,
    surfaces: {
      eval: Boolean(loaded.evalTool),
      tool_call_handlers: loaded.toolCallHandlers.length,
    },
  })}\n`,
);

async function runHookSurface(id, surface, rawInput) {
  const input = expandValue(rawInput);
  const { ctx, wasAsked } = makeContext({ interactive: true });
  let event = {
    type: "tool_call",
    toolName: surface,
    toolCallId: id,
    input,
  };
  let blocked = false;
  let reason = "";

  for (const handler of loaded.toolCallHandlers) {
    const result = await handler(event, ctx);
    if (!result) continue;
    if (result.block) {
      blocked = true;
      reason = String(result.reason ?? "");
      break;
    }
    if (result.input && typeof result.input === "object") {
      event = { ...event, input: result.input };
    }
  }

  return {
    decision: blocked || wasAsked() ? "stop" : "allow",
    delegated: false,
    asked: wasAsked(),
    blocked,
    reason,
    result_text: reason,
    normalized_input: event.input,
  };
}

async function runEval(id, rawInput) {
  if (!loaded.evalTool || typeof loaded.evalTool.execute !== "function") {
    throw new Error("smart-approve-lancet did not register an eval tool");
  }
  const input = expandValue(rawInput);
  const { ctx, wasDelegated, wasAsked } = makeContext({ interactive: false });
  const controller = new AbortController();
  const result = await loaded.evalTool.execute(id, input, controller.signal, undefined, ctx);
  const delegated = wasDelegated();
  return {
    decision: delegated ? "allow" : "stop",
    delegated,
    asked: wasAsked(),
    blocked: !delegated,
    reason: "",
    result_text: flattenResultText(result),
    normalized_input: input,
  };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;

  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ id: null, decision: "error", error: `invalid JSON: ${String(error)}` })}\n`,
    );
    continue;
  }

  const id = String(request.id ?? "");
  const surface = String(request.surface ?? "");
  const input = request.input;
  if (!id || !["eval", "hub", "write", "edit"].includes(surface) || !input || typeof input !== "object") {
    process.stdout.write(
      `${JSON.stringify({ id, decision: "error", error: "request must contain id, surface=(eval|hub|write|edit), and object input" })}\n`,
    );
    continue;
  }

  const started = performance.now();
  try {
    const outcome =
      surface === "eval"
        ? await runEval(id, input)
        : await runHookSurface(id, surface, input);
    process.stdout.write(
      `${JSON.stringify({
        id,
        surface,
        ...outcome,
        executed: false,
        latency_ms: performance.now() - started,
      })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        id,
        surface,
        decision: "error",
        executed: false,
        latency_ms: performance.now() - started,
        error: String(error?.stack ?? error),
      })}\n`,
    );
  }
}
