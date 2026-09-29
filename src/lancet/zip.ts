import * as fs from "node:fs";
import * as zlib from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function fail(message: string): never {
  throw new Error(`Unsupported or damaged model archive: ${message}`);
}

function read(handle: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const got = fs.readSync(handle, buffer, 0, length, position);
  if (got !== length) fail("unexpected end of file");
  return buffer;
}

interface CentralEntry {
  method: number;
  compressed: number;
  uncompressed: number;
  offset: number;
}

function locate(handle: number, size: number, names: string[]): Map<string, CentralEntry> {
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = read(handle, size - tailLength, tailLength);
  let end = -1;
  for (let index = tail.length - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) === EOCD) {
      end = index;
      break;
    }
  }
  if (end < 0) fail("no end of central directory");

  const disk = tail.readUInt16LE(end + 4);
  const entries = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (disk !== 0 || entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    fail("multi-disk or ZIP64 archive");
  }
  if (directoryOffset + directorySize > size) fail("central directory out of range");

  const directory = read(handle, directoryOffset, directorySize);
  const wanted = new Set(names);
  const found = new Map<string, CentralEntry>();
  let cursor = 0;
  for (let count = 0; count < entries; count++) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL) {
      fail("bad central directory entry");
    }

    const flags = directory.readUInt16LE(cursor + 8);
    const method = directory.readUInt16LE(cursor + 10);
    const compressed = directory.readUInt32LE(cursor + 20);
    const uncompressed = directory.readUInt32LE(cursor + 24);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const offset = directory.readUInt32LE(cursor + 42);
    const name = directory.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!wanted.has(name)) continue;

    if (found.has(name)) fail(`duplicate entry ${name}`);
    if (flags & 0x1) fail(`encrypted entry ${name}`);
    if (method !== 0 && method !== 8) fail(`compression method ${method} for ${name}`);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || offset === 0xffffffff) {
      fail(`ZIP64 entry ${name}`);
    }
    found.set(name, { method, compressed, uncompressed, offset });
  }

  for (const name of names) {
    if (!found.has(name)) fail(`missing ${name}`);
  }
  return found;
}

/** Extract named entries from one archive, with an exact output cap per entry. */
export function extractEntries(file: string, limits: Record<string, number>): Map<string, Buffer> {
  const names = Object.keys(limits);
  const handle = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(handle).size;
    const entries = locate(handle, size, names);
    const output = new Map<string, Buffer>();
    for (const name of names) {
      const entry = entries.get(name);
      if (!entry) fail(`missing ${name}`);
      if (entry.uncompressed !== limits[name]) fail(`${name} is the wrong size`);

      const header = read(handle, entry.offset, 30);
      if (header.readUInt32LE(0) !== LOCAL) fail(`bad local header for ${name}`);
      const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      if (start + entry.compressed > size) fail(`${name} data out of range`);

      const data = read(handle, start, entry.compressed);
      const bytes = entry.method === 0
        ? data
        : zlib.inflateRawSync(data, { maxOutputLength: limits[name] });
      if (bytes.length !== limits[name]) fail(`${name} inflated to the wrong size`);
      output.set(name, bytes);
    }
    return output;
  } finally {
    fs.closeSync(handle);
  }
}
