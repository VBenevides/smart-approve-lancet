import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { readFile } from "node:fs/promises";
import { MODEL_ID } from "./lancet/model-manifest.ts";
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
      for (const name of ["model-int8.onnx", "tokenizer.json"] as const) {
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
    "matches the source tokenizer and classification bands on the official model",
    { skip: realSkip },
    async () => {
      assert.ok(real);
      const metadata = JSON.parse(await readFile(path.join(real, "model.json"), "utf8")) as {
        reviewThreshold: number;
        riskyThreshold: number;
      };
      const fixture = JSON.parse(
        await readFile("local/SpecPi-main/packages/lancet-guard/tests/fixtures/parity.json", "utf8"),
      ) as { cases: Array<Record<string, unknown>> };
      const loaded = await classifier(real);
      try {
        for (const row of fixture.cases) {
          const command = row.command as string;
          const shell = row.shell as string | undefined;
          const encoded = loaded.encode(command, shell);
          if ("ids" in encoded) {
            assert.deepEqual(encoded.ids, row.ids, command.slice(0, 80));
          } else {
            assert.equal(encoded.reason, row.reason, command.slice(0, 80));
          }
          const result = await loaded.score(command, shell);
          if (result.score === null) {
            assert.equal(result.classification, "review", command.slice(0, 80));
          } else {
            const expectedBand = result.score >= metadata.riskyThreshold
              ? "risky"
              : result.score >= metadata.reviewThreshold
                ? "review"
                : "not_flagged";
            assert.equal(result.classification, expectedBand, command.slice(0, 80));
          }
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
