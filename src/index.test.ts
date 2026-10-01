import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

// A child process isolates HOME and host discovery from other suites and real config.
test("nested LANCET off persists without switching approval mode when gates are disabled", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "smart-approve-command-"));
  const directory = path.join(home, ".omp", "agent");
  fs.mkdirSync(directory, { recursive: true });
  const configPath = path.join(directory, "smart-approve.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: false, mode: "auto", lancet: { enabled: true } }));
  try {
    const result = spawnSync(process.execPath, ["-e", `
      import smartApprove from "./src/index.ts";
      const commands = new Map();
      smartApprove({registerCommand: (name, definition) => commands.set(name, definition), on: () => {}});
      if (commands.has("smart-approve-lancet")) throw new Error("obsolete command registered");
      const statuses = {};
      await commands.get("smart-approve").handler("lancet off", {
        hasUI: true, ui: {notify: () => {}, setStatus: (id, text) => statuses[id] = text}
      });
      console.log(JSON.stringify(statuses));
    `], { cwd: path.resolve(import.meta.dir, ".."), env: { ...process.env, HOME: home }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(saved.mode, "auto");
    assert.equal(saved.lancet.enabled, false);
    assert.deepEqual(JSON.parse(result.stdout), { "smart-approve": "smart-approve auto - lancet off" });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
