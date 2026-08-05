// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * srv/moderation/imageFilter.ts — the server-side NSFW gate.
 *
 * The real model never runs here (no model directory on the test host, and
 * tests must not depend on 87 MB of weights): @huggingface/transformers is
 * mocked and the classifier's verdict is injected per test. What is under
 * test is the module's contract: threshold semantics, label summing for
 * swapped-in models, the source-keyed dedup cache, fail-closed behavior
 * with load retry, and the env-var configuration surface.
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

import imageFilter from '../moderation/imageFilter';
import errors from '../common/errors';

const context = { uploadType: 'userProfileImage', userId: 'user-1' };

// every test uses distinct buffers unless it exercises the cache — the
// module-level score cache lives for the whole file
let bufferCounter = 0;
function uniqueBuffer(): Buffer {
  return Buffer.from(`fake-image-${bufferCounter++}`);
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
    const buffer = uniqueBuffer();

    await expect(
      imageFilter.assertImageAllowed(buffer, buffer, context),
    ).rejects.toThrow(errors.server.INTERNAL);

    // the failed load and the failed score are not cached: the next call
    // loads again and succeeds
    setScores([{ label: 'normal', score: 0.99 }, { label: 'nsfw', score: 0.01 }]);
    await expect(
      imageFilter.assertImageAllowed(buffer, buffer, context),
    ).resolves.toBeUndefined();
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('configures the runtime for local-only model loading', () => {
    // set by the load in the previous test
    expect(transformersEnv.allowRemoteModels).toBe(false);
    expect(transformersEnv.localModelPath).toBe('/models');
  });

  it('allows images below the threshold', async () => {
    setScores([{ label: 'normal', score: 0.9 }, { label: 'nsfw', score: 0.1 }]);
    const buffer = uniqueBuffer();
    await expect(
      imageFilter.assertImageAllowed(buffer, buffer, context),
    ).resolves.toBeUndefined();
  });

  it('rejects images above the threshold with IMAGE_CONTENT_REJECTED', async () => {
    setScores([{ label: 'normal', score: 0.05 }, { label: 'nsfw', score: 0.95 }]);
    const buffer = uniqueBuffer();
    await expect(
      imageFilter.assertImageAllowed(buffer, buffer, context),
    ).rejects.toThrow(errors.server.IMAGE_CONTENT_REJECTED);
  });

  it('does not reject exactly at the threshold (default 0.8)', async () => {
    setScores([{ label: 'nsfw', score: 0.8 }]);
    const buffer = uniqueBuffer();
    await expect(
      imageFilter.assertImageAllowed(buffer, buffer, context),
    ).resolves.toBeUndefined();
  });

  it('sums split nsfw labels of swapped-in classifiers', async () => {
    setScores([
      { label: 'Porn', score: 0.5 },
      { label: 'Hentai', score: 0.45 },
      { label: 'Neutral', score: 0.05 },
    ]);
    const buffer = uniqueBuffer();
    await expect(
      imageFilter.assertImageAllowed(buffer, buffer, context),
    ).rejects.toThrow(errors.server.IMAGE_CONTENT_REJECTED);
  });

  it('ignores non-nsfw labels regardless of score', async () => {
    setScores([{ label: 'Sexy', score: 0.99 }, { label: 'Neutral', score: 0.01 }]);
    const buffer = uniqueBuffer();
    await expect(
      imageFilter.assertImageAllowed(buffer, buffer, context),
    ).resolves.toBeUndefined();
  });

  it('classifies size variants of one source only once (cache keyed by source)', async () => {
    setScores([{ label: 'normal', score: 1 }]);
    const source = uniqueBuffer();
    const smallVariant = uniqueBuffer();
    const largeVariant = uniqueBuffer();

    await imageFilter.assertImageAllowed(smallVariant, source, context);
    await imageFilter.assertImageAllowed(largeVariant, source, context);

    expect(classifyMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent classifications of the same source', async () => {
    setScores([{ label: 'normal', score: 1 }]);
    const source = uniqueBuffer();

    await Promise.all([
      imageFilter.assertImageAllowed(uniqueBuffer(), source, context),
      imageFilter.assertImageAllowed(uniqueBuffer(), source, context),
    ]);

    expect(classifyMock).toHaveBeenCalledTimes(1);
  });

  it('rejects cached verdicts too', async () => {
    setScores([{ label: 'nsfw', score: 0.99 }]);
    const source = uniqueBuffer();

    await expect(
      imageFilter.assertImageAllowed(uniqueBuffer(), source, context),
    ).rejects.toThrow(errors.server.IMAGE_CONTENT_REJECTED);
    await expect(
      imageFilter.assertImageAllowed(uniqueBuffer(), source, context),
    ).rejects.toThrow(errors.server.IMAGE_CONTENT_REJECTED);

    expect(classifyMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when IMAGE_MODERATION_ENABLED=false', async () => {
    process.env.IMAGE_MODERATION_ENABLED = 'false';
    try {
      let isolated: typeof imageFilter | undefined;
      jest.isolateModules(() => {
        isolated = require('../moderation/imageFilter').default;
      });
      const buffer = uniqueBuffer();
      await expect(
        isolated!.assertImageAllowed(buffer, buffer, context),
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
      const buffer = uniqueBuffer();
      await expect(
        isolated!.assertImageAllowed(buffer, buffer, context),
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
      const buffer = uniqueBuffer();
      await isolated!.assertImageAllowed(buffer, buffer, context);
      expect(transformersEnv.localModelPath).toBe('/mnt');
      expect(pipelineMock).toHaveBeenCalledWith(
        'image-classification',
        'custom-model',
        { dtype: 'q8' },
      );
    } finally {
      delete process.env.IMAGE_MODERATION_MODEL_PATH;
    }
  });
});
