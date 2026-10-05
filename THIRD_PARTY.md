# Third-party notices

Smart Approve Lancet remains MIT-licensed. The local LANCET integration adapts the following components:

Special thanks to **Tanner Middleton** and the [LANCET Model project](https://github.com/TannerMidd/LANCET-model) for providing the model and runtime used by Smart Approve Lancet's optional local Bash risk scoring.

- **Original Smart Approve** — created by [mentalfl0w](https://github.com/mentalfl0w/smart-approve). This project builds on their original work.
- **SpecPi LANCET runtime** — adapted from Tanner Middleton's `specpi-lancet-guard` package in [SpecPi](https://github.com/TannerMidd/SpecPi). The source runtime is MIT-licensed. Smart Approve Lancet keeps the adapted tokenizer, classifier, bounded ZIP reader, and model-store logic under the project MIT license while retaining the original attribution.
- **LANCET v0.4.3 windowed runtime** — pooling, projection, LayerNorm, and logit-band inference adapted from the MIT-licensed `classify.py` shipped in Tanner Middleton's official model bundle.
- **LANCET Nano v0.4.3 INT8 model** — downloaded separately from the pinned [LANCET-model v0.4.3 release](https://github.com/TannerMidd/LANCET-model/releases/tag/v0.4.3). The model release is Apache-2.0 and includes its own `MODEL-LICENSE.md`, `NOTICE.txt`, and third-party notices. Smart Approve Lancet does not redistribute the model archive or extracted model files in the npm package.
- **CodeT5+ upstream model** — the LANCET release identifies the Salesforce CodeT5+ upstream weights and supplies the applicable BSD-3-Clause notice in its model bundle. The upstream weights are part of the separately downloaded model artifact, not this package.
- **onnxruntime-node 1.30.0 and onnxruntime-common 1.30.0** — the exact CPU runtime packages used for local inference. ONNX Runtime is MIT-licensed; their package distributions contain the applicable notices.

## Network and artifact boundary

`/smart-approve-lancet lancet setup` is the only Smart Approve Lancet path that downloads a model. It fetches the one HTTPS GitHub release URL pinned in `src/lancet/model-manifest.ts`, verifies the archive size and SHA-256 digest, verifies all six extracted files again, and atomically installs the complete model directory. Package installation and inference do not contact a hosted classifier or Jev service.

The npm package contains the bundled extension and this notice. It does not contain the roughly 109 MB release ZIP, the roughly 111 MB ONNX encoder, risk head, tokenizer data, or model metadata files. Users who install the model must follow the licenses and notices shipped by the official LANCET release.
