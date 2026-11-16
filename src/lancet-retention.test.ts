import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { getConfigDir } from "./config.ts";
import { MODEL_ID } from "./lancet/model-manifest.ts";
import {
  dataRoot,
  legacyModelDirectory,
  migrateLegacyModel,
  modelDirectory,
  modelVerified,
} from "./lancet/model-store.ts";
import {
  cleanupUnusedModel,
  deletionDate,
  readLastUsed,
  resetTouchThrottle,
  RETENTION_MS,
  touchLastUsed,
} from "./lancet/retention.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "smart-lancet-retention-"));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 20);
let counter = 0;

/** Fresh root holding a fake model directory and, optionally, a marker. */
function fixture(markerAgeDays?: number): { root: string; model: string; marker: string } {
  const root = path.join(temporary, `root-${counter++}`);
  const model = path.join(root, MODEL_ID);
  fs.mkdirSync(model, { recursive: true });
  fs.writeFileSync(path.join(model, "model.json"), "{}");
  const marker = path.join(root, "last-used");
  if (markerAgeDays !== undefined) {
    fs.writeFileSync(marker, new Date(NOW - markerAgeDays * DAY).toISOString());
  }
  return { root, model, marker };
}

describe("model data root", () => {
  test("picks the standard data directory for each system", () => {
    assert.equal(dataRoot({}, "linux", "/h"), path.join("/h", ".local", "share", "smart-approve-lancet"));
    assert.equal(dataRoot({ XDG_DATA_HOME: "/x" }, "linux", "/h"), path.join("/x", "smart-approve-lancet"));
    assert.equal(dataRoot({ XDG_DATA_HOME: "rel" }, "linux", "/h"), path.join("/h", ".local", "share", "smart-approve-lancet"));
    assert.equal(dataRoot({}, "darwin", "/h"), path.join("/h", "Library", "Application Support", "smart-approve-lancet"));
    assert.equal(dataRoot({ LOCALAPPDATA: "/l" }, "win32", "/h"), path.join("/l", "smart-approve-lancet"));
    assert.equal(modelDirectory("/r"), path.join("/r", MODEL_ID));
  });
});

describe("config directory resolver", () => {
  test("uses host variables first, then the fixed host order", () => {
    const home = path.join(temporary, "home");
    assert.equal(getConfigDir({}, home), path.join(home, ".omp", "agent"));
    fs.mkdirSync(path.join(home, ".pig", "agent"), { recursive: true });
    assert.equal(getConfigDir({}, home), path.join(home, ".pig", "agent"));
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    assert.equal(getConfigDir({}, home), path.join(home, ".pi", "agent"));
    fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
    assert.equal(getConfigDir({}, home), path.join(home, ".omp", "agent"));
    assert.equal(getConfigDir({ PIG_CODING_AGENT_DIR: "/p" }, home), path.resolve("/p"));
    assert.equal(getConfigDir({ PI_CODING_AGENT_DIR: "/q", PIG_CODING_AGENT_DIR: "/p" }, home), path.resolve("/q"));
    assert.equal(getConfigDir({ OMP_AGENT_DIR: "/o", PI_CODING_AGENT_DIR: "/q" }, home), path.resolve("/o"));
  });
});

describe("legacy model migration", () => {
  test("does not copy a damaged or missing legacy model", () => {
    const agent = path.join(temporary, "agent-damaged");
    const legacy = legacyModelDirectory(agent);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "model.json"), "{}");
    const root = path.join(temporary, "root-damaged");
    const logs: string[] = [];
    assert.equal(migrateLegacyModel(legacy, root, (m) => logs.push(m)), false);
    assert.equal(fs.existsSync(modelDirectory(root)), false);
    assert.equal(migrateLegacyModel(path.join(temporary, "none"), root), false);
  });

  const real = process.env.LANCET_MODEL_DIR;
  test("moves a verified legacy model and removes the old copy", { skip: !real && "LANCET_MODEL_DIR not set" }, () => {
    const agent = path.join(temporary, "agent-real");
    const legacy = legacyModelDirectory(agent);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.cpSync(path.resolve(real!), legacy, { recursive: true });
    const root = path.join(temporary, "root-real");
    assert.equal(migrateLegacyModel(legacy, root), true);
    assert.equal(modelVerified(modelDirectory(root)), true);
    assert.equal(fs.existsSync(legacy), false);
    assert.deepEqual(fs.readdirSync(root), [MODEL_ID]);
    assert.equal(migrateLegacyModel(legacy, root), false);
  });
});

