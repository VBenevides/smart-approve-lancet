import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getConfigDir } from "../config.ts";
import { LancetClassifier, type LancetResult, type OrtRuntime } from "./classifier.ts";
import { modelDirectory, modelState } from "./model-store.ts";

const require = createRequire(import.meta.url);
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const runtimeSearchPaths = [
  extensionDirectory,
  resolve(extensionDirectory, ".."),
  getConfigDir(),
  process.cwd(),
];
const runtimeEntryPaths = [
  resolve(extensionDirectory, "node_modules", "onnxruntime-node", "dist", "index.js"),
  resolve(getConfigDir(), "node_modules", "onnxruntime-node", "dist", "index.js"),
  resolve(extensionDirectory, "..", "node_modules", "onnxruntime-node", "dist", "index.js"),
];
const runtimeBundlePaths = [
  resolve(extensionDirectory, "lancet-ort.js"),
];
let pending: Promise<LancetClassifier> | undefined;
let pendingDirectory: string | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeUnavailable(error: unknown, attempts: string[]): Error {
  const message = errorMessage(error);
  const details = attempts.length > 0 ? ` Tried: ${attempts.join(" | ")}` : "";
  return new Error(`ONNX Runtime could not be loaded on this platform: ${message}${details}`, { cause: error });
}
async function loadRuntime(): Promise<OrtRuntime> {
  let lastError: unknown;
  const attempts: string[] = [];
  for (const runtimePath of runtimeBundlePaths) {
    try {
      // The production build bundles ONNX Runtime's JavaScript dependencies;
      // only its native binding is loaded from the adjacent package files.
      const loaded = await import(pathToFileURL(runtimePath).href);
      return (loaded.default ?? loaded) as OrtRuntime;
    } catch (error) {
      lastError = error;
      attempts.push(`import ${runtimePath}: ${errorMessage(error)}`);
    }
  }
  for (const runtimePath of runtimeEntryPaths) {
    try {
      const requireFromRuntime = createRequire(pathToFileURL(runtimePath));
      return requireFromRuntime(runtimePath) as OrtRuntime;
    } catch (error) {
      lastError = error;
      attempts.push(`require ${runtimePath}: ${errorMessage(error)}`);
    }
    try {
      // OMP's extension loader can isolate package-name resolution; import the
      // exact installed entry file before trying the normal require lookup.
      const loaded = await import(pathToFileURL(runtimePath).href);
      return (loaded.default ?? loaded) as OrtRuntime;
    } catch (error) {
      lastError = error;
      attempts.push(`import ${runtimePath}: ${errorMessage(error)}`);
    }
  }
  for (const searchPath of runtimeSearchPaths) {
    let resolvedPath: string;
    try {
      resolvedPath = require.resolve("onnxruntime-node", { paths: [searchPath] });
    } catch (error) {
      lastError = error;
      attempts.push(`resolve from ${searchPath}: ${errorMessage(error)}`);
      continue;
    }
    try {
      return require(resolvedPath) as OrtRuntime;
    } catch (error) {
      lastError = error;
      attempts.push(`require ${resolvedPath}: ${errorMessage(error)}`);
    }
  }
  throw runtimeUnavailable(lastError, attempts);
}

/** Load one verified classifier lazily. Failed loads are evicted so setup can recover without restart. */
export function classifier(directory = modelDirectory()): Promise<LancetClassifier> {
  if (pending && pendingDirectory === directory) return pending;

  pendingDirectory = directory;
  pending = (async () => {
    const state = modelState(directory);
    if (!state.installed) {
      throw new Error(`the LANCET model is ${state.problem}; run /smart-approve lancet setup`);
    }
    return LancetClassifier.load(directory, await loadRuntime());
  })();
  pending.catch(() => {
    if (pendingDirectory === directory) {
      pending = undefined;
      pendingDirectory = undefined;
    }
  });
  return pending;
}

/** Whether a classifier is loaded or loading. */
export function classifierLoaded(): boolean {
  return pending !== undefined;
}

/** Release the cached classifier, allowing native model memory to be reclaimed. */
export async function releaseClassifier(directory = pendingDirectory): Promise<void> {
  if (!pending || (directory && pendingDirectory !== directory)) return;
  const current = pending;
  try {
    const loaded = await current;
    await loaded.release();
  } finally {
    if (pending === current) {
      pending = undefined;
      pendingDirectory = undefined;
    }
  }
}

/** Score one Bash command through the cached local model. */
export async function scoreCommand(
  command: string,
  shell: "bash" = "bash",
  signal?: AbortSignal,
  directory = modelDirectory(),
): Promise<LancetResult> {
  return (await classifier(directory)).score(command, shell, signal);
}

/** Structural adapter used by the shared Bash gate. */
export function createLancetScorer(directory = modelDirectory()): {
  score(command: string, shell: "bash", signal?: AbortSignal): Promise<LancetResult>;
} {
  return {
    score: (command, shell, signal) => scoreCommand(command, shell, signal, directory),
  };
}
