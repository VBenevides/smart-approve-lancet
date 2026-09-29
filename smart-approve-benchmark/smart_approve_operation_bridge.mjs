#!/usr/bin/env bun
/**
 * Safe bridge for Smart Approve's non-bash OMP surfaces.
 *
 * Handles eval, hub op:start, write, and edit. No payload is executed:
 * - eval's native delegation is stubbed via ctx.invokeTool
 * - hub/write/edit call only Smart Approve's tool_call hooks
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const tools = new Map();
const handlers = new Map();
const commands = new Map();
const events = new EventEmitter();
const noop = () => undefined;
const asyncNoop = async () => undefined;

const logger = new Proxy(
  {
    trace: noop, debug: noop, info: noop, warn: noop, error: noop,
    child() { return logger; },
  },
  { get(target, prop) { return prop in target ? target[prop] : noop; } },
);

const apiBase = {
  zod: z,
  logger,
  events,
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand(name, definition) { commands.set(name, definition); },
  registerShortcut: noop,
  registerFlag: noop,
  registerMessageRenderer: noop,
  registerAssistantThinkingRenderer: noop,
  registerComposerShape: noop,
  registerProvider: noop,
  registerFileWriteFallback: noop,
  registerFileDeleteFallback: noop,
  registerEntryRenderer: noop,
  registerContextProvider: noop,
  registerPromptProvider: noop,
  registerToolRenderer: noop,
  setLabel: noop,
  getFlag: () => undefined,
  getActiveTools: () => [],
  getAllTools: () => [],
  setActiveTools: noop,
  getCommands: () => [],
  getSessionName: () => "sa-lancet-realistic-benchmark",
  setSessionName: noop,
  sendMessage() { throw new Error("benchmark invariant: sendMessage during load"); },
  sendUserMessage() { throw new Error("benchmark invariant: sendUserMessage during load"); },
  appendEntry() { throw new Error("benchmark invariant: appendEntry during load"); },
  exec() { throw new Error("benchmark invariant: exec during load"); },
};

// Smart Approve forks may register additional presentation-only hooks. Unknown
// register* APIs are harmless for this benchmark, so accept them as no-ops while
// keeping runtime/action APIs explicit. This makes the bridge resilient without
// changing the security decision paths we exercise.
const api = new Proxy(apiBase, {
  get(target, prop, receiver) {
    if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
    if (typeof prop === "string" && prop.startsWith("register")) return noop;
    return undefined;
  },
});

const home = os.homedir();
const workspace = path.join(home, ".sa-lancet-benchmark", "workspace");
const protectedTarget = path.join(home, ".ssh", "id_ed25519");
const protectedSymlink = path.join(workspace, "notes-link.txt");
const safeTarget = path.join(workspace, "src", "safe.txt");
const safeSymlink = path.join(workspace, "safe-link.txt");

function ensureFile(filePath, text = "fixture\n") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, text, "utf8");
}

function ensureFixtures() {
  fs.mkdirSync(workspace, { recursive: true });
  for (const file of [
    protectedTarget,
    path.join(home, ".ssh", "id_rsa"),
    path.join(home, ".aws", "credentials"),
    path.join(home, ".kube", "config"),
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
    path.join(workspace, "secrets", "private.key"),
    path.join(workspace, "secrets", "client.pem"),
    path.join(workspace, "config", "auth.json"),
    safeTarget,
  ]) ensureFile(file);

  for (const link of [protectedSymlink, safeSymlink]) {
    try { fs.rmSync(link, { force: true }); } catch {}
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
function expand(value) {
  if (typeof value === "string") return expandString(value);
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  }
  return value;
}

function flattenResultText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((x) => x?.type === "text" && typeof x.text === "string")
    .map((x) => x.text)
    .join("\n")
    .slice(0, 4000);
}

function makeContext({ interactive = false, cwd = workspace } = {}) {
  let delegated = false;
  let asked = false;
  const ui = {
    notify: noop,
    setStatus: noop,
    clearStatus: noop,
    confirm: async () => { asked = true; return false; },
    select: async (_title, _message, options) => {
      asked = true;
      if (Array.isArray(options) && options.length) {
        // Choose the deny-ish option when present; otherwise choose the last option.
        const deny = options.find((x) => String(x?.value ?? x).toLowerCase().includes("deny"));
        if (deny !== undefined) return typeof deny === "object" && deny ? deny.value : deny;
        const last = options[options.length - 1];
        return typeof last === "object" && last && "value" in last ? last.value : last;
      }
      return "deny";
    },
    input: async () => { asked = true; return undefined; },
    editor: async () => { asked = true; return undefined; },
  };
  const ctx = {
    hasUI: interactive,
    cwd,
    agent: { kind: interactive ? "main" : "sub", id: "benchmark", name: "benchmark", depth: 0 },
    ui,
    invokeTool: async () => {
      delegated = true;
      return {
        content: [{ type: "text", text: "BENCHMARK_NATIVE_TOOL_SUPPRESSED" }],
        details: { benchmark: true, executed: false },
      };
    },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
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
  return { ctx, wasDelegated: () => delegated, wasAsked: () => asked };
}

ensureFixtures();

async function importSmartApprove() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [];

  // Optional explicit override for unusual layouts. Accept either a package
  // specifier or a filesystem path.
  const override = process.env.SMART_APPROVE_BENCHMARK_MODULE?.trim();
  if (override) {
    candidates.push(
      override.startsWith(".") || override.startsWith("/")
        ? pathToFileURL(path.resolve(here, override)).href
        : override,
    );
  }

  // Normal installed-package layout.
  candidates.push("smart-approve");

  // Development layout used by this benchmark:
  //   smart-approve/
  //   ├── src/index.ts
  //   └── smart-approve-benchmark/smart_approve_operation_bridge.mjs
  // Bun can import the TypeScript source directly, so this exercises the
  // local fork rather than accidentally benchmarking the published npm build.
  for (const candidate of [
    path.join(here, "..", "src", "index.ts"),
    path.join(here, "..", "src", "index.js"),
    path.join(here, "..", "index.ts"),
    path.join(here, "..", "index.js"),
  ]) {
    if (fs.existsSync(candidate)) candidates.push(pathToFileURL(candidate).href);
  }

  const errors = [];
  for (const candidate of candidates) {
    try {
      return { mod: await import(candidate), source: candidate };
    } catch (error) {
      errors.push(`${candidate}: ${error?.message ?? error}`);
    }
  }

  throw new Error(
    "Unable to load Smart Approve from npm or the local parent repository.\n" +
      errors.map((x) => `  - ${x}`).join("\n") +
      "\nSet SMART_APPROVE_BENCHMARK_MODULE to an explicit module path if needed.",
  );
}

async function loadSmartApprove() {
  const { mod, source } = await importSmartApprove();
  const factory = mod.default ?? mod;
  if (typeof factory !== "function") {
    throw new TypeError(`Smart Approve export from ${source} is not a function`);
  }
  await factory(api);
  return {
    evalTool: tools.get("eval"),
    toolCallHandlers: handlers.get("tool_call") ?? [],
    source,
  };
}

let loaded;
try {
  loaded = await loadSmartApprove();
} catch (error) {
  process.stderr.write(`Failed to load smart-approve in operation bridge: ${error?.stack ?? error}\n`);
  process.stderr.write(`cwd=${process.cwd()} HOME=${process.env.HOME ?? ""}\n`);
  process.exit(1);
}

let packageVersion = "unknown";
try {
  const pkg = await import("smart-approve/package.json", { with: { type: "json" } });
  packageVersion = pkg.default?.version ?? pkg.version ?? "unknown";
} catch {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const localPackageJson = path.join(here, "..", "package.json");
    if (fs.existsSync(localPackageJson)) {
      packageVersion = JSON.parse(fs.readFileSync(localPackageJson, "utf8")).version ?? "unknown";
    }
  } catch {}
}

process.stdout.write(`${JSON.stringify({
  type: "ready",
  package: "smart-approve",
  version: packageVersion,
  source: loaded.source,
  tools: [...tools.keys()],
  tool_call_handlers: loaded.toolCallHandlers.length,
})}\n`);

async function runEval(id, rawInput, cwd) {
  if (!loaded.evalTool?.execute) throw new Error("smart-approve did not register eval");
  const input = expand(rawInput);
  const { ctx, wasDelegated, wasAsked } = makeContext({ interactive: false, cwd: expandString(cwd) || workspace });
  const started = performance.now();
  const result = await loaded.evalTool.execute(id, input, new AbortController().signal, undefined, ctx);
  return {
    decision: wasDelegated() ? "allow" : "stop",
    delegated: wasDelegated(), asked: wasAsked(), blocked: !wasDelegated(),
    executed: false, latency_ms: performance.now() - started,
    result_text: flattenResultText(result), normalized_input: input,
  };
}

async function runHook(id, tool, rawInput, cwd) {
  const input = expand(rawInput);
  const { ctx, wasAsked } = makeContext({ interactive: true, cwd: expandString(cwd) || workspace });
  let event = { type: "tool_call", toolName: tool, toolCallId: id, input };
  let blocked = false;
  let reason = "";
  const started = performance.now();
  for (const handler of loaded.toolCallHandlers) {
    const result = await handler(event, ctx);
    if (!result) continue;
    if (result.block) {
      blocked = true;
      reason = String(result.reason ?? "");
      break;
    }
    if (result.input && typeof result.input === "object") event = { ...event, input: result.input };
  }
  return {
    decision: blocked || wasAsked() ? "stop" : "allow",
    delegated: false, asked: wasAsked(), blocked, executed: false,
    latency_ms: performance.now() - started,
    result_text: reason, reason, normalized_input: event.input,
  };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let request;
  try { request = JSON.parse(line); }
  catch (error) {
    process.stdout.write(`${JSON.stringify({ id: null, decision: "error", error: `invalid JSON: ${error}` })}\n`);
    continue;
  }
  const id = String(request.id ?? "");
  const tool = String(request.tool ?? "");
  const input = request.input;
  const cwd = String(request.cwd ?? "$WORKSPACE");
  if (!id || !["eval", "hub", "write", "edit"].includes(tool) || !input || typeof input !== "object") {
    process.stdout.write(`${JSON.stringify({ id, decision: "error", error: "expected id, tool=(eval|hub|write|edit), input object" })}\n`);
    continue;
  }
  try {
    const response = tool === "eval" ? await runEval(id, input, cwd) : await runHook(id, tool, input, cwd);
    process.stdout.write(`${JSON.stringify({ id, ...response })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      id, decision: "error", executed: false, latency_ms: 0,
      result_text: "", error: String(error?.stack ?? error),
    })}\n`);
  }
}
