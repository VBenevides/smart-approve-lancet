import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MODEL_ARCHIVE, MODEL_FILES, MODEL_ID } from "./model-manifest.ts";
import { extractEntries } from "./zip.ts";

const DOWNLOAD_TIMEOUT_MS = 900_000;


export interface ModelState {
  installed: boolean;
  problem?: string;
}

export interface InstallResult {
  installed: boolean;
  reason: "already-current" | "downloaded";
  directory: string;
}

export type ModelProgress = "download" | "verify";

export interface ModelResponse {
  ok: boolean;
  status: number;
  url?: string;
  headers?: { get?(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}

export type ModelFetch = (input: string, init: RequestInit) => Promise<ModelResponse>;

export function agentDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(
    env.OMP_AGENT_DIR || env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
  );
}

export function modelDirectory(agentDir = agentDirectory()): string {
  return path.join(agentDir, "smart-approve-lancet", MODEL_ID);
}

/** Cheap presence check for status output; loading verifies every digest again. */
export function modelState(directory = modelDirectory()): ModelState {
  try {
    const root = fs.lstatSync(directory);
    if (!root.isDirectory()) return { installed: false, problem: "model path is not a directory" };
  } catch {
    return { installed: false, problem: "not downloaded" };
  }

  for (const [name, expected] of Object.entries(MODEL_FILES)) {
    try {
      const stat = fs.lstatSync(path.join(directory, name));
      if (!stat.isFile() || stat.size !== expected.bytes) {
        return { installed: false, problem: `${name} is damaged` };
      }
    } catch {
      return { installed: false, problem: `${name} is missing` };
    }
  }
  return { installed: true };
}

function verifyFile(file: string, expected: { bytes: number; sha256: string }): boolean {
  const bytes = fs.readFileSync(file);
  return bytes.length === expected.bytes && crypto.createHash("sha256").update(bytes).digest("hex") === expected.sha256;
}

/** True only when every installed file matches the pinned release digest. */
export function modelVerified(directory = modelDirectory()): boolean {
  if (!modelState(directory).installed) return false;
  try {
    return Object.entries(MODEL_FILES).every(([name, expected]) => verifyFile(path.join(directory, name), expected));
  } catch {
    return false;
  }
}

async function fetchArchive(fetchImpl: ModelFetch, target: string, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(MODEL_ARCHIVE.url, {
    redirect: "follow",
    signal: combinedSignal,
  });
  if (!response.ok || !response.body) throw new Error(`model download failed: HTTP ${response.status}`);
  if (response.url && !response.url.startsWith("https://")) {
    throw new Error("model download was redirected off HTTPS");
  }

  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > 0 && declared !== MODEL_ARCHIVE.bytes) {
    throw new Error("model download is the wrong size");
  }

  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(target, "wx", 0o600);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > MODEL_ARCHIVE.bytes) throw new Error("model download is larger than the pinned archive");
      hash.update(chunk);
      fs.writeSync(handle, chunk);
    }
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }

  if (received !== MODEL_ARCHIVE.bytes || hash.digest("hex") !== MODEL_ARCHIVE.sha256) {
    throw new Error("model download failed its checksum; nothing was installed");
  }
}

function unpack(archive: string, directory: string): void {
  const limits = Object.fromEntries(
    Object.entries(MODEL_FILES).map(([name, expected]) => [MODEL_ARCHIVE.prefix + name, expected.bytes]),
  );
  const entries = extractEntries(archive, limits);
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const [name, expected] of Object.entries(MODEL_FILES)) {
    const bytes = entries.get(MODEL_ARCHIVE.prefix + name);
    if (!bytes) throw new Error(`missing ${name} in the model archive; nothing was installed`);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      throw new Error(`${name} in the model archive failed its checksum; nothing was installed`);
    }
    fs.writeFileSync(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
  }
}

export interface InstallModelOptions {
  agentDir?: string;
  fetchImpl?: ModelFetch;
  signal?: AbortSignal;
  onProgress?: (phase: ModelProgress) => void;
}

/** Download, verify, and atomically install the pinned model. */
export async function installModel({
  agentDir = agentDirectory(),
  fetchImpl = fetch as unknown as ModelFetch,
  signal,
  onProgress,
}: InstallModelOptions = {}): Promise<InstallResult> {
  const directory = modelDirectory(agentDir);
  if (modelVerified(directory)) return { installed: false, reason: "already-current", directory };

  const parent = path.dirname(directory);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(parent).isSymbolicLink()) {
    throw new Error("The LANCET model directory's parent is a symbolic link; refusing to write through it");
  }

  const staging = fs.mkdtempSync(path.join(parent, `.${MODEL_ID}-download-`));
  const unpacked = path.join(staging, "model");
  let retired: string | undefined;
  try {
    onProgress?.("download");
    const archive = path.join(staging, "model.zip");
    await fetchArchive(fetchImpl, archive, signal);
    onProgress?.("verify");
    unpack(archive, unpacked);
    fs.rmSync(archive, { force: true });

    if (fs.existsSync(directory)) {
      retired = `${directory}.replaced-${process.pid}-${Date.now()}`;
      fs.renameSync(directory, retired);
    }
    fs.renameSync(unpacked, directory);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (retired && !fs.existsSync(directory)) fs.renameSync(retired, directory);
    throw error;
  }

  for (const leftover of [staging, retired]) {
    try {
      if (leftover) fs.rmSync(leftover, { recursive: true, force: true });
    } catch {
      // Cleanup after an installed model is best effort; the verified directory is already live.
    }
  }
  return { installed: true, reason: "downloaded", directory };
}
