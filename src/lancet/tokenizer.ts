const SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPLIT = new RegExp(
  `'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^${SPACE}\\p{L}\\p{N}]+|[${SPACE}]+(?![^${SPACE}])|[${SPACE}]+`,
  "gu",
);

function byteTable(): string[] {
  const table = new Array<string>(256);
  let shifted = 0;
  for (let byte = 0; byte < 256; byte++) {
    const printable = (byte >= 0x21 && byte <= 0x7e) || (byte >= 0xa1 && byte <= 0xac) || byte >= 0xae;
    if (printable) {
      table[byte] = String.fromCodePoint(byte);
    } else {
      table[byte] = String.fromCodePoint(256 + shifted);
      shifted++;
    }
  }
  return table;
}

const BYTES = byteTable();
const encoder = new TextEncoder();

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Unsupported LANCET tokenizer: ${message}`);
}

interface TokenizerModel {
  type?: string;
  vocab?: Record<string, number>;
  merges?: Array<string | [string, string]>;
  dropout?: unknown;
  continuing_subword_prefix?: unknown;
  end_of_word_suffix?: unknown;
  byte_fallback?: boolean;
  ignore_merges?: boolean;
}

interface TokenizerSpec {
  normalizer?: unknown;
  pre_tokenizer?: { type?: string; add_prefix_space?: boolean; use_regex?: boolean };
  model?: TokenizerModel;
  added_tokens?: Array<{ content?: string; id?: number }>;
}

/** Byte-level BPE encoder for the exact tokenizer configuration shipped by LANCET. */
export class ByteLevelBpe {
  private readonly vocab: Map<string, number>;
  private readonly ranks: Map<string, number>;
  private readonly special: Map<string, number>;
  private readonly cache = new Map<string, string[]>();

  constructor(spec: TokenizerSpec) {
    const model = spec?.model;
    const pre = spec?.pre_tokenizer;
    expect(spec?.normalizer === null || spec?.normalizer === undefined, "normalizer");
    expect(pre?.type === "ByteLevel" && pre.add_prefix_space === false && pre.use_regex !== false, "pre-tokenizer");
    expect(model?.type === "BPE", "model type");
    expect(model.dropout === null || model.dropout === undefined, "dropout");
    expect(!model.continuing_subword_prefix && !model.end_of_word_suffix, "subword affixes");
    expect(model.byte_fallback !== true && model.ignore_merges !== true, "fallback or merge mode");
    expect(model.vocab && typeof model.vocab === "object" && Array.isArray(model.merges), "vocabulary");

    this.vocab = new Map(Object.entries(model.vocab));
    this.ranks = new Map();
    model.merges.forEach((merge, rank) => {
      const [left, right] = Array.isArray(merge) ? merge : String(merge).split(" ");
      expect(typeof left === "string" && typeof right === "string", "merge entry");
      const key = `${left} ${right}`;
      if (!this.ranks.has(key)) this.ranks.set(key, rank);
    });
    this.special = new Map();
    for (const token of spec.added_tokens ?? []) {
      if (typeof token.content === "string" && Number.isInteger(token.id)) {
        this.special.set(token.content, token.id as number);
      }
    }
  }

  tokenId(token: string): number {
    const id = this.special.get(token) ?? this.vocab.get(token);
    expect(Number.isInteger(id), `missing token ${token}`);
    return id as number;
  }

  /** Token ids for text, with no special tokens added and none recognised. */
  encode(text: string): number[] {
    const ids: number[] = [];
    for (const match of text.matchAll(SPLIT)) {
      const encoded = Array.from(encoder.encode(match[0]), (byte) => BYTES[byte]).join("");
      for (const piece of this.bpe(encoded)) {
        const id = this.vocab.get(piece);
        expect(Number.isInteger(id), "piece outside vocabulary");
        ids.push(id as number);
      }
    }
    return ids;
  }

  private bpe(word: string): string[] {
    const cached = this.cache.get(word);
    if (cached) return cached;

    let parts = Array.from(word);
    while (parts.length > 1) {
      let best = -1;
      let bestRank = Infinity;
      for (let index = 0; index < parts.length - 1; index++) {
        const rank = this.ranks.get(`${parts[index]} ${parts[index + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          best = index;
        }
      }
      if (best < 0) break;

      const left = parts[best];
      const right = parts[best + 1];
      const merged: string[] = [];
      for (let index = 0; index < parts.length; index++) {
        if (index < parts.length - 1 && parts[index] === left && parts[index + 1] === right) {
          merged.push(left + right);
          index++;
        } else {
          merged.push(parts[index]);
        }
      }
      parts = merged;
    }

    if (this.cache.size > 20_000) this.cache.clear();
    this.cache.set(word, parts);
    return parts;
  }
}
