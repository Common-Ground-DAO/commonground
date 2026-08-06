// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Regression test for the image-upload path (multer buffer -> sharp -> S3).
 *
 * The wave-0 `@aws-sdk` 3.88 -> 3.1102 bump broke every upload in the product:
 * `saveImage()` handed the *Sharp instance* to `PutObjectCommand` as the body,
 * and since 3.9x the S3 client rejects unknown-length stream bodies outright
 * ("Invalid value \"undefined\" for header x-amz-decoded-content-length")
 * instead of falling back to chunked encoding. Nothing caught it because the
 * upload path had no test at all.
 *
 * So the load-bearing assertion here is `Buffer.isBuffer(input.Body)`: the body
 * must be materialised bytes, never a stream. The rest pins the surrounding
 * contract (key = sha256 of the stored bytes, real webp of the requested size,
 * the `files` row matching what was stored, the 8 MB limit).
 */

const s3Send = jest.fn();
const putObjectInputs: any[] = [];
const poolQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('@aws-sdk/client-s3', () => {
  class PutObjectCommand {
    public readonly input: any;
    constructor(input: any) {
      this.input = input;
      putObjectInputs.push(input);
    }
  }
  class ListBucketsCommand {
    constructor(public readonly input: any) {}
  }
  class CreateBucketCommand {
    constructor(public readonly input: any) {}
  }
  class GetObjectCommand {
    constructor(public readonly input: any) {}
  }
  class S3Client {
    constructor(public readonly config: any) {}
    send(command: any) {
      return s3Send(command);
    }
  }
  return { S3Client, PutObjectCommand, ListBucketsCommand, CreateBucketCommand, GetObjectCommand };
});

jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => poolQuery(...args) },
}));

// `repositories/files` pulls in the user and community repositories for the
// social-preview helpers, which drag in the native `bcrypt` binding (built
// inside the image, not on the host) and a lot of unrelated infrastructure.
// `saveImage()` touches neither.
jest.mock('../repositories/users', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/communities', () => ({ __esModule: true, default: {} }));

// The NSFW gate has its own spec (imageFilter.spec.ts); here it is mocked so
// these tests don't need model weights — plus a few tests below pin the
// contract between saveImage and the gate (ordering, arguments, skip flag).
const assertImageAllowed = jest.fn<Promise<void>, any[]>().mockResolvedValue(undefined);
jest.mock('../moderation/imageFilter', () => ({
  __esModule: true,
  default: { assertImageAllowed: (...args: any[]) => assertImageAllowed(...args) },
}));

import sharp from 'sharp';
import crypto from 'crypto';
import fileHelper from '../repositories/files';
import errors from '../common/errors';
import { PutObjectCommand, ListBucketsCommand } from '@aws-sdk/client-s3';

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 12, g: 180, b: 90 },
    },
  }).png().toBuffer();
}

