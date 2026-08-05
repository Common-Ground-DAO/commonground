# NSFW pre-check model (client-side)

TensorFlow.js **graph model** used by the browser-side pre-upload check in
`src/moderation/imagePrecheck.ts` (loaded lazily from `/models/nsfw/model.json`).

It is the `MobileNetV2Mid` variant shipped with [nsfwjs](https://github.com/infinitered/nsfwjs):
MobileNetV2, 224×224×3 float input, a single softmax output over the five nsfwjs
classes `Drawing, Hentai, Neutral, Porn, Sexy`. The check warns (never blocks)
when `Porn` or `Hentai` is ≥ 0.85. The server-side filter is the authority; this
is a courtesy check only.

## Why this variant

`models/mobilenet_v2/` in the same repository is the better-known 224px model and
is smaller (~2.6 MB), but it is a **Keras layers model**
(`modelTopology.keras_version`) and therefore needs `@tensorflow/tfjs-layers`.
This app deliberately ships only the trimmed tfjs runtime
(`tfjs-core` + `tfjs-converter` + `tfjs-backend-webgl`, see the `@tensorflow/tfjs`
alias in `vite.config.ts`), which can load graph models only. `mobilenet_v2_mid`
is the graph-model (`"format": "graph-model"`) MobileNetV2 at the same 224px input
size, so it is the variant that fits. It costs ~1.8 MB more, fetched lazily and
only on the first image selection.

## Source

Downloaded 2026-08-05 from the pinned nsfwjs release tag `v4.3.0`:

- <https://raw.githubusercontent.com/infinitered/nsfwjs/v4.3.0/models/mobilenet_v2_mid/model.json>
- <https://raw.githubusercontent.com/infinitered/nsfwjs/v4.3.0/models/mobilenet_v2_mid/group1-shard1of2>
- <https://raw.githubusercontent.com/infinitered/nsfwjs/v4.3.0/models/mobilenet_v2_mid/group1-shard2of2>

Directory listing: <https://github.com/infinitered/nsfwjs/tree/v4.3.0/models/mobilenet_v2_mid>

The same weights are bundled base64-encoded inside the `nsfwjs` npm package
(`dist/models/mobilenet_v2_mid/*.min.js`); the binary shards above are the same
data, ~33% smaller over the wire, and are what `nsfwjs/core` expects when you
host the model yourself.

## Checksums

```
1d5fbcbff19f8641004c875447e94aad7387813b0dbbd16ebb2b75d954144a80  model.json
70e4519134a0a12417ad80b6c299d8a2b90e52ce389d03d9d56b08df6b7f5b09  group1-shard1of2
70f6216b39b52b6f1e31e13683c71987a587dc1a85644adffa17cb48c2e9bee7  group1-shard2of2
```

Verify with `sha256sum -c` from this directory.

## Licensing

- The `nsfwjs` repository these files come from is **MIT** licensed
  (<https://github.com/infinitered/nsfwjs/blob/v4.3.0/LICENSE>), and the model
  files are distributed as part of it.
- The upstream training project is [GantMan/nsfw_model](https://github.com/GantMan/nsfw_model).
  Its repository states an MIT license text but GitHub's license detector reports
  `NOASSERTION` (the file deviates from the canonical MIT text), so treat MIT-via-nsfwjs
  as the operative grant here.
- No training data is redistributed — these are weights only.

## Self-hosting is mandatory

The nginx CSP `connect-src` allowlist blocks third-party model CDNs, and
selfhost/airgapped instances have no outbound access at all. Do not change the
loader to a remote URL.
