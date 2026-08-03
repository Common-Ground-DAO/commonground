# Roadmap: NSFW Image Filter

> Prevent upload of pornographic and other inappropriate images via client-side pre-screening and server-side enforcement using **nsfwjs**.

## Overview

Two-layer approach:

1. **Server-side (authoritative)** — nsfwjs running on Node.js blocks inappropriate images before they reach S3. This is the safety gate and cannot be bypassed.
2. **Client-side (UX)** — nsfwjs running in the browser gives instant feedback before the upload even starts. Convenience layer only.

All image uploads already flow through a single backend endpoint (`POST /File/uploadImage` in `srv/api/files.ts`) and a single frontend API method (`FileApiConnector.uploadImage()` in `src/data/api/file.ts`), so the insertion points are minimal.

---

## Dependencies

### Server

```bash
yarn add nsfwjs @tensorflow/tfjs-node
```

- `nsfwjs` — NSFW classification model (~5 classes: Porn, Hentai, Sexy, Drawing, Neutral)
- `@tensorflow/tfjs-node` — native TensorFlow.js backend for fast inference (~100-200ms/image)

> **Fallback**: If `@tensorflow/tfjs-node` causes native build issues in Docker, swap to `@tensorflow/tfjs` (pure JS, ~500-800ms/image, zero native deps). The nsfwjs API is identical regardless of backend.

### Client (browser)

```bash
yarn add nsfwjs @tensorflow/tfjs
```

- `@tensorflow/tfjs` — browser-native TensorFlow.js (WebGL accelerated, no native deps)
- `nsfwjs` — same package, works in both environments

### Docker considerations

If using `@tensorflow/tfjs-node`, the Dockerfile (`docker/backend/Dockerfile`) may need:

```dockerfile
# Only if tfjs-node native build fails without it
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
```

The backend image is `node:24.18-bookworm` (Node 24 on Debian Bookworm, since 2026-08-03), which typically has these already. Test by running `yarn add @tensorflow/tfjs-node` inside the builder container first — and note that the Node 24 bump makes the native-build question worth re-checking from scratch: `@tensorflow/tfjs-node` has historically lagged new Node majors in prebuilt-binary availability, so the pure-JS fallback noted above may well be the likelier path.

### No external services required

- No API keys
- No cloud calls
- No costs
- Model file (~10MB) ships with the nsfwjs package

---

## Phase 1: Server-Side Enforcement

This is the critical path — everything else is optional UX improvement.

### 1.1 Create the moderation module

**New file:** `srv/moderation/nsfwDetector.ts`

```typescript
import * as tf from '@tensorflow/tfjs-node';
import * as nsfwjs from 'nsfwjs';

let model: nsfwjs.NSFWJS | null = null;

/**
 * Load the NSFW model once at server startup.
 * Call this from the server init sequence.
 */
export async function loadNSFWModel(): Promise<void> {
  tf.enableProdMode();
  model = await nsfwjs.load();
  console.log('[moderation] NSFW model loaded');
}

export interface NSFWResult {
  rejected: boolean;
  reason?: string;
  scores?: Record<string, number>;
}

// Thresholds — tune these based on testing
const THRESHOLDS = {
  Porn: 0.80,
  Hentai: 0.80,
  Sexy: 0.90,
};

/**
 * Classify an image buffer. Returns whether it should be rejected.
 * The buffer should be a decoded image (JPEG/PNG/WebP).
 */
export async function classifyImage(imageBuffer: Buffer): Promise<NSFWResult> {
  if (!model) {
    throw new Error('[moderation] NSFW model not loaded');
  }

  // Decode image buffer to a 3D tensor
  const decodedImage = tf.node.decodeImage(imageBuffer, 3);

  try {
    const predictions = await model.classify(decodedImage as tf.Tensor3D);

    const scores: Record<string, number> = {};
    for (const p of predictions) {
      scores[p.className] = p.probability;
    }

    for (const [className, threshold] of Object.entries(THRESHOLDS)) {
      if ((scores[className] ?? 0) > threshold) {
        return {
          rejected: true,
          reason: `Image classified as potentially inappropriate (${className})`,
          scores,
        };
      }
    }

    return { rejected: false, scores };
  } finally {
    decodedImage.dispose();
  }
}
```

### 1.2 Load the model at server startup

