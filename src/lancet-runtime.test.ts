import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { readFile } from "node:fs/promises";
import { MODEL_ID, MODEL_FILES } from "./lancet/model-manifest.ts";
import { classifier, classifierLoaded, releaseClassifier } from "./lancet/runtime.ts";
import { readVerified } from "./lancet/classifier.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "smart-lancet-runtime-"));
after(async () => {
  await releaseClassifier();
  fs.rmSync(temporary, { recursive: true, force: true });
});

const real = process.env.LANCET_MODEL_DIR;
const realSkip = !real && "LANCET_MODEL_DIR not set";

describe("LANCET runtime", () => {
  test("fails closed for a missing model and evicts the failed load", async () => {
    const directory = path.join(temporary, "missing", MODEL_ID);
    await assert.rejects(classifier(directory), /not downloaded/u);
    assert.equal(classifierLoaded(), false);
  });

  test(
    "rejects a damaged artifact instead of selecting a fallback model",
    { skip: realSkip },
    async () => {
      assert.ok(real);
      const directory = path.join(temporary, "damaged", MODEL_ID);
      fs.mkdirSync(directory, { recursive: true });
      for (const name of Object.keys(MODEL_FILES).filter(name => name !== "model.json")) {
        fs.copyFileSync(path.join(real, name), path.join(directory, name));
      }
      const metadata = fs.readFileSync(path.join(real, "model.json"));
      metadata[metadata.length - 2] ^= 1;
      fs.writeFileSync(path.join(directory, "model.json"), metadata);
      await assert.rejects(classifier(directory), /checksum/u);
      assert.equal(classifierLoaded(), false);
      assert.throws(() => readVerified(directory, "model.json"), /checksum/u);
    },
  );

  test(
    "matches official v0.4.3 CPU scores and bands, including multi-window inputs",
    { skip: realSkip },
    async () => {
      assert.ok(real);
      const fixture = JSON.parse(
        await readFile("src/fixtures/lancet-v043-parity.json", "utf8"),
      ) as { cases: Array<{ command: string; score: number; classification: string }> };
      const loaded = await classifier(real);
      try {
        for (const row of fixture.cases) {
          const result = await loaded.score(row.command);
          assert.equal(result.classification, row.classification, row.command.slice(0, 80));
          assert.ok(result.score !== null && Math.abs(result.score - row.score) < 1e-6,
            `score parity: ${result.score} versus ${row.score}`);
        }
        for (const [command, shell, reason] of [
          ["git status", "powershell", "unsupported-shell"],
          [" ", "bash", "empty-command"],
          ["echo \0", "bash", "nul-byte"],
          ["x".repeat(8193), "bash", "raw-input-too-long"],
        ]) {
          const result = await loaded.score(command, shell);
          assert.equal(result.classification, "review");
          assert.equal(result.score, null);
          assert.equal(result.reason, reason);
        }
      } finally {
        await releaseClassifier(real);
      }
    },
  );

  test(
    "reuses one loaded classifier and releases its native session",
    { skip: realSkip },
    async () => {
      assert.ok(real);
      const first = await classifier(real);
      const second = await classifier(real);
      assert.equal(first, second);
      assert.equal(classifierLoaded(), true);
      await releaseClassifier(real);
      assert.equal(classifierLoaded(), false);

      const reloaded = await classifier(real);
      assert.notEqual(reloaded, first);
      await releaseClassifier(real);
    },
  );
});
