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

const modelDirectory = process.env.LANCET_MODEL_DIRECTORY;
test("verified nested lifecycle preserves both approval modes and never executes check", {
  skip: !modelDirectory && "LANCET_MODEL_DIRECTORY not set",
  timeout: 120_000,
}, () => {
  for (const mode of ["auto", "interactive"]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "smart-approve-lifecycle-"));
    const directory = path.join(home, ".omp", "agent");
    fs.mkdirSync(path.join(directory, "smart-approve-lancet"), { recursive: true });
    fs.cpSync(path.resolve(modelDirectory!), path.join(directory, "smart-approve-lancet", "lancet-nano-v0.4.2"), { recursive: true });
    const configPath = path.join(directory, "smart-approve.json");
    fs.writeFileSync(configPath, JSON.stringify({ enabled: false, mode, lancet: { enabled: false } }));
    try {
      const result = spawnSync(process.execPath, ["-e", `
        import assert from "node:assert/strict";
        import fs from "node:fs";
        import path from "node:path";
        import smartApprove from "./src/index.ts";
        import { modelDirectory, modelVerified } from "./src/lancet/model-store.ts";
        let definition;
        smartApprove({registerCommand: (_name, def) => definition = def, on: () => {}});
        const mode = ${JSON.stringify(mode)};
        const statuses = {};
        const notices = [];
        const ctx = {hasUI: true, ui: {
          notify: (message) => notices.push(message),
          setStatus: (id, text) => statuses[id] = text,
        }};
        const saved = () => JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".omp/agent/smart-approve.json"), "utf8"));
        assert.equal(modelVerified(modelDirectory(path.join(process.env.HOME, ".omp/agent"))), true, "fixture must be verified before setup");
        await definition.handler("lancet setup", ctx);
        assert.match(notices.at(-1), /already installed and verified/);
        assert.equal(saved().lancet.enabled, false);
        await definition.handler("lancet on", ctx);
        assert.equal(saved().mode, mode);
        assert.equal(saved().lancet.enabled, true);
        assert.equal(statuses["smart-approve"], "smart-approve " + mode + " - lancet on");
        const marker = path.join(process.env.HOME, "MustNotExist");
        await definition.handler("lancet check printf CaseSensitive > " + marker, ctx);
        assert.equal(fs.existsSync(marker), false);
        assert.match(notices.at(-1), /score=[0-9]/);
        assert.match(notices.at(-1), /printf CaseSensitive/);
        assert.equal(saved().mode, mode);
        assert.equal(saved().lancet.enabled, true);
        await definition.handler("lancet off", ctx);
        assert.equal(saved().mode, mode);
        assert.equal(saved().lancet.enabled, false);
        assert.equal(statuses["smart-approve"], "smart-approve " + mode + " - lancet off");
        console.log(mode + ": setup/on/check/off passed");
      `], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(result.status, 0, result.stderr || String(result.error));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});