**File:** `srv/api.ts` (or wherever the Express app initializes)

```typescript
import { loadNSFWModel } from './moderation/nsfwDetector';

// During server initialization, after other setup:
await loadNSFWModel();
```

### 1.3 Add the check to the upload pipeline

**File:** `srv/repositories/files.ts`

The check goes **after** Sharp has decoded/resized the image buffer, **before** the S3 upload. This way nsfwjs gets a clean, normalized image.

```typescript
import { classifyImage } from '../moderation/nsfwDetector';

// Inside the image processing function, after Sharp resize:
const result = await classifyImage(processedBuffer);
if (result.rejected) {
  throw new AppError('IMAGE_CONTENT_REJECTED', result.reason);
}

// Then continue with S3 upload...
```

### 1.4 Add the error code

**File:** `srv/common/errors.ts`

```typescript
IMAGE_CONTENT_REJECTED: {
  status: 422,
  message: 'This image was rejected because it may contain inappropriate content.',
}
```

### 1.5 Verify the HTTP response

The frontend already handles error responses from `uploadImage`. The new 422 response with `IMAGE_CONTENT_REJECTED` will propagate naturally through axios error handling.

---

## Phase 2: Client-Side Pre-Screening

### 2.1 Create the browser moderation module

**New file:** `src/moderation/nsfwDetector.ts`

```typescript
import * as nsfwjs from 'nsfwjs';

let model: nsfwjs.NSFWJS | null = null;
let modelLoading: Promise<nsfwjs.NSFWJS> | null = null;

const THRESHOLDS = {
  Porn: 0.80,
  Hentai: 0.80,
  Sexy: 0.90,
};

/**
 * Lazy-load the model on first use.
 * Subsequent calls return the cached model.
 */
async function getModel(): Promise<nsfwjs.NSFWJS> {
  if (model) return model;
  if (!modelLoading) {
    modelLoading = nsfwjs.load().then((m) => {
      model = m;
      return m;
    });
  }
  return modelLoading;
}

/**
 * Check a File object before upload.
 * Returns true if the image is safe, false if it should be rejected.
 */
export async function isImageSafe(file: File): Promise<boolean> {
  const m = await getModel();

  const img = new Image();
  const url = URL.createObjectURL(file);

  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = url;
    });

    const predictions = await m.classify(img);

    for (const p of predictions) {
      const threshold = THRESHOLDS[p.className as keyof typeof THRESHOLDS];
      if (threshold && p.probability > threshold) {
        return false; // Rejected
      }
    }

    return true; // Safe
  } finally {
    URL.revokeObjectURL(url);
  }
}
```

### 2.2 Integrate into the central upload function

**File:** `src/data/api/file.ts` — `FileApiConnector.uploadImage()`

```typescript
import { isImageSafe } from '../../moderation/nsfwDetector';

// At the top of uploadImage(), before the axios call:
const safe = await isImageSafe(file);
if (!safe) {
  throw new ImageContentRejectedError(
    'This image was rejected because it may contain inappropriate content.'
  );
}
```

Define `ImageContentRejectedError` in `src/common/errors.ts` as a simple custom Error subclass so callers can distinguish it from network errors.

### 2.3 Show error toasts

Since all upload callsites already catch errors from `uploadImage()`, add handling for the new error type. This can be done centrally or per-component.

**Central approach** — in `FileApiConnector.uploadImage()` itself:

```typescript
try {
  // ... existing upload logic
} catch (error) {
  if (error instanceof ImageContentRejectedError) {
    // Re-throw so the caller can show the toast
    throw error;
  }
  // Handle server-side rejection (422 IMAGE_CONTENT_REJECTED)
  if (error?.response?.data?.error === 'IMAGE_CONTENT_REJECTED') {
    throw new ImageContentRejectedError(
      'This image was rejected because it may contain inappropriate content.'
    );
  }
  throw error;
}
```

**In upload components** — every component that calls `uploadImage()` already has error handling. Add:

```typescript
} catch (error) {
  if (error instanceof ImageContentRejectedError) {
    showSnackbar('warning', error.message);
    return;
  }
  // ... existing error handling
}
```

**Affected components** (all in `src/components/`):

