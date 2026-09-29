/**
 * Pinned LANCET Nano v0.4.2 CPU INT8 release metadata.
 *
 * These values come from TannerMidd/LANCET-model's v0.4.2 release and bundle
 * manifest. The model is Apache-2.0; the local runtime is MIT. The model is
 * downloaded separately and is never bundled with Smart Approve.
 */

export const MODEL_ID = "lancet-nano-v0.4.2";

export const MODEL_ARCHIVE = Object.freeze({
  url: "https://github.com/TannerMidd/LANCET-model/releases/download/v0.4.2/lancet-v0.4.2-nano-cpu-int8.zip",
  bytes: 99_770_834,
  sha256: "dfe70d0cd84142acb5551f9972557f4cddb5ea76477d7ed99fbbd070170f06f9",
  prefix: "lancet-v0.4.2-nano-cpu-int8/model/",
});

export const MODEL_FILES = Object.freeze({
  "model-int8.onnx": Object.freeze({
    bytes: 110_560_681,
    sha256: "1b6249c369ad390682d034fb9ee872dcecaa0c3418eb89218b6fa6111594a547",
  }),
  "tokenizer.json": Object.freeze({
    bytes: 2_270_240,
    sha256: "d30700d23490c46559dcade4d52f0b32950b6d358e00c6d8b340ff819b91c9e7",
  }),
  "model.json": Object.freeze({
    bytes: 3_027,
    sha256: "0154d7f2529b64e65f802743a3e89ccc301ac2b8b23f0b61fed2834db46cd675",
  }),
});
