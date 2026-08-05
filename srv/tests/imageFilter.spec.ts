// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * srv/moderation/imageFilter.ts — the server-side NSFW gate.
 *
 * The real model never runs here (no model directory on the test host, and
 * tests must not depend on 87 MB of weights): @huggingface/transformers is
 * mocked and the classifier's verdict is injected per test. sharp is real,
 * so the frame normalization/extraction path is exercised with real image
 * buffers. Under test is the module's contract: threshold semantics, label
 * summing for swapped-in models, the source-keyed dedup cache, animated
 * frame scanning, fail-closed behavior with load retry, and the
 * IMAGE_MODERATION_* env surface.
 */

const classifyMock = jest.fn<Promise<{ label: string; score: number }[]>, any[]>();
const pipelineMock = jest.fn(async (..._args: any[]) => classifyMock);
const rawImageReadMock = jest.fn(async (...args: any[]) => ({ mockImage: args[0] }));
const transformersEnv: { allowRemoteModels?: boolean; localModelPath?: string } = {};

jest.mock('@huggingface/transformers', () => ({
  __esModule: true,
  env: transformersEnv,
  pipeline: (...args: any[]) => pipelineMock(...args),
  RawImage: { read: (...args: any[]) => rawImageReadMock(...args) },
}));

import sharp from 'sharp';
import imageFilter from '../moderation/imageFilter';
import errors from '../common/errors';

const context = { uploadType: 'userProfileImage', userId: 'user-1' };

// every test uses a distinctly colored image unless it exercises the cache —
// the module-level score cache lives for the whole file
let colorCounter = 0;
async function uniqueImage(): Promise<Buffer> {
  colorCounter++;
  return sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: { r: colorCounter % 256, g: (colorCounter * 7) % 256, b: (colorCounter * 13) % 256 },
    },
  }).png().toBuffer();
}

async function animatedImage(frames: number): Promise<Buffer> {
  const frameBuffers = await Promise.all(
    Array.from({ length: frames }, (_, i) =>
      sharp({
        create: {
          width: 32,
          height: 32,
          channels: 3,
          background: { r: (colorCounter * 31 + i * 40) % 256, g: 128, b: 30 },
        },
      }).png().toBuffer(),
    ),
  );
  colorCounter++;
  return sharp(frameBuffers, { join: { animated: true } }).webp().toBuffer();
}

function setScores(scores: { label: string; score: number }[]) {
  classifyMock.mockResolvedValue(scores);
}

