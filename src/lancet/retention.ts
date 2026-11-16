import * as fs from "node:fs";
import * as path from "node:path";
import { MODEL_ID } from "./model-manifest.ts";

/** Delete the model after this long without any host using it. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const MARKER = "last-used";

const lastTouch = new Map<string, number>();

function markerPath(root: string): string {
  return path.join(root, MARKER);
}

function writeMarker(root: string, now: number): void {
  const target = markerPath(root);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, new Date(now).toISOString(), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

/** Parse the shared marker. Returns undefined when it is missing, invalid, or in the future. */
export function readLastUsed(root: string, now = Date.now()): number | undefined {
  let text: string;
  try {
    text = fs.readFileSync(markerPath(root), "utf-8").trim();
  } catch {
    return undefined;
  }
  const time = Date.parse(text);
  return Number.isFinite(time) && time <= now ? time : undefined;
}

/**
 * Record that a host used the model. Writes at most once an hour per process and
 * only when the root exists. Never throws, so a disk error cannot break the gate.
 */
export function touchLastUsed(root: string, now = Date.now(), log: (message: string) => void = () => {}): void {
  const previous = lastTouch.get(root);
  if (previous !== undefined && now >= previous && now - previous < TOUCH_INTERVAL_MS) return;
  try {
    if (!fs.existsSync(root)) return;
    writeMarker(root, now);
    lastTouch.set(root, now);
  } catch (error) {
    log(`lancet last-used update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Forget the write throttle. Tests use this. */
export function resetTouchThrottle(): void {
  lastTouch.clear();
}

export interface CleanupOptions {
  root: string;
  /** This host has LANCET enabled. */
  enabled: boolean;
  /** The config file could not be read. */
  configUnreadable?: boolean;
  now?: number;
  log?: (message: string) => void;
}

/** Date when the model is due for deletion, or undefined when the marker is not valid. */
export function deletionDate(root: string, now = Date.now()): Date | undefined {
  const used = readLastUsed(root, now);
  return used === undefined ? undefined : new Date(used + RETENTION_MS);
}

/**
 * Delete the pinned model when no host used it for more than RETENTION_MS.
 * Returns true when it deleted the model. Never throws.
 */
export function cleanupUnusedModel({
  root,
  enabled,
  configUnreadable = false,
  now = Date.now(),
  log = () => {},
}: CleanupOptions): boolean {
  if (enabled || configUnreadable) return false;
  const model = path.join(root, MODEL_ID);
  try {
    let rootStat: fs.Stats;
    try {
      rootStat = fs.lstatSync(root);
    } catch {
      return false;
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
    try {
      fs.lstatSync(model);
    } catch {
      return false;
    }

    const used = readLastUsed(root, now);
    if (used === undefined) {
      writeMarker(root, now);
      log(`lancet last-used marker missing or invalid; reset to now: ${markerPath(root)}`);
      return false;
    }
    if (now - used <= RETENTION_MS) return false;

    const stat = fs.lstatSync(model);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      log(`lancet model cleanup refused: not a plain directory: ${model}`);
      return false;
    }
    const realRoot = fs.realpathSync(root);
    if (fs.realpathSync(model) !== path.join(realRoot, MODEL_ID)) {
      log(`lancet model cleanup refused: path resolves outside the model root: ${model}`);
      return false;
    }

    fs.rmSync(model, { recursive: true, force: true });
    log(`lancet model deleted: ${model}; reason: unused for more than 7 days (last used ${new Date(used).toISOString()})`);
    return true;
  } catch (error) {
    log(`lancet model cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
