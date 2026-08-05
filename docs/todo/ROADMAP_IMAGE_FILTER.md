# Roadmap: NSFW Image Filter

> Block upload/storage of pornographic images via a server-side classifier (authoritative,
> in-process ONNX) plus a client-side pre-upload warning (nsfwjs).
> Rewritten 2026-08-05 after code audit + web research; supersedes the earlier
> nsfwjs/`@tensorflow/tfjs-node` plan, which is not viable (see Decisions).

## Decisions (2026-08-05)

1. **Server-side is the safety gate** and runs **in-process** in Node via
   `@huggingface/transformers` (v4) + `onnxruntime-node`. No Python, no sidecar.
   - The original plan (nsfwjs + `@tensorflow/tfjs-node`) is dead: tfjs-node 4.22.0
     crashes on Node ≥ 23 at first inference (`util.isNullOrUndefined` removed from
     Node; the tfjs fix was merged 2025-04 but never released). TensorFlow.js is
     effectively unmaintained (last stable release 2024-10, 4 npm vulns incl. 1
     critical in tfjs-node's dependency chain). The pure-JS tfjs fallback works but
     is ~20× slower than ONNX at lower accuracy — rejected.
2. **Model: `onnx-community/nsfw_image_detection-ONNX`** (automated ONNX conversion of
   `Falconsai/nsfw_image_detection`, ViT-base 224px, Apache-2.0), **int8 (`q8`)**.
   Measured on desktop CPU: 84 MB on disk, ~16 ms/image incl. sharp preprocessing,
   ~250–370 MB process RSS, barely degraded on 2 cores.
   - Filter philosophy: **block clearly pornographic content with near-zero false
     positives.** Falconsai scores ~98% on explicit material and ~99% on neutral, but
     only ~31% on "mild/suggestive" (Freepik cross-eval) — that miss is **accepted
     deliberately**; suggestive-content policy stays with community moderation.
3. **One lightweight variant only** — no heavy/VLM cascade. The escape hatch is
   swappability: the model is selected via env var, so self-hosters (AGPLv3) can mount
   any Transformers.js-compatible ONNX image classifier or disable the filter entirely.
4. **Model weights are baked into the backend Docker image at build time** (pinned HF
   revision + sha256 check during build; weights are not committed to git). Runtime
   does no network access (`env.allowRemoteModels = false`).
5. **Client-side: nsfwjs 4.x + MobileNetV2**, self-hosted shards, as a pre-upload
   **warning — never a hard block** (user can proceed; the server decides).
   tfjs staleness is acceptable in the browser (frozen inference pipeline, no native
   bindings, WebGL works back to ~2015 devices). Browser ViT via Transformers.js was
   rejected: 50–90 MB downloads and multi-second CPU inference on older devices
   without WebGPU — incompatible with the "don't overwhelm old devices" requirement.
6. **Enforcement point is `fileHelper.saveImage()`** (`srv/repositories/files.ts`),
   not the upload endpoint. Rationale: the code audit found five server-side paths
   that ingest images from **external URLs** and would bypass an endpoint-level check
   (URL previews, LUKSO LSP3 profile images — one of them in the **onchain process** —
   Farcaster pfp, Twitter avatar). `saveImage()` is the single choke point for all of
   them.

## Dependencies

### Server (`srv/package.json`)

```bash
yarn add @huggingface/transformers   # pulls onnxruntime-node
```

- `sharp` is already present (`^0.35.x`). `@huggingface/transformers` depends on
  `sharp ^0.34.x` → add a yarn resolution so we don't ship two sharp copies.
- Docker image size: `onnxruntime-node` unpacks at ~513 MB (macOS/Windows binaries +
  302 MB CUDA provider). Prune in the backend image build — verified safe:
  ```bash
  rm -rf node_modules/onnxruntime-node/bin/napi-v6/{darwin,win32}
  rm -f  node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_{cuda,tensorrt}.so
  # → ~53 MB
  ```
- Total image weight added: ~150 MB (pruned runtime + q8 model).
- Note: the hardened yarn config (install scripts disabled) is fine here —
  `onnxruntime-node` ships prebuilt Node-API v6 binaries, no postinstall build.

### Client (root `package.json`)

```bash
yarn add nsfwjs @tensorflow/tfjs-core @tensorflow/tfjs-backend-webgl @tensorflow/tfjs-converter
```

- Import via `nsfwjs/core` (not the bundle entry) + the trimmed tfjs packages
  (~170 KB gzip JS total), **not** the `@tensorflow/tfjs` meta package.
- MobileNetV2 graph-model shards (~2.6 MB) self-hosted under `public/models/nsfw/`.
  The nginx CSP `connect-src` allowlist blocks third-party model CDNs anyway;
  self-hosting also keeps selfhost/airgapped instances working.
- Vite: load via dynamic `import()` on first file selection so it becomes an isolated
  lazy chunk; keep tfjs **out** of `VENDOR_GROUPS`/`manualChunks`.

## Configuration

Backend env vars (read in `srv/common/config.ts`):

| Var | Default | Meaning |
|---|---|---|
| `IMAGE_MODERATION_ENABLED` | `true` | master switch for the server-side filter |
| `IMAGE_MODERATION_MODEL_PATH` | baked-in path (e.g. `/models/nsfw`) | directory with `config.json`, `preprocessor_config.json`, `onnx/model_quantized.onnx` — swap to use a different classifier |
| `IMAGE_MODERATION_THRESHOLD` | `0.8` | reject when `nsfw` probability exceeds this |

- Selfhost: surface the switch in `docker/.env` template (naming consistent with the
  existing `CG_ENABLE_*` pattern).
- Expose the enabled-flag through the instance config (`serverconfig`) so the client
  only downloads/runs its pre-check when the instance actually filters.
- Swapping models: any image-classification model in Transformers.js layout works
  out of the box. Models exported from timm (e.g. Marqo ViT-tiny, OwenElliott
  SwiftFormer) ship **without** `preprocessor_config.json` and silently produce
  garbage unless preprocessing is replicated by hand — document this caveat for
  self-hosters.

## Phase 1: Server-Side Enforcement

### 1.1 Moderation module

**New:** `srv/moderation/imageFilter.ts`

- **Lazy load with promise cache** — `srv/api.ts` has no async init sequence
  (`app.listen` happens as an import side effect of `srv/util/express.ts`), so there
  is no place to `await` a startup load. First classification triggers the load
  (~100 ms warm) and caches the pipeline.
- Runs in **two processes**: `api` (uploads, URL previews, OAuth avatars) and
  `onchain` (LUKSO LSP3 events). Lazy loading means the onchain process only pays the
  RAM after its first classification.
- Small in-memory LRU keyed by sha256 of the input buffer: several upload types call
  `saveImage()` twice per request (small + large variant of the same source buffer);
  the LRU makes that one classification, not two.

### 1.2 Hook in `fileHelper.saveImage()`

- Classify **before** the S3 `PutObject`. ~~Original plan: classify the
  post-sharp per-variant buffer ("animated first-frame handling comes for
  free")~~ — **revised after the Phase-1 review**: that plan classified only
  frame 0 while `{ animated: true }` types store *every* frame (a benign
  frame 0 could smuggle explicit later frames), and which size variant got
  classified was nondeterministic. The gate now classifies a deterministic
  224px normalization of the **source** buffer; animated stores are scanned
  frame by frame (evenly sampled, ≤ 16 frames, early exit on the first frame
  over the threshold). Static stores still check only frame 0 — later frames
  never persist there.
- Add an options flag (e.g. `skipModeration`) for internal, derived images:
  the social-preview compositions (`updateUserPreview`/`updateCommunityPreview` —
  their sources were already classified) and the old re-encoding migrations.
- The check must **not** require a session/user id (the profile-image upload type is
  usable pre-auth; the URL-preview and onchain paths have no uploading user either).

### 1.3 Error propagation

- Add `IMAGE_CONTENT_REJECTED` to `errors.server` in `srv/common/errors.ts` —
  **required**, otherwise `handleError` (`srv/api/util.ts`) swallows unknown messages
  as `UNKNOWN`. Note: the API answers errors with **HTTP 200** and
  `{ status: 'ERROR', error: '<CODE>' }`; there is no 422 pattern in this codebase.
- For the URL-fetch ingest paths, rejection must not break the surrounding flow
  (e.g. a rejected LSP3/Twitter/Farcaster avatar → proceed without image; a rejected
  URL-preview image → preview without thumbnail).

### 1.4 Fix `FileApiConnector.uploadImage()` error handling

`src/data/api/file.ts` uses raw `axios.post` and today returns server error bodies
without throwing (it bypasses the `baseConnector.ajax` logic that converts
`status === 'ERROR'` into a thrown `Error`). Fix it to inspect the response and throw
`Error(result.error)` like `baseConnector` does — otherwise rejections never reach the
UI. All 19 callsites (15 files) funnel through this one method, so this is the single
place to fix.

### 1.5 Logging

Log rejections (no image data): upload type, scores, userId if present, process name.
The existing user-report feature (`srv/api/report.ts`) is a natural neighbor for
future moderation tooling, but out of scope here.

## Phase 2: Client-Side Pre-Screening

### 2.1 Browser module

**New:** `src/moderation/imagePrecheck.ts`

- Lazy dynamic import + model load on first file selection; `tf.enableProdMode()`;
  WebGL backend with WASM/CPU fallback; run in main thread (WebGL workers are fragile
  in Safari, and the GPU does the work anyway — a 100–300 ms hiccup on upload is fine).
- Model from `/models/nsfw/model.json` (self-hosted shards); optional IndexedDB
  caching via `model.save('indexeddb://…')` — plain HTTP caching of the shards is
  likely sufficient.
- High-precision thresholds: warn only on Porn/Hentai ≥ ~0.85; ignore Sexy/Drawing.
  Client and server models differ — the client is a courtesy check, not a mirror.

### 2.2 UX

- In `uploadImage()` (or a thin wrapper the callsites use): when the pre-check trips,
  show a **confirmation dialog** — "this image may contain inappropriate content;
  upload anyway?" — user may proceed. Never hard-block on the client: MobileNetV2 is
  ~90% accurate and silent false positives would strand legitimate uploads.
- On server rejection (`IMAGE_CONTENT_REJECTED`), show
  `showSnackbar({ type: 'warning', text: … })` (note the object signature).
- Only activate when the instance config says the server filter is enabled.

## Phase 3: Hardening & cleanup

- **Giphy**: GIFs are never stored server-side (client loads straight from Giphy CDN),
  so they can't pass the filter by design. Set an explicit `rating: 'g'` on
  `gf.trending()` / `gf.search()` calls instead of relying on the API default.
- **`ACCEPTED_IMAGE_FORMATS`** (`src/common/config.ts`) lists `image/svg` — the
  correct MIME is `image/svg+xml`, so the file-dialog filter for SVG likely never
  worked. Fix while in the area.
- Make thresholds configurable (server env done in Phase 1; client via config).
- Monitor rejection rates before considering threshold changes.
- Update docs in the same PRs: `docs/infrastructure/` (env vars, image build),
  `docs/backend/` (moderation module), `docs/frontend/` (pre-check), selfhost README
  (switch + model swapping).

## Coverage map (from the 2026-08-05 code audit)

| Ingest path | Where | Covered by |
|---|---|---|
| All client uploads (incl. Slate paste/drop, chat attachments, bot avatars via web UI) | `POST /File/uploadImage` → `saveImage()` | saveImage hook |
| URL-preview images | `srv/api/messages.ts` (`getUrlPreview`) | saveImage hook |
| LUKSO LSP3 profile image (login-triggered) | `srv/api/user.ts` | saveImage hook |
| LUKSO LSP3 profile image (chain-event-triggered) | `srv/onchain/generic.ts` — **onchain process** | saveImage hook (lazy load there) |
| Farcaster pfp / Twitter avatar | `srv/api/accounts.ts`, `srv/api/user.ts` | saveImage hook |
| Derived social previews, migrations | `srv/repositories/files.ts`, `srv/migrations/` | `skipModeration` flag |
| Giphy GIFs | never stored — client ↔ Giphy CDN | `rating: 'g'` (Phase 3) |

Bot API v1 and the plugin system have no upload endpoints (JSON + `imageId`
references only) — nothing to do there.

## Task checklist

### Phase 1 — Server
- [x] Add `@huggingface/transformers` + sharp resolution in `srv/`
- [x] Backend image build: bake model (pinned revision + sha256), prune onnxruntime-node
      (note: onnxruntime-node 1.24.3 no longer ships CUDA/TensorRT providers —
      pruning is darwin+win32, ~160 MB)
- [x] `srv/moderation/imageFilter.ts` (lazy load, LRU, thresholds from config)
- [x] Hook in `saveImage()` + `skipModeration` for derived images/migrations
- [x] Graceful handling in the five URL-ingest paths (all five already wrap
      `saveImage()` in try/catch and proceed without an image — verified, no
      code change needed)
- [x] `IMAGE_MODERATION_*` env vars + instance-config flag + `docker/.env` template entry
      (**open**: the `docker/.env` lines themselves — the file is
      permission-protected in this environment; maintainer adds them by hand)
- [x] `IMAGE_CONTENT_REJECTED` in `errors.server`
- [x] Fix `uploadImage()` to throw on `{status:'ERROR'}` responses
- [x] Rejection logging; verify api **and** onchain processes (api: e2e via
      `/File/uploadImage`; onchain: in-container classification smoke test)
- [x] Verified in the Docker stack on Node 24: harmless upload accepted at the
      default threshold, rejected end-to-end (`IMAGE_CONTENT_REJECTED` +
      structured log) with `IMAGE_MODERATION_THRESHOLD=0.0001` injected,
      accepted again after reset. No NSFW imagery used or added; scores of the
      pinned q8 model on generated harmless images: ≤ 0.008 nsfw for flat
      colors/gradients/drawings/noise/text, 0.10 worst case for a 110 px
      flat skin-tone crop — comfortably under the 0.8 threshold. A manual
      spot check with real material stays with the maintainer pre-merge.

### Phase 2 — Client
- [x] Add `nsfwjs` + trimmed tfjs packages; host MobileNetV2 shards in `public/models/nsfw/`
      (deviation: `mobilenet_v2_mid` **graph** model, 4.4 MB — the 2.6 MB
      `mobilenet_v2` is a Keras *layers* model and would force `tfjs-layers`
      into the bundle; `tfjs-backend-cpu` added as lazily imported fallback;
      `@tensorflow/tfjs` meta package aliased to a re-export stub in
      vite.config.ts because `nsfwjs/core` imports it)
- [x] `src/moderation/imagePrecheck.ts` (lazy chunk, WebGL, Porn/Hentai ≥ 0.85,
      15 s timeout, all failures resolve 'ok')
- [x] Warning/confirm dialog on client suspicion (`SuspiciousImageModalProvider`,
      queue-based, never a hard block); server rejection surfaced at all 19
      `uploadImage` callsites via `imageUploadError.ts`
- [x] Gate on instance-config flag (`features.imageFilter` →
      `config.IMAGE_FILTER_ENABLED`, checked before the dynamic import)
- [ ] Test across upload types incl. Slate paste/drop and chat attachments;
      test on a low-end device — **manual, pre-merge** (typecheck/lint/prod
      build verified incl. chunking; no browser run yet)

### Phase 3 — Hardening
- [x] Giphy `rating: 'g'`
- [x] Fix `image/svg` → `image/svg+xml` in `ACCEPTED_IMAGE_FORMATS`
- [ ] Threshold monitoring/tuning — **post-merge operations** (watch the
      `imageFilter: rejected image` logs before changing 0.8/0.85)
- [x] Documentation updates (infrastructure, backend, frontend, deployment,
      selfhost)

## Non-goals

- **Heavy/VLM moderation cascade** (multi-category guards, GPU sidecars). Out of
  scope; the env-var model swap is the extension point for operators who want more.
- **CSAM detection.** ML classifiers are the wrong tool; the industry standard is
  perceptual-hash matching against curated databases (e.g. Project Arachnid Shield,
  PhotoDNA) with attached legal/reporting processes. That is a separate
  legal/compliance workstream, tracked outside this roadmap.
- Text, video, or audio moderation.
