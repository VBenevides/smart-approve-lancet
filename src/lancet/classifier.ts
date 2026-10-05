import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { MODEL_FILES } from "./model-manifest.ts";
import { ByteLevelBpe } from "./tokenizer.ts";

const encoder = new TextEncoder();
const PYTHON_SPACE = /[\t\n\v\f\r\u001c-\u001f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/gu;

type ModelFileName = keyof typeof MODEL_FILES;
export type LancetClassification = "risky" | "not_flagged" | "review";

export interface LancetModelMetadata {
  format: string;
  kind: string;
  input: { windowTokens: number; overlapTokens: number; maxUtf8Bytes: number };
  reviewLogitThreshold: number;
  riskyLogitThreshold: number;
  reviewThreshold: number;
  riskyThreshold: number;
  calibration: { scale: number; bias: number };
  supportedShells?: string[];
}

export interface LancetResult {
  classification: LancetClassification;
  score: number | null;
  reviewThreshold: number;
  riskyThreshold: number;
  reason: string | null;
  experimental: boolean;
  executionAuthorized: false;
}

interface OrtSession {
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>;
  release?: () => Promise<void> | void;
}

export interface OrtRuntime {
  InferenceSession: {
    create(model: Buffer, options: Record<string, unknown>): Promise<OrtSession>;
  };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Read one artifact and refuse it unless it is exactly the pinned release file. */
export function readVerified(directory: string, name: string): Buffer {
  if (!(name in MODEL_FILES)) throw new Error(`Unknown LANCET artifact: ${name}`);
  const expected = MODEL_FILES[name as ModelFileName];
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size !== expected.bytes) {
    throw new Error(`LANCET artifact is missing or the wrong size: ${name}`);
  }

  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== expected.sha256) {
    throw new Error(`LANCET artifact failed its checksum: ${name}`);
  }
  return bytes;
}

function result(meta: LancetModelMetadata, extra: Partial<LancetResult>): LancetResult {
  return {
    classification: "review",
    score: null,
    reviewThreshold: meta.reviewThreshold,
    riskyThreshold: meta.riskyThreshold,
    reason: null,
    experimental: true,
    executionAuthorized: false,
    ...extra,
  };
}

/** LANCET Nano's tokenizer, input validation, calibration, and CPU inference. */
export class LancetClassifier {
  static async load(directory: string, ort: OrtRuntime): Promise<LancetClassifier> {
    const meta = JSON.parse(readVerified(directory, "model.json").toString("utf8")) as LancetModelMetadata;
    const tokenizer = new ByteLevelBpe({
      pre_tokenizer: { type: "ByteLevel", add_prefix_space: false },
      model: {
        type: "BPE",
        vocab: JSON.parse(readVerified(directory, "vocab.json").toString("utf8")),
        merges: readVerified(directory, "merges.txt").toString("utf8").split("\n").filter(line => line && !line.startsWith("#")),
      },
    });
    if (meta.format !== "semantic-windowed-1" || meta.kind !== "codet5p-encoder-windowed" ||
        meta.input?.windowTokens !== 512 || meta.input.overlapTokens !== 64 || meta.input.maxUtf8Bytes !== 8192 ||
        ![meta.reviewThreshold, meta.riskyThreshold, meta.reviewLogitThreshold, meta.riskyLogitThreshold,
          meta.calibration?.scale, meta.calibration?.bias].every(Number.isFinite)) {
      throw new Error("Unsupported LANCET model metadata");
    }
    const headSpec = JSON.parse(readVerified(directory, "head.json").toString("utf8"));
    const bytes = readVerified(directory, "head.bin");
    // Verified head.json pins the C-order float32 layout: projection, norm, two heads.
    const head = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const session = await ort.InferenceSession.create(readVerified(directory, "encoder-int8.onnx"), {
      executionProviders: ["cpu"],
      intraOpNumThreads: 4,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    });
    return new LancetClassifier(meta, tokenizer, session, ort, head, headSpec.normEps);
  }

  constructor(
    private readonly meta: LancetModelMetadata,
    private readonly tokenizer: ByteLevelBpe,
    private readonly session: OrtSession | undefined,
    private readonly ort: OrtRuntime | undefined,
    private readonly head?: Float32Array,
    private readonly normEps = 1e-5,
  ) {}