describe('fileHelper.saveImage', () => {
  beforeEach(() => {
    putObjectInputs.length = 0;
    poolQuery.mockClear();
    assertImageAllowed.mockClear();
    assertImageAllowed.mockResolvedValue(undefined);
    s3Send.mockReset();
    // ListBuckets first, then PutObject
    s3Send.mockImplementation(async (command: any) => {
      if (command instanceof ListBucketsCommand) {
        return { Buckets: [{ Name: 'cg-media' }] };
      }
      return {};
    });
  });

  it('uploads a Buffer body, never a stream', async () => {
    const png = await makePng(400, 300);

    const { fileId } = await fileHelper.saveImage(
      'user-1',
      { type: 'userProfileImage' } as any,
      png,
      { width: 110, height: 110 },
    );

    expect(putObjectInputs).toHaveLength(1);
    const input = putObjectInputs[0];

    // THE regression assertion — a Sharp instance / Readable would pass a
    // truthy `Body` check but blow up inside the SDK.
    expect(Buffer.isBuffer(input.Body)).toBe(true);
    expect(typeof (input.Body as any).pipe).toBe('undefined');
    expect(input.Body.length).toBeGreaterThan(0);

    expect(input.Bucket).toBe('cg-media');
    expect(input.Key).toBe(fileId);
    // the file id is the sha256 of exactly the bytes that were uploaded
    expect(crypto.createHash('sha256').update(input.Body).digest('hex')).toBe(fileId);
  });

  it('uploads a real webp resized to the requested dimensions', async () => {
    const png = await makePng(400, 300);

    await fileHelper.saveImage(
      null,
      { type: 'userProfileImage' } as any,
      png,
      { width: 110, height: 110 },
    );

    const metadata = await sharp(putObjectInputs[0].Body).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(110);
    expect(metadata.height).toBe(110);
  });

  it('records the stored object in the files table', async () => {
    const png = await makePng(200, 200);

    const { fileId } = await fileHelper.saveImage(
      'user-7',
      { type: 'communityLogoSmall' } as any,
      png,
      { width: 150, height: 150 },
    );

    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [, params] = poolQuery.mock.calls[0];
    expect(params[0]).toBe('user-7');
    expect(params[1]).toBe(fileId);
    expect(params[2]).toEqual({
      mimeType: 'image/webp',
      size: { width: 150, height: 150 },
    });
    expect(params[3]).toEqual({ type: 'communityLogoSmall' });
  });

  it('uploads without resizing when no dimensions are given', async () => {
    const png = await makePng(64, 48);

    await fileHelper.saveImage(null, { type: 'userProfileImage' } as any, png);

    expect(Buffer.isBuffer(putObjectInputs[0].Body)).toBe(true);
    const metadata = await sharp(putObjectInputs[0].Body).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(64);
    expect(metadata.height).toBe(48);
  });

  it('creates the bucket when it does not exist yet, then uploads', async () => {
    s3Send.mockImplementation(async (command: any) => {
      if (command instanceof ListBucketsCommand) {
        return { Buckets: [{ Name: 'something-else' }] };
      }
      return {};
    });

    const png = await makePng(80, 80);
    await fileHelper.saveImage(null, { type: 'userProfileImage' } as any, png, { width: 80, height: 80 });

    const commandNames = s3Send.mock.calls.map(([c]) => c.constructor.name);
    expect(commandNames).toEqual(['ListBucketsCommand', 'CreateBucketCommand', 'PutObjectCommand']);
    expect(Buffer.isBuffer(putObjectInputs[0].Body)).toBe(true);
  });

  it('rejects images over the 8 MB limit before touching S3', async () => {
    // an incompressible noise PNG large enough to exceed IMAGE_UPLOAD_SIZE_LIMIT
    const width = 2400;
    const height = 2400;
    const noise = crypto.randomBytes(width * height * 3);
    const huge = await sharp(noise, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    expect(huge.length).toBeGreaterThan(8 * 1024 * 1024);

    await expect(
      fileHelper.saveImage(null, { type: 'userProfileImage' } as any, huge, { width: 110, height: 110 }),
    ).rejects.toThrow('FILESIZE_EXCEEDED');

    expect(putObjectInputs).toHaveLength(0);
    expect(s3Send).not.toHaveBeenCalled();
  });

  it('runs the NSFW gate on the source before anything reaches S3', async () => {
    const png = await makePng(300, 300);

    await fileHelper.saveImage('user-2', { type: 'articleImage' } as any, png, { width: 100, height: 100 });

    expect(assertImageAllowed).toHaveBeenCalledTimes(1);
    const [sourceBuffer, moderationContext] = assertImageAllowed.mock.calls[0];
    // the gate sees the source buffer, so size variants of one upload agree
    expect(sourceBuffer.equals(png)).toBe(true);
    expect(moderationContext).toEqual({ uploadType: 'articleImage', userId: 'user-2', animated: false });
  });

  it('passes the animated flag through to the gate', async () => {
    const png = await makePng(60, 60);

    await fileHelper.saveImage('user-3', { type: 'roleImage' } as any, png, { width: 50, height: 50 }, { animated: true });

    expect(assertImageAllowed).toHaveBeenCalledTimes(1);
    expect(assertImageAllowed.mock.calls[0][1]).toEqual({ uploadType: 'roleImage', userId: 'user-3', animated: true });
  });

  it('stores nothing when the gate rejects', async () => {
    assertImageAllowed.mockRejectedValueOnce(new Error(errors.server.IMAGE_CONTENT_REJECTED));
    const png = await makePng(120, 120);

    await expect(
      fileHelper.saveImage(null, { type: 'userProfileImage' } as any, png, { width: 110, height: 110 }),
    ).rejects.toThrow(errors.server.IMAGE_CONTENT_REJECTED);

    expect(s3Send).not.toHaveBeenCalled();
    expect(putObjectInputs).toHaveLength(0);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('skips the gate for derived images (skipModeration)', async () => {
    const png = await makePng(90, 90);

    await fileHelper.saveImage(null, { type: 'userProfileImage' } as any, png, undefined, { skipModeration: true });

    expect(assertImageAllowed).not.toHaveBeenCalled();
    expect(putObjectInputs).toHaveLength(1);
  });

  it('exposes PutObjectCommand from the mocked SDK (guards the mock itself)', () => {
    expect(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: Buffer.from('x') }).input.Bucket).toBe('b');
    putObjectInputs.length = 0;
  });
});
