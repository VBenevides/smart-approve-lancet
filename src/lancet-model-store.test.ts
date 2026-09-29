import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { MODEL_ARCHIVE } from "./lancet/model-manifest.ts";
import {
  installModel,
  modelDirectory,
  modelState,
  modelVerified,
  type ModelResponse,
  type ModelFetch,
} from "./lancet/model-store.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "smart-lancet-store-"));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function response(
  body: Uint8Array,
  options: { status?: number; url?: string; length?: number } = {},
): ModelResponse {
  const status = options.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: options.url ?? "",
    headers: { get: () => options.length === undefined ? null : String(options.length) },
    body: (async function* () {
      yield body;
    })(),
  };
}

function agentDir(name: string): string {
  return path.join(temporary, name);
}

function leftovers(dir: string): string[] {
  const parent = path.dirname(modelDirectory(dir));
  return fs.existsSync(parent) ? fs.readdirSync(parent) : [];
}

describe("LANCET model lifecycle", () => {
  test("uses only the pinned HTTPS archive and refuses wrong bytes", async () => {
    const requested: string[] = [];
    const dir = agentDir("wrong");
    await assert.rejects(
      installModel({
        agentDir: dir,
        fetchImpl: async (url) => {
          requested.push(url);
          return response(Buffer.from("not the model"));
        },
      }),
      /checksum/u,
    );
    assert.deepEqual(requested, [MODEL_ARCHIVE.url]);
    assert.equal(modelState(modelDirectory(dir)).installed, false);
    assert.deepEqual(leftovers(dir), []);
  });

  test("rejects declared-size mismatches, HTTP errors, and off-HTTPS redirects", async () => {
    await assert.rejects(
      installModel({
        agentDir: agentDir("declared"),
        fetchImpl: async () => response(Buffer.from("x"), { length: 12 }),
      }),
      /wrong size/u,
    );
    await assert.rejects(
      installModel({
        agentDir: agentDir("status"),
        fetchImpl: async () => response(Buffer.alloc(0), { status: 404 }),
      }),
      /HTTP 404/u,
    );
    await assert.rejects(
      installModel({
        agentDir: agentDir("redirect"),
        fetchImpl: async () => response(Buffer.from("x"), { url: "http://example.invalid/model" }),
      }),
      /off HTTPS/u,
    );
  });

  test("keeps a damaged previous model when a replacement download fails", async () => {
    const dir = agentDir("damaged");
    const target = modelDirectory(dir);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "model.json"), "{}");
    await assert.rejects(
      installModel({ agentDir: dir, fetchImpl: async () => response(Buffer.from("x")) }),
      /checksum/u,
    );
    assert.equal(fs.readFileSync(path.join(target, "model.json"), "utf8"), "{}");
    assert.deepEqual(leftovers(dir), [path.basename(target)]);
  });

  const archive = process.env.LANCET_MODEL_ARCHIVE;
  test(
    "atomically installs the official archive and makes a verified install idempotent",
    { skip: !archive && "LANCET_MODEL_ARCHIVE not set" },
    async () => {
      assert.ok(archive);
      const dir = agentDir("official");
      const target = modelDirectory(dir);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "model.json"), "damaged");
      const fetchImpl: ModelFetch = async () => ({
        ...response(Buffer.alloc(0)),
        body: fs.createReadStream(archive) as AsyncIterable<Uint8Array>,
      });

      const first = await installModel({ agentDir: dir, fetchImpl });
      assert.equal(first.reason, "downloaded");
      assert.equal(modelVerified(target), true);
      assert.deepEqual(fs.readdirSync(target).sort(), ["model-int8.onnx", "model.json", "tokenizer.json"]);
      assert.deepEqual(leftovers(dir), [path.basename(target)]);

      const second = await installModel({
        agentDir: dir,
        fetchImpl: async () => {
          throw new Error("a verified install must not download again");
        },
      });
      assert.equal(second.reason, "already-current");
    },
  );
});