describe('imageFilter.assertImageAllowed', () => {
  beforeEach(() => {
    classifyMock.mockReset();
    rawImageReadMock.mockClear();
    pipelineMock.mockClear();
  });

  it('fails closed with INTERNAL when the model cannot load, then retries the load', async () => {
    pipelineMock.mockRejectedValueOnce(new Error('model directory missing'));
    const image = await uniqueImage();

    await expect(
      imageFilter.assertImageAllowed(image, context),
    ).rejects.toThrow(errors.server.INTERNAL);

    // the failed load and the failed verdict are not cached: the next call
    // loads again and succeeds
    setScores([{ label: 'normal', score: 0.99 }, { label: 'nsfw', score: 0.01 }]);
    await expect(
      imageFilter.assertImageAllowed(image, context),
    ).resolves.toBeUndefined();
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('configures the runtime for local-only model loading', () => {
    // set by the load in the previous test
    expect(transformersEnv.allowRemoteModels).toBe(false);
    expect(transformersEnv.localModelPath).toBe('/models');
  });

  it('fails closed with INTERNAL on an undecodable buffer', async () => {
    setScores([{ label: 'normal', score: 1 }]);
    const junk = Buffer.from('not an image at all');
    await expect(
      imageFilter.assertImageAllowed(junk, context),
    ).rejects.toThrow(errors.server.INTERNAL);
  });

  it('allows images below the threshold', async () => {
    setScores([{ label: 'normal', score: 0.9 }, { label: 'nsfw', score: 0.1 }]);
    await expect(
      imageFilter.assertImageAllowed(await uniqueImage(), context),
    ).resolves.toBeUndefined();
  });

  it('rejects images above the threshold with IMAGE_CONTENT_REJECTED', async () => {
    setScores([{ label: 'normal', score: 0.05 }, { label: 'nsfw', score: 0.95 }]);
    await expect(
      imageFilter.assertImageAllowed(await uniqueImage(), context),
    ).rejects.toThrow(errors.server.IMAGE_CONTENT_REJECTED);
  });

  it('does not reject exactly at the threshold (default 0.8)', async () => {
    setScores([{ label: 'nsfw', score: 0.8 }]);
    await expect(
      imageFilter.assertImageAllowed(await uniqueImage(), context),
    ).resolves.toBeUndefined();
  });

  it('sums split nsfw labels of swapped-in classifiers', async () => {
    setScores([
      { label: 'Porn', score: 0.5 },
      { label: 'Hentai', score: 0.45 },
      { label: 'Neutral', score: 0.05 },
    ]);
    await expect(
      imageFilter.assertImageAllowed(await uniqueImage(), context),
    ).rejects.toThrow(errors.server.IMAGE_CONTENT_REJECTED);
  });

  it('ignores non-nsfw labels regardless of score', async () => {
    setScores([{ label: 'Sexy', score: 0.99 }, { label: 'Neutral', score: 0.01 }]);
    await expect(
      imageFilter.assertImageAllowed(await uniqueImage(), context),
    ).resolves.toBeUndefined();
  });

  it('classifies repeated saves of one source only once (dedup cache)', async () => {
    setScores([{ label: 'normal', score: 1 }]);
    const source = await uniqueImage();

    await imageFilter.assertImageAllowed(source, context);
    await imageFilter.assertImageAllowed(source, context);

    expect(classifyMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent classifications of the same source', async () => {
    setScores([{ label: 'normal', score: 1 }]);
    const source = await uniqueImage();

    await Promise.all([
      imageFilter.assertImageAllowed(source, context),
      imageFilter.assertImageAllowed(source, context),
    ]);

    expect(classifyMock).toHaveBeenCalledTimes(1);
  });

  it('rejects cached verdicts too', async () => {
    setScores([{ label: 'nsfw', score: 0.99 }]);
    const source = await uniqueImage();

    await expect(
      imageFilter.assertImageAllowed(source, context),
    ).rejects.toThrow(errors.server.IMAGE_CONTENT_REJECTED);
    await expect(
      imageFilter.assertImageAllowed(source, context),
    ).rejects.toThrow(errors.server.IMAGE_CONTENT_REJECTED);

    expect(classifyMock).toHaveBeenCalledTimes(1);
  });

  it('scans every frame of an animated source', async () => {
    setScores([{ label: 'normal', score: 1 }]);
    const animated = await animatedImage(3);

    await imageFilter.assertImageAllowed(animated, { ...context, animated: true });

    expect(classifyMock).toHaveBeenCalledTimes(3);
  });

  it('rejects when a later frame is over the threshold (benign frame 0)', async () => {
    classifyMock
      .mockResolvedValueOnce([{ label: 'nsfw', score: 0.01 }])
      .mockResolvedValueOnce([{ label: 'nsfw', score: 0.02 }])
      .mockResolvedValueOnce([{ label: 'nsfw', score: 0.97 }]);
    const animated = await animatedImage(3);

    await expect(
      imageFilter.assertImageAllowed(animated, { ...context, animated: true }),
    ).rejects.toThrow(errors.server.IMAGE_CONTENT_REJECTED);
  });

  it('stops scanning once a frame is over the threshold', async () => {
    classifyMock
      .mockResolvedValueOnce([{ label: 'nsfw', score: 0.99 }])
      .mockResolvedValue([{ label: 'nsfw', score: 0.01 }]);
    const animated = await animatedImage(4);

    await expect(
      imageFilter.assertImageAllowed(animated, { ...context, animated: true }),
    ).rejects.toThrow(errors.server.IMAGE_CONTENT_REJECTED);
    expect(classifyMock).toHaveBeenCalledTimes(1);
  });

  it('scans only frame 0 when the image is stored statically', async () => {
    setScores([{ label: 'normal', score: 1 }]);
    const animated = await animatedImage(3);

    // static store keeps only frame 0 — later frames never persist, so they
    // must not be able to reject the upload
    await imageFilter.assertImageAllowed(animated, { ...context, animated: false });

    expect(classifyMock).toHaveBeenCalledTimes(1);
  });

  it('keeps separate cache entries for animated and static stores of one buffer', async () => {
    setScores([{ label: 'normal', score: 1 }]);
    const animated = await animatedImage(2);

    await imageFilter.assertImageAllowed(animated, { ...context, animated: false });
    expect(classifyMock).toHaveBeenCalledTimes(1);
    await imageFilter.assertImageAllowed(animated, { ...context, animated: true });
    expect(classifyMock).toHaveBeenCalledTimes(3); // +2 frames

    // both verdicts cached now
    await imageFilter.assertImageAllowed(animated, { ...context, animated: false });
    await imageFilter.assertImageAllowed(animated, { ...context, animated: true });
    expect(classifyMock).toHaveBeenCalledTimes(3);
  });

  it('is a no-op when IMAGE_MODERATION_ENABLED=false', async () => {
    process.env.IMAGE_MODERATION_ENABLED = 'false';
    try {
      let isolated: typeof imageFilter | undefined;
      jest.isolateModules(() => {
        isolated = require('../moderation/imageFilter').default;
      });
      await expect(
        isolated!.assertImageAllowed(await uniqueImage(), context),
      ).resolves.toBeUndefined();
      expect(classifyMock).not.toHaveBeenCalled();
      expect(pipelineMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.IMAGE_MODERATION_ENABLED;
    }
  });

  it('honors IMAGE_MODERATION_THRESHOLD from the environment', async () => {
    process.env.IMAGE_MODERATION_THRESHOLD = '0.5';
    try {
      let isolated: typeof imageFilter | undefined;
      jest.isolateModules(() => {
        isolated = require('../moderation/imageFilter').default;
      });
      setScores([{ label: 'nsfw', score: 0.6 }]);
      await expect(
        isolated!.assertImageAllowed(await uniqueImage(), context),
      ).rejects.toThrow(errors.server.IMAGE_CONTENT_REJECTED);
    } finally {
      delete process.env.IMAGE_MODERATION_THRESHOLD;
    }
  });

  it('honors IMAGE_MODERATION_MODEL_PATH from the environment', async () => {
    process.env.IMAGE_MODERATION_MODEL_PATH = '/mnt/custom-model';
    try {
      let isolated: typeof imageFilter | undefined;
      jest.isolateModules(() => {
        isolated = require('../moderation/imageFilter').default;
      });
      setScores([{ label: 'normal', score: 1 }]);
      await isolated!.assertImageAllowed(await uniqueImage(), context);
      expect(transformersEnv.localModelPath).toBe('/mnt');
      expect(pipelineMock).toHaveBeenCalledWith(
        'image-classification',
        'custom-model',
        expect.objectContaining({ dtype: 'q8' }),
      );
    } finally {
      delete process.env.IMAGE_MODERATION_MODEL_PATH;
    }
  });
});
