#!/usr/bin/env bun
/**
 * Safe JSONL bridge between the Python benchmark and the real smart-approve package.
 *
 * SECURITY INVARIANT: dataset commands are NEVER executed. The only native-tool
 * delegation surface, ctx.invokeTool(), is replaced by a recorder that returns a
 * synthetic result.
 */

import { EventEmitter } from "node:events";
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
  getSessionName: () => "smart-approve-benchmark",
  setSessionName: noop,

  // Runtime actions must not be used while an extension is loading. Throwing here
  // makes accidental side effects obvious instead of silently accepting them.
  sendMessage() {
    throw new Error("smart-approve benchmark: sendMessage called during extension load");
  },
  sendUserMessage() {
    throw new Error("smart-approve benchmark: sendUserMessage called during extension load");
  },
  appendEntry() {
    throw new Error("smart-approve benchmark: appendEntry called during extension load");
  },
  exec() {
    throw new Error("smart-approve benchmark: exec called during extension load");
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

function makeContext() {
  let delegated = false;

  const ui = {
    notify: noop,
    setStatus: noop,
    clearStatus: noop,
    confirm: async () => {
      throw new Error("benchmark invariant violated: headless Smart Approve requested UI.confirm");
    },
    select: async () => {
      throw new Error("benchmark invariant violated: headless Smart Approve requested UI.select");
    },
  };

  const ctx = {
    // Headless prevents interactive dialogs and model review. In upstream default
    // mode, commands that require review are stopped in headless/subagent contexts.
    hasUI: false,
    cwd: "/tmp/smart-approve-benchmark",
    agent: {
      kind: "sub",
      id: "smart-approve-benchmark",
      name: "smart-approve-benchmark",
      depth: 0,
    },
    ui,

    // CRITICAL: never execute the submitted command.
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
  };
}

async function loadSmartApprove() {
  const mod = await import("smart-approve");
  const factory = mod.default ?? mod;
  if (typeof factory !== "function") {
    throw new TypeError("smart-approve default export is not an extension factory");
  }
  await factory(api);
  const bash = tools.get("bash");
  if (!bash || typeof bash.execute !== "function") {
    throw new Error(
      `smart-approve did not register a bash tool; registered tools: ${[...tools.keys()].join(", ")}`,
    );
  }
  return bash;
}

let bashTool;
try {
  bashTool = await loadSmartApprove();
} catch (error) {
  process.stderr.write(`Failed to load smart-approve: ${error?.stack ?? error}\n`);
  process.exit(1);
}

let packageVersion = "unknown";
try {
  const pkg = await import("smart-approve/package.json", { with: { type: "json" } });
  packageVersion = pkg.default?.version ?? pkg.version ?? "unknown";
} catch {
  // package.json may not be exported by the package; version is informational only.
}

process.stdout.write(
  `${JSON.stringify({ type: "ready", package: "smart-approve", version: packageVersion })}\n`,
);

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
  const command = request.command;
  if (typeof command !== "string") {
    process.stdout.write(
      `${JSON.stringify({ id, decision: "error", error: "command must be a string" })}\n`,
    );
    continue;
  }

  const { ctx, wasDelegated } = makeContext();
  const started = performance.now();
  try {
    const controller = new AbortController();
    const result = await bashTool.execute(
      id,
      { command },
      controller.signal,
      undefined,
      ctx,
    );
    const latencyMs = performance.now() - started;
    const delegated = wasDelegated();

    process.stdout.write(
      `${JSON.stringify({
        id,
        decision: delegated ? "allow" : "stop",
        delegated,
        executed: false,
        latency_ms: latencyMs,
        result_text: flattenResultText(result),
      })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        id,
        decision: "error",
        delegated: wasDelegated(),
        executed: false,
        latency_ms: performance.now() - started,
        result_text: "",
        error: String(error?.stack ?? error),
      })}\n`,
    );
  }
}
