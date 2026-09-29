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
  maxTokens: number;
  maxRawBytes: number;
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

/** Read one artifact and refuse it unless it is exactly the pinned v0.4.2 file. */
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
    const tokenizer = new ByteLevelBpe(JSON.parse(readVerified(directory, "tokenizer.json").toString("utf8")));
    const model = readVerified(directory, "model-int8.onnx");
    if (
      meta.format !== "lancet-nano-v1" ||
      meta.kind !== "codet5" ||
      !Number.isFinite(meta.reviewThreshold) ||
      !Number.isFinite(meta.riskyThreshold) ||
      meta.reviewThreshold > meta.riskyThreshold ||
      !Number.isFinite(meta.calibration?.scale) ||
      !Number.isFinite(meta.calibration?.bias) ||
      !Number.isInteger(meta.maxTokens) ||
      !Number.isInteger(meta.maxRawBytes)
    ) {
      throw new Error("Unsupported LANCET model metadata");
    }

    const session = await ort.InferenceSession.create(model, {
      executionProviders: ["cpu"],
      intraOpNumThreads: 4,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    });
    return new LancetClassifier(meta, tokenizer, session, ort);
  }

  constructor(
    private readonly meta: LancetModelMetadata,
    private readonly tokenizer: ByteLevelBpe,
    private readonly session: OrtSession | undefined,
    private readonly ort: OrtRuntime | undefined,
  ) {}

  /** Token ids, or the reason the input needs review. Mirrors LancetNano.encode. */
  encode(command: unknown, shell = "bash"): { ids: number[] } | { reason: string } {
    if (shell !== "bash") return { reason: "unsupported-shell" };
    if (typeof command !== "string") return { reason: "command-not-string" };
    if (!command.replace(PYTHON_SPACE, "")) return { reason: "empty-command" };
    if (command.includes("\0")) return { reason: "nul-byte" };
    if (!command.isWellFormed()) return { reason: "invalid-unicode" };
    if (encoder.encode(command).length > this.meta.maxRawBytes) return { reason: "raw-input-too-long" };

    const ids = [this.tokenizer.tokenId("<s>"), ...this.tokenizer.encode(command), this.tokenizer.tokenId("</s>")];
    if (ids.length > this.meta.maxTokens) return { reason: "token-input-too-long" };
    return { ids };
  }

  async score(command: unknown, shell = "bash", signal?: AbortSignal): Promise<LancetResult> {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const encoded = this.encode(command, shell);
    if (!("ids" in encoded)) return result(this.meta, { reason: encoded.reason });
    if (!this.session || !this.ort) throw new Error("LANCET classifier is not loaded");

    const { ids } = encoded;
    const shape = [1, ids.length];
    const feeds = {
      ids: new this.ort.Tensor("int64", BigInt64Array.from(ids, BigInt), shape),
      mask: new this.ort.Tensor("int64", new BigInt64Array(ids.length).fill(1n), shape),
    };
    const outputs = await this.session.run(feeds);
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const outputName = this.session.outputNames[0];
    const logit = Number(outputs[outputName]?.data[0]);
    if (!Number.isFinite(logit)) return result(this.meta, { reason: "nonfinite-model-output" });

    const { scale, bias } = this.meta.calibration;
    const calibrated = Math.min(60, Math.max(-60, logit * scale + bias));
    const score = 1 / (1 + Math.exp(-calibrated));
    const classification: LancetClassification = score >= this.meta.riskyThreshold
      ? "risky"
      : score >= this.meta.reviewThreshold
        ? "review"
        : "not_flagged";
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
