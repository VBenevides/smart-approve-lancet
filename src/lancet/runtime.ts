import { createRequire } from "node:module";
import { LancetClassifier, type LancetResult, type OrtRuntime } from "./classifier.ts";
import { modelDirectory, modelState } from "./model-store.ts";

const require = createRequire(import.meta.url);
let pending: Promise<LancetClassifier> | undefined;
let pendingDirectory: string | undefined;

function loadRuntime(): OrtRuntime {
  try {
    return require("onnxruntime-node") as OrtRuntime;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ONNX Runtime could not be loaded on this platform: ${message}`, { cause: error });
  }
}

/** Load one verified classifier lazily. Failed loads are evicted so setup can recover without restart. */
export function classifier(directory = modelDirectory()): Promise<LancetClassifier> {
  if (pending && pendingDirectory === directory) return pending;

  pendingDirectory = directory;
  pending = (async () => {
    const state = modelState(directory);
    if (!state.installed) {
      throw new Error(`the LANCET model is ${state.problem}; run /smart-approve-lancet setup`);
    }
    return LancetClassifier.load(directory, loadRuntime());
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