  /** Token ids, or the reason the input needs review. Mirrors LancetNano.encode. */
  encode(command: unknown, shell = "bash"): { ids: number[] } | { reason: string } {
    if (shell !== "bash") return { reason: "unsupported-shell" };
    if (typeof command !== "string") return { reason: "command-not-string" };
    if (!command.replace(PYTHON_SPACE, "")) return { reason: "empty-command" };
    if (command.includes("\0")) return { reason: "nul-byte" };
    if (!command.isWellFormed()) return { reason: "invalid-unicode" };
    if (encoder.encode(command).length > this.meta.input.maxUtf8Bytes) return { reason: "raw-input-too-long" };
    return { ids: this.tokenizer.encode(command) };
  }

  async score(command: unknown, shell = "bash", signal?: AbortSignal): Promise<LancetResult> {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const encoded = this.encode(command, shell);
    if (!("ids" in encoded)) return result(this.meta, { reason: encoded.reason });
    if (!this.session || !this.ort || !this.head) throw new Error("LANCET classifier is not loaded");

    const { ids } = encoded;
    const hiddenSize = 768;
    const total = new Float64Array(hiddenSize);
    const maximum = new Float64Array(hiddenSize).fill(-Infinity);
    const capacity = this.meta.input.windowTokens - 2;
    let previousEnd = 0;
    for (let start = 0; start < ids.length;) {
      if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      const end = Math.min(ids.length, start + capacity);
      const window = [this.tokenizer.tokenId("<s>"), ...ids.slice(start, end), this.tokenizer.tokenId("</s>")];
      const shape = [1, window.length];
      const outputs = await this.session.run({
        input_ids: new this.ort.Tensor("int64", BigInt64Array.from(window, BigInt), shape),
        attention_mask: new this.ort.Tensor("int64", new BigInt64Array(window.length).fill(1n), shape),
      });
      if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      const hidden = outputs[this.session.outputNames[0]]?.data;
      if (!hidden || hidden.length !== window.length * hiddenSize) {
        return result(this.meta, { reason: "invalid-model-output" });
      }
      for (let token = previousEnd; token < end; token++) {
        const offset = (token - start + 1) * hiddenSize;
        for (let column = 0; column < hiddenSize; column++) {
          const value = Number(hidden[offset + column]);
          if (!Number.isFinite(value)) return result(this.meta, { reason: "nonfinite-model-output" });
          total[column] += value;
          maximum[column] = Math.max(maximum[column], value);
        }
      }
      if (end === ids.length) break;
      previousEnd = end;
      start = end - this.meta.input.overlapTokens;
    }
    for (let column = 0; column < hiddenSize; column++) total[column] /= ids.length;
    const projected = new Float64Array(hiddenSize);
    let mean = 0;
    for (let row = 0; row < hiddenSize; row++) {
      let value = 0;
      const offset = row * hiddenSize * 2;
      for (let column = 0; column < hiddenSize; column++) {
        value += this.head[offset + column] * total[column];
        value += this.head[offset + hiddenSize + column] * maximum[column];
      }
      projected[row] = value;
      mean += value;
    }
    mean /= hiddenSize;
    let variance = 0;
    for (const value of projected) variance += (value - mean) ** 2;
    const divisor = Math.sqrt(variance / hiddenSize + this.normEps);
    const normOffset = hiddenSize * hiddenSize * 2;
    const weightOffset = normOffset + hiddenSize * 2;
    let logit = this.head[weightOffset + hiddenSize * 2];
    for (let column = 0; column < hiddenSize; column++) {
      const normalized = (projected[column] - mean) / divisor * this.head[normOffset + column] +
        this.head[normOffset + hiddenSize + column];
      logit += this.head[weightOffset + column] * normalized;
    }
    if (!Number.isFinite(logit)) return result(this.meta, { reason: "nonfinite-model-output" });
    const { scale, bias } = this.meta.calibration;
    const calibrated = logit * scale + bias;
    const score = calibrated >= 0 ? 1 / (1 + Math.exp(-calibrated)) : Math.exp(calibrated) / (1 + Math.exp(calibrated));
    const classification: LancetClassification = logit >= this.meta.riskyLogitThreshold
      ? "risky"
      : logit >= this.meta.reviewLogitThreshold ? "review" : "not_flagged";
    return result(this.meta, {
      score,
      classification,
      reason: classification === "review" ? "uncertainty-band" : null,
    });
  }

  async release(): Promise<void> {
    await this.session?.release?.();
  }
}