| Component | File |
|-----------|------|
| Profile photo | `molecules/inputs/ProfilePhotoField.tsx` |
| Image upload field | `molecules/inputs/ImageUploadField.tsx` |
| Community logo | `molecules/inputs/CommunityLogoUpload.tsx` |
| Header image | `molecules/inputs/HeaderImageUpload.tsx` |
| Chat attachments | `organisms/EditField/EditField.tsx` |
| Article content images | `organisms/EditField/FieldMediaImage.tsx` |
| Role photo | `molecules/RolePhoto.tsx` |
| User profile photo | `organisms/UserProfile/UserProfileInner.tsx` |

All of these use the existing `SnackbarContext` (`showSnackbar('warning', message)`) for error display. The toast shows at the bottom of the screen, auto-dismisses after 6 seconds (configured in `config.SNACKBAR_DURATION`).

---

## Phase 3: Tuning & Hardening

### 3.1 Threshold tuning

Start with conservative thresholds (see above), then adjust based on false positive reports:

| Class | Starting Threshold | Notes |
|-------|-------------------|-------|
| Porn | 0.80 | Core target — should be strict |
| Hentai | 0.80 | Drawn explicit content |
| Sexy | 0.90 | Higher threshold to avoid false positives on swimwear etc. |
| Drawing | — | Not filtered (non-explicit art) |
| Neutral | — | Not filtered |

Consider making thresholds configurable via `srv/common/config.ts` (server) and `src/common/config.ts` (client) so they can be adjusted without code changes.

### 3.2 Logging & monitoring

Log all rejections server-side (without storing the image) for monitoring false positive rates:

```typescript
if (result.rejected) {
  console.warn('[moderation] Image rejected', {
    userId,
    uploadType,
    scores: result.scores,
    reason: result.reason,
  });
}
```

### 3.3 GIF handling

nsfwjs classifies single frames. For animated GIFs:
- Extract the first frame using Sharp (`.gif({ progressive: false }).toBuffer()`) before classification
- This is already partially handled since Sharp processes the image before nsfwjs sees it

### 3.4 Performance considerations

- **Server**: Model loads once at startup (~2-3 seconds, ~200MB RAM). Classification is ~100-200ms with tfjs-node, ~500-800ms with pure JS. Negligible compared to Sharp processing + S3 upload.
- **Client**: Model is ~10MB downloaded once and cached by the browser. Classification is ~50-200ms with WebGL. First load may take 1-2 seconds.
- **No caching needed**: Images are identified by SHA256 hash; duplicate uploads already skip reprocessing in the existing code.

### 3.5 SVG bypass prevention

SVGs are in `ACCEPTED_IMAGE_FORMATS` but nsfwjs cannot classify SVGs (they're XML, not pixel data). Options:
- Rasterize SVGs with Sharp before classification (`sharp(buffer).png().toBuffer()`)
- Or remove SVG from accepted upload formats if not needed

---

## Task Checklist

### Phase 1 — Server (safety-critical)
- [ ] Install `nsfwjs` and `@tensorflow/tfjs-node` (or `@tensorflow/tfjs` as fallback)
- [ ] Create `srv/moderation/nsfwDetector.ts`
- [ ] Load model at server startup in `srv/api.ts`
- [ ] Add classification check in `srv/repositories/files.ts` after Sharp, before S3
- [ ] Add `IMAGE_CONTENT_REJECTED` error code to `srv/common/errors.ts`
- [ ] Test with known NSFW and safe images
- [ ] Verify Docker build works with tfjs-node (fall back to pure JS if needed)
- [ ] Add rejection logging

### Phase 2 — Client (UX improvement)
- [ ] Install `nsfwjs` and `@tensorflow/tfjs` (browser build)
- [ ] Create `src/moderation/nsfwDetector.ts`
- [ ] Add pre-upload check in `FileApiConnector.uploadImage()`
- [ ] Create `ImageContentRejectedError` in `src/common/errors.ts`
- [ ] Add snackbar warning in all upload components (8 components — see list above)
- [ ] Handle server-side 422 responses as fallback (in case client check is bypassed or thresholds differ)
- [ ] Test across upload types: profile pic, banner, article header, chat attachment, etc.

### Phase 3 — Hardening
- [ ] Tune thresholds based on real-world testing
- [ ] Make thresholds configurable via config
- [ ] Handle SVG classification (rasterize or exclude format)
- [ ] Handle animated GIF classification (first frame extraction)
- [ ] Add monitoring/alerting for rejection rates