describe("shared last-used marker", () => {
  test("is written at most once an hour and only when the root exists", () => {
    resetTouchThrottle();
    const { root, marker } = fixture();
    touchLastUsed(path.join(temporary, "absent"), NOW);
    assert.equal(fs.existsSync(path.join(temporary, "absent")), false);

    touchLastUsed(root, NOW);
    assert.equal(readLastUsed(root, NOW), NOW);
    touchLastUsed(root, NOW + 30 * 60 * 1000);
    assert.equal(readLastUsed(root, NOW + DAY), NOW);
    touchLastUsed(root, NOW + 61 * 60 * 1000);
    assert.equal(readLastUsed(root, NOW + DAY), NOW + 61 * 60 * 1000);
    assert.deepEqual(fs.readdirSync(root).sort(), [MODEL_ID, path.basename(marker)].sort());
  });

  test("treats a future or invalid value as missing", () => {
    const { root, marker } = fixture();
    fs.writeFileSync(marker, new Date(NOW + DAY).toISOString());
    assert.equal(readLastUsed(root, NOW), undefined);
    fs.writeFileSync(marker, "garbage");
    assert.equal(readLastUsed(root, NOW), undefined);
    assert.equal(deletionDate(root, NOW), undefined);
  });
});

describe("unused model cleanup", () => {
  test("keeps the model at 6 days and deletes it at 8 days", () => {
    const young = fixture(6);
    assert.equal(cleanupUnusedModel({ root: young.root, enabled: false, now: NOW }), false);
    assert.equal(fs.existsSync(young.model), true);

    const old = fixture(8);
    const logs: string[] = [];
    assert.equal(cleanupUnusedModel({ root: old.root, enabled: false, now: NOW, log: (m) => logs.push(m) }), true);
    assert.equal(fs.existsSync(old.model), false);
    assert.equal(fs.existsSync(old.root), true);
    assert.equal(fs.existsSync(old.marker), true);
    assert.ok(logs.some((m) => m.includes(old.model) && m.includes("unused for more than 7 days")));
    assert.equal(RETENTION_MS, 7 * DAY);
  });

  test("resets a missing, invalid, or future marker and deletes nothing", () => {
    for (const setup of [
      (m: string) => fs.rmSync(m, { force: true }),
      (m: string) => fs.writeFileSync(m, "garbage"),
      (m: string) => fs.writeFileSync(m, new Date(NOW + 30 * DAY).toISOString()),
    ]) {
      const { root, model, marker } = fixture(100);
      setup(marker);
      assert.equal(cleanupUnusedModel({ root, enabled: false, now: NOW }), false);
      assert.equal(fs.existsSync(model), true);
      assert.equal(readLastUsed(root, NOW), NOW);
    }
  });

  test("never deletes while enabled or when the config is unreadable", () => {
    const a = fixture(100);
    assert.equal(cleanupUnusedModel({ root: a.root, enabled: true, now: NOW }), false);
    assert.equal(fs.existsSync(a.model), true);
    const b = fixture(100);
    assert.equal(cleanupUnusedModel({ root: b.root, enabled: false, configUnreadable: true, now: NOW }), false);
    assert.equal(fs.existsSync(b.model), true);
  });

  test("does nothing when the model is absent", () => {
    const { root, model, marker } = fixture(100);
    fs.rmSync(model, { recursive: true });
    assert.equal(cleanupUnusedModel({ root, enabled: false, now: NOW }), false);
    assert.equal(readLastUsed(root, NOW), NOW - 100 * DAY);
    assert.equal(fs.existsSync(marker), true);
  });

  test("refuses a symbolic-link model directory and keeps its target", () => {
    const { root, model } = fixture(100);
    const outside = path.join(temporary, `outside-${counter++}`);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
    fs.rmSync(model, { recursive: true });
    fs.symlinkSync(outside, model);
    const logs: string[] = [];
    assert.equal(cleanupUnusedModel({ root, enabled: false, now: NOW, log: (m) => logs.push(m) }), false);
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
    assert.ok(logs.some((m) => m.includes("refused")));
  });

  test("refuses a symbolic-link root", () => {
    const real = fixture(100);
    const link = path.join(temporary, `link-${counter++}`);
    fs.symlinkSync(real.root, link);
    assert.equal(cleanupUnusedModel({ root: link, enabled: false, now: NOW }), false);
    assert.equal(fs.existsSync(real.model), true);
  });

  const canBlockDelete = process.platform !== "win32" && process.getuid?.() !== 0;
  test("logs a deletion error and does not throw", { skip: !canBlockDelete && "cannot block deletion on this system" }, () => {
    const { root, model } = fixture(100);
    const logs: string[] = [];
    // A read-only model directory makes the removal of its files fail.
    fs.chmodSync(model, 0o500);
    try {
      assert.equal(cleanupUnusedModel({ root, enabled: false, now: NOW, log: (m) => logs.push(m) }), false);
    } finally {
      fs.chmodSync(model, 0o700);
    }
    assert.ok(logs.some((m) => m.includes("cleanup failed")));
    assert.equal(fs.existsSync(path.join(model, "model.json")), true);
  });
});
