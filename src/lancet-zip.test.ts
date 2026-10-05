import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { after, describe, test } from "node:test";
import { extractEntries } from "./lancet/zip.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "smart-lancet-zip-"));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

interface ZipEntry {
  name: string;
  data: Buffer;
  method?: number;
  flags?: number;
  declared?: number;
  compressed?: Buffer;
}

function zip(file: string, entries: ZipEntry[], zip64 = false): string {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = entry.compressed ?? (method === 8 ? zlib.deflateRawSync(entry.data) : entry.data);
    const name = Buffer.from(entry.name);
    const size = entry.declared ?? entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, directory, end]));
  return file;
}

const alpha = Buffer.from("alpha ".repeat(500));
const bravo = Buffer.from("bravo");

describe("LANCET model archive reader", () => {
  test("extracts only named entries with stored and deflated data", () => {
    const file = zip(path.join(temporary, "ok.zip"), [
      { name: "other.txt", data: Buffer.from("ignored") },
      { name: "x/a", data: alpha },
      { name: "x/b", data: bravo, method: 0 },
    ]);
    const output = extractEntries(file, { "x/a": alpha.length, "x/b": bravo.length });
    assert.deepEqual([...output.keys()], ["x/a", "x/b"]);
    assert.ok(output.get("x/a")?.equals(alpha));
    assert.ok(output.get("x/b")?.equals(bravo));
  });

  test("refuses missing, duplicate, malformed, and unsupported entries", () => {
    const missing = zip(path.join(temporary, "missing.zip"), [{ name: "x/a", data: alpha }]);
    assert.throws(() => extractEntries(missing, { "x/a": alpha.length, "x/b": 1 }), /missing x\/b/u);

    const duplicate = zip(path.join(temporary, "duplicate.zip"), [
      { name: "x/a", data: alpha },
      { name: "x/a", data: alpha },
    ]);
    assert.throws(() => extractEntries(duplicate, { "x/a": alpha.length }), /duplicate/u);

    const encrypted = zip(path.join(temporary, "encrypted.zip"), [{ name: "x/a", data: alpha, flags: 1 }]);
    assert.throws(() => extractEntries(encrypted, { "x/a": alpha.length }), /encrypted/u);

    const unsupported = zip(path.join(temporary, "unsupported.zip"), [{ name: "x/a", data: alpha, method: 12, compressed: alpha }]);
    assert.throws(() => extractEntries(unsupported, { "x/a": alpha.length }), /compression method 12/u);

    const zip64 = zip(path.join(temporary, "zip64.zip"), [{ name: "x/a", data: alpha }], true);
    assert.throws(() => extractEntries(zip64, { "x/a": alpha.length }), /ZIP64/u);
  });

  test("enforces exact output sizes and inflation caps", () => {
    const wrongSize = zip(path.join(temporary, "wrong-size.zip"), [{ name: "x/a", data: alpha }]);
    assert.throws(() => extractEntries(wrongSize, { "x/a": alpha.length - 1 }), /wrong size/u);

    const bomb = zip(path.join(temporary, "bomb.zip"), [{ name: "x/a", data: alpha, declared: 10 }]);
    assert.throws(() => extractEntries(bomb, { "x/a": 10 }));
  });
});
