// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { dockerSecret } from "../util";
import {
  CreateBucketCommand,
  GetObjectCommand,
  ListBucketsCommand,
  PutObjectCommand,
  S3Client,
  S3ClientConfig
} from "@aws-sdk/client-s3";
// The `@aws-sdk/{url-parser,hash-node,protocol-http}` packages were retired in
// favour of their `@smithy/*` successors; `formatUrl` stayed on the AWS side.
import { parseUrl } from "@smithy/url-parser";
import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { formatUrl } from "@aws-sdk/util-format-url";
// Types are imported by name rather than through the `sharp.*` namespace: the
// namespace only exists in sharp's CommonJS `export =` typings, so it resolves
// under the build's `moduleResolution: Node16` but not under the CommonJS
// resolution ts-jest compiles the test suite with. The named types exist in both.
import sharp, { Blend, type Sharp, type WebpOptions, type JpegOptions } from 'sharp';
import crypto from "crypto";
import { Readable } from "stream";
import { Blob, Buffer } from "buffer";
import { ReadableStream } from "node:stream/web";
import config from "../common/config";
import { S3RequestPresigner } from "@aws-sdk/s3-request-presigner";
import format from "pg-format";
import errors from "../common/errors";
import userHelper from "./users";
import communityHelper from "./communities";
import pool from "../util/postgres";
import urlConfig from '../util/urls';
import imageFilter from "../moderation/imageFilter";

const s3_secret = dockerSecret('s3_secret') || process.env.S3_SECRET as string;
const s3_signedUrlExpiration = 7 * 24 * 60 * 60; // 7 days

type SaveIntoS3Options = {
  withoutEnlargement?: boolean;
  animated?: boolean;
  /** Skip the NSFW check for internally derived images whose source was
   * already classified: the social-preview compositions and the old
   * re-encoding migrations. Never set this for externally provided bytes. */
  skipModeration?: boolean;
}

// IMAGE FUNCTIONS

function getHexagonPathData(sideLength: number, borderRadius: number) {
  // #################### x1,y0 ####################
  // ############## xc1,yc0 # xc2,yc0 ##############
  // ###############################################
  // ###############################################
  // #### xc0,yc1 ##################### xc3,yc1 ####
  // ## x0,y1 ############################# x2,y1 ##
  // ## x0,yc2 ########################### x2,yc2 ##
  // ###############################################
  // ###############################################
  // ## x0,yc3 ########################### x2,yc3 ##
  // ## x0,y2 ############################# x2,y2 ##
  // #### xc0,yc4 ##################### xc3,yc4 ####
  // ###############################################
  // ###############################################
  // ############## xc1,yc5 # xc2,yc5 ##############
  // #################### x1,y3 ####################

  const sin = (deg: number) => Math.sin((deg * Math.PI) / 180);
  const cos = (deg: number) => Math.cos((deg * Math.PI) / 180);

  const x0 = 0;
  const y0 = 0;

  const x1 = sideLength * cos(30);
  const y1 = sideLength * sin(30);

  const xc1 = x1 - borderRadius * cos(30);
  const yc0 = borderRadius * sin(30);
  const xc2 = x1 + borderRadius * cos(30);

  const x2 = 2 * x1;
  const y2 = y1 + sideLength;

  const xc3 = x2 - borderRadius * cos(30);
  const yc1 = y1 - borderRadius * sin(30);
  const yc2 = y1 + borderRadius;

  const y3 = y2 + y1;

  const yc3 = y2 - borderRadius;
  const yc4 = y2 + borderRadius * sin(30);

  const yc5 = y3 - borderRadius * sin(30);
  const xc0 = borderRadius * cos(30);

  return `
    M ${xc1},${yc0}
    Q ${x1},${y0} ${xc2},${yc0}

    L ${xc3},${yc1}
    Q ${x2},${y1} ${x2},${yc2}

    L ${x2},${yc3}
    Q ${x2},${y2} ${xc3},${yc4}

    L ${xc2},${yc5}
    Q ${x1},${y3} ${xc1},${yc5}
    
    L ${xc0},${yc4}
    Q ${x0},${y2} ${x0},${yc3}
    
    L ${x0},${yc2}
    Q ${x0},${y1} ${xc0},${yc1}
    Z`;
}

async function createStamp(): Promise<Buffer> {
  const stampSVG = `<svg width="99" height="100" viewBox="0 0 99 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g clip-path="url(#clip0_13101_80460)">
      <path d="M25.1445 118.74L30.5008 115.667L30.5391 65.6953V65.1009C30.5391 63.2988 30.8523 61.772 31.4125 60.573V60.5715" stroke="#F2DCC2" stroke-width="2"/>
      <path d="M73.395 118.513L68.0387 115.424L68.0004 65.1858V64.5882C68.0004 62.7765 67.6872 61.2415 67.1271 60.0361V60.0347" stroke="#F2DCC2" stroke-width="2"/>
      <path d="M20.2393 47.2539L49.3375 30.4463L78.4357 47.2539" stroke="#F2DCC2" stroke-width="2"/>
      <path d="M49.8613 64.2572L20.3999 47.917L20.3999 115.077L25.6595 118.083C25.6595 118.083 25.6652 67.6015 25.6796 67.3514C25.9257 62.7029 28.431 60.17 31.794 60.8018C32.5509 60.9447 33.3524 61.2478 34.1813 61.7223L35.5196 62.4899C40.2252 65.1901 44.0414 72.4315 44.0414 78.6652V128.632L49.2665 131.64" stroke="#F2DCC2" stroke-width="2"/>
      <path d="M62.8121 60.9051L62.8122 60.905L64.1796 60.1154L64.1803 60.1151C65.108 59.5803 66.0319 59.2233 66.9321 59.0522L66.933 59.052C68.9702 58.6667 70.8186 59.2527 72.1644 60.6803C73.4782 62.074 74.2312 64.1772 74.3648 66.719L74.3647 66.719C74.3741 67.0418 74.3787 80.0112 74.382 92.8568C74.3837 99.338 74.3849 105.811 74.3856 110.664L74.3865 116.527L74.3866 117.021L77.7607 115.079V48.5134L50.2665 64.3891V130.959L53.6051 129.024V78.4089C53.6051 75.014 54.6329 71.3907 56.2697 68.2633C57.9021 65.1444 60.194 62.4175 62.8121 60.9051Z" stroke="#F2DCC2" stroke-width="2"/>
      <path fill-rule="evenodd" clip-rule="evenodd" d="M67.0021 31.6093C67.7553 31.6093 68.4848 31.5082 69.178 31.3187C68.6269 31.2025 68.0555 31.1414 67.47 31.1414H57.7377C56.1302 31.1414 54.6302 30.6808 53.3627 29.8844C53.6397 28.2624 54.4043 26.7074 55.6565 25.4554L61.8767 19.2353C62.4093 18.7027 62.8535 18.1152 63.2099 17.4912C62.7379 17.7987 62.2906 18.1595 61.8767 18.5736L54.9948 25.4554C53.8581 26.592 52.4718 27.3269 51.0125 27.6601C50.0614 26.3172 49.5026 24.677 49.5026 22.9063V14.1098C49.5026 13.3566 49.4015 12.627 49.2121 11.9338C49.0958 12.4849 49.0347 13.0563 49.0347 13.6419V23.3742C49.0347 24.9817 48.5741 26.4816 47.7777 27.7492C46.1557 27.4721 44.6008 26.7074 43.3487 25.4553L37.1286 19.2353C36.596 18.7027 36.0086 18.2582 35.3845 17.9021C35.692 18.3739 36.0528 18.8212 36.4669 19.2353L43.3487 26.1171C44.4853 27.2537 45.2203 28.64 45.5534 30.0994C44.2105 31.0504 42.5704 31.6093 40.7996 31.6093H32.0031C31.2499 31.6093 30.5203 31.7104 29.8271 31.8999C30.3782 32.016 30.9496 32.0772 31.5352 32.0772H41.2675C42.875 32.0772 44.3749 32.5378 45.6425 33.3342C45.3654 34.9561 44.6008 36.511 43.3487 37.7632L37.1286 43.9833C36.596 44.516 36.1516 45.1033 35.7954 45.7274C36.2672 45.4198 36.7145 45.059 37.1286 44.645L44.0104 37.7632C45.147 36.6265 46.5333 35.8916 47.9927 35.5583C48.9437 36.9014 49.5026 38.5415 49.5026 40.3123V49.1088C49.5026 49.862 49.6037 50.5915 49.7932 51.2847C49.9093 50.7336 49.9705 50.1622 49.9705 49.5767V39.8442C49.9705 38.2367 50.4311 36.7369 51.2275 35.4694C52.8494 35.7464 54.4043 36.511 55.6565 37.7632L61.8767 43.9833C62.4093 44.516 62.9966 44.9602 63.6207 45.3166C63.3132 44.8445 62.9523 44.3973 62.5383 43.9833L55.6565 37.1015C54.5198 35.9648 53.7849 34.5785 53.4518 33.1192C54.7947 32.1681 56.4348 31.6093 58.2056 31.6093H67.0021Z" fill="#F2DCC2"/>
    </g>
    <rect x="1" y="1.85718" width="97" height="97" rx="48.5" stroke="#F2DCC2" stroke-width="2"/>
    <defs>
      <clipPath id="clip0_13101_80460">
        <rect y="0.857178" width="99" height="99" rx="49.5" fill="white"/>
      </clipPath>
    </defs>
  </svg>`;
  const stamp = await sharp(Buffer.from(stampSVG))
    .extend({
      top: 0,
      bottom: 24,
      left: 0,
      right: 24,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }).png();
  return stamp.toBuffer();
};

async function createHexagonalForeground(imageBuffer: Buffer, outputImageSize: number): Promise<Buffer> {
  const viewSize = Math.round(outputImageSize * 0.7);
  const sideLength = Math.round(viewSize / 2);
  const leftIndent = Math.round(outputImageSize / 20) * -1;
  const radius = Math.round(outputImageSize / 20);
  const preparedHexagonalSVG = `<svg width="${outputImageSize}" height="${outputImageSize}" viewBox="${leftIndent} 0 ${viewSize} ${viewSize}" fill="none"><path id="hexagon" fill="red" d='${getHexagonPathData(sideLength, radius)}' /></svg>`;
  const hexagonWithRoundedCorners = Buffer.from(preparedHexagonalSVG);

  const foreground = await sharp(imageBuffer)
    .resize(outputImageSize, outputImageSize)
    .composite([{
      input: hexagonWithRoundedCorners,
      blend: 'dest-in'
    }]).png().toBuffer();
  return foreground;
}

async function createRoundedForeground(imageBuffer: Buffer, outputImageSize: number): Promise<Buffer> {
  const radius = Math.round(outputImageSize / 2);
  const preparedCircleSVG = `<svg width="${outputImageSize}" height="${outputImageSize}" viewBox="0 0 ${outputImageSize} ${outputImageSize}" fill="none"><circle cx="${radius}" cy="${radius}" r="${radius}" fill="red" /></svg>`;
  const circle = Buffer.from(preparedCircleSVG);

  const foreground = await sharp(imageBuffer)
    .resize(outputImageSize, outputImageSize)
    .composite([{
      input: circle,
      blend: 'dest-in'
    }])
    .png().toBuffer();
  return foreground;
}

async function createRoundedRectForeground(imageBuffer: Buffer, outputImageSize: number, borderRadius: number): Promise<Buffer> {
  const preparedRectSVG = `<svg width="${outputImageSize}" height="${outputImageSize}" viewBox="0 0 ${outputImageSize} ${outputImageSize}" fill="none"><rect x="0" y="0" width="${outputImageSize}" height="${outputImageSize}" rx="${borderRadius}" ry="${borderRadius}" fill="red" /></svg>`;
  const rect = Buffer.from(preparedRectSVG);

  const foreground = await sharp(imageBuffer)
    .resize(outputImageSize, outputImageSize)
    .composite([{
      input: rect,
      blend: 'dest-in'
    }])
    .png().toBuffer();
  return foreground;
}

async function createBackground(imageBuffer: Buffer, width: number, height: number): Promise<Buffer> {
  const bigWidth = Math.round(width * 1.4);
  const bigHeight = Math.round(height * 2.3);
  const background = await sharp(imageBuffer)
    .blur(80)
    .resize(bigWidth, bigHeight, { fit: 'fill' })
    .extract({
      left: Math.round((bigWidth - width) / 2),
      top: Math.round((bigHeight - height) / 2),
      width,
      height
    })
    .toBuffer();
  return background;
}

async function composeImages(background: Buffer, foreground: Buffer, width: number, height: number): Promise<Buffer> {
  const alphaValue = Math.round(0.5 * 255);
  const transparencyMask = Buffer.alloc(width * height, alphaValue);
  const webpOptions: WebpOptions = { quality: 92, effort: 5 };
  const opacity = {
    input: transparencyMask,
    raw: {
      width: 1,
      height: 1,
      channels: 4 as 4
    },
    tile: true,
    blend: 'dest-in' as Blend
  };

  const composedImage = await sharp(background)
    .composite([
      opacity,
      {
        input: foreground,
        gravity: sharp.gravity.center
      },
    ])
    .webp(webpOptions).toBuffer();
  return composedImage;
}

// HELPER CLASS

class FileHelper {
  private async upsertDatabaseFile(
    userId: string | null,
    fileId: string,
    data: Common.ImageMetadata,
    uploadOptions: API.Files.UploadOptions,
  ) {
    await pool.query(`
      INSERT INTO "files" (
        "creatorId",
        "objectId",
        "data",
        "uploadOptions"
      )
      VALUES ($1,$2,$3, $4)
      ON CONFLICT ("objectId")
        DO UPDATE
        SET
          "accessedAt" = now(),
          "creatorId" = CASE
            WHEN "files"."creatorId" IS NULL
            THEN EXCLUDED."creatorId"
            ELSE "files"."creatorId"
          END,
          "data" = CASE
            WHEN "files"."data" IS NULL
            THEN EXCLUDED."data"
            ELSE "files"."data"
          END,
          "uploadOptions" = CASE
            WHEN "files"."uploadOptions" IS NULL
            THEN EXCLUDED."uploadOptions"
            ELSE "files"."uploadOptions"
          END
    `, [
      userId,
      fileId,
      data,
      uploadOptions
    ]);
  }

  private async updateDatabaseFileAccessDate(
    fileIds: string[]
  ) {
    await pool.query(`
      INSERT INTO "files" (
        "objectId"
      )
      VALUES ${fileIds.map(id => format('(%L)', id)).join(',')}
      ON CONFLICT ("objectId")
        DO UPDATE SET "accessedAt" = now()
    `);
  }

  public async convertToJpg(imageBuffer: Buffer, width: number, height: number): Promise<Buffer> {
    let image = sharp(imageBuffer);
    if (width && height) image = image.resize(width, height);
    const jpegOptions: JpegOptions = { quality: 90, progressive: true };
    return await image.jpeg(jpegOptions).toBuffer();
  }

  private convertBase64ToBuffer(base64ImageContentOrBuffer: string | Buffer): Buffer {
    if (typeof base64ImageContentOrBuffer === 'string') {
      return Buffer.from(base64ImageContentOrBuffer, 'base64');
    } else if (base64ImageContentOrBuffer instanceof Buffer) {
      return base64ImageContentOrBuffer;
    } else {
      throw new Error("Invalid input: first parameter needs to be of type string or Buffer");
    }
  }

  public async getFileData({ objectIds }: { objectIds: string[] }) {
    if (objectIds.length === 0) return [];
    const result = await pool.query<{
        creatorId: string | null;
        objectId: string;
        data: Common.ImageMetadata | null;
        uploadOptions: API.Files.UploadOptions | null;
        createdAt: string;
    }>(`
      SELECT
        "creatorId",
        "objectId",
        "data",
        "uploadOptions",
        "createdAt"
      FROM "files"
      WHERE "objectId" = ANY($1)
    `, [objectIds]);
    return result.rows;
  }

  public async saveImage(
    userId: string | null,
    uploadOptions: API.Files.UploadOptions,
    imageBuffer: Buffer,
    resize?: { width?: number, height?: number, maxDim?: number },
    options: SaveIntoS3Options = {}
  ): Promise<{ fileId: string }> {
    const originalImage = sharp(imageBuffer, { animated: options.animated || false });
    const originalMetadata = await originalImage.metadata();

    if (originalMetadata.size) { // try to check by size
      if (originalMetadata.size > config.IMAGE_UPLOAD_SIZE_LIMIT) {
        console.error("Images must have at most 8MB in size");
        throw new Error(errors.server.FILESIZE_EXCEEDED);
      }
    } else if ((originalMetadata.width || 0) + (originalMetadata.height || 0) > 10032) { // 6016 x 4016
      console.error("Image dimensions are too big");
      throw new Error(errors.server.FILESIZE_EXCEEDED);
    }

    let resized: Sharp;
    let resizedBuffer: Buffer;
    const webpOptions: WebpOptions = { quality: 92, effort: 5 };
    if (resize) {
      let finalWidth = resize.width;
      let finalHeight = resize.height;
      if (resize.maxDim) {
        if ((originalMetadata.width || 0) > (originalMetadata.height || 0)) {
          finalWidth = resize.maxDim;
        } else {
          finalHeight = resize.maxDim;
        }
      }
      resized = originalImage.rotate().resize(finalWidth, finalHeight, { fit: 'cover', withoutEnlargement: options.withoutEnlargement || false }).webp(webpOptions);
    } else {
      resized = originalImage.rotate().webp(webpOptions);
    }
    resizedBuffer = await resized.toBuffer();

    // NSFW gate — must run before anything reaches S3. Classifies a
    // deterministic normalization of the *source* buffer (so small+large
    // variants of one upload agree and classify once); with `animated` set,
    // every stored frame is in scope, not just frame 0.
    if (!options.skipModeration) {
      await imageFilter.assertImageAllowed(imageBuffer, {
        uploadType: uploadOptions.type,
        userId,
        animated: options.animated || false,
      });
    }

    const newMetadata = await sharp(resizedBuffer).metadata();
    const fileId = crypto.createHash('sha256').update(resizedBuffer).digest('hex');

    const cgBucketName = 'cg-media';
    const s3Config: S3ClientConfig = {
      region: 'global',
      endpoint: 'http://s3.local:8333',
      credentials: {
        accessKeyId: 'cgadmin',
        secretAccessKey: s3_secret
      },
      forcePathStyle: true
    };
    const client = new S3Client(s3Config);

    const getListBuckets = new ListBucketsCommand({});
    const listBucketsResponse = await client.send(getListBuckets);
    const buckets = listBucketsResponse.Buckets;
    if (buckets) {
      const cgBucket = buckets.find(bucket => bucket.Name === cgBucketName);
      if (!cgBucket) {
        // create bucket
        const createBucket = new CreateBucketCommand({
          Bucket: cgBucketName
        });
        await client.send(createBucket);
      }
    }
    const putObject = new PutObjectCommand({
      // The already materialised buffer, not the `resized` Sharp instance: a
      // Sharp object is a Duplex of unknown length, and since @aws-sdk 3.9x the
      // S3 client rejects unknown-length stream bodies outright
      // ("Invalid value \"undefined\" for header x-amz-decoded-content-length")
      // instead of falling back to chunked encoding. The bytes are identical -
      // streaming the instance only re-ran the whole pipeline a second time.
      Bucket: cgBucketName,
      Key: fileId,
      Body: resizedBuffer
    });
    await client.send(putObject);
    await this.upsertDatabaseFile(
      userId,
      fileId,
      {
        mimeType: `image/${newMetadata.format}`, 
        size: {
          width: newMetadata.width || 0,
          height: newMetadata.height || 0,
        },
      },
      uploadOptions,
    );

    return {
      fileId,
    };
  }

  public async getFile(objectId: string): Promise<Buffer | null> {
    const cgBucketName = 'cg-media';
    const s3Config: S3ClientConfig = {
      region: 'global',
      endpoint: 'http://s3.local:8333',
      credentials: {
        accessKeyId: 'cgadmin',
        secretAccessKey: s3_secret
      },
      forcePathStyle: true
    };
    const client = new S3Client(s3Config);

    const getObject = new GetObjectCommand({
      Bucket: cgBucketName,
      Key: objectId
    });
    const { Body } = await client.send(getObject);
    if (Body) {
      await this.updateDatabaseFileAccessDate([objectId]);

      if (Body instanceof Readable) {
        return new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          Body.on('data', (chunk: Buffer) => chunks.push(chunk));
          Body.once('error', (e) => reject(e));
          Body.once('end', () => resolve(Buffer.concat(chunks)));
        });

      } else if (Body instanceof ReadableStream) {
        return null;

      } else if (Body instanceof Blob) {
        return Buffer.from(await (Body as Blob).arrayBuffer());
      }
    }
    return null;
  }

  public async composeCommunityImage(imageBuffer: Buffer): Promise<Buffer> {
    const width = 1200;
    const height = 630;
    const webpOptions: WebpOptions = { quality: 92, effort: 5 };
    const foreground = await sharp(imageBuffer).resize(410, 410, { fit: 'cover' }).webp(webpOptions).toBuffer(); // await createHexagonalForeground(imageBuffer, Math.round(width * 0.43));
    const background = await createBackground(foreground, width, height);
    const composedImage = await composeImages(background, foreground, width, height);
    return composedImage;
  }

  public async composeProfileImage(imageBuffer: Buffer): Promise<Buffer> {
    const width = 681;
    const height = 368;
    const foreground = await createRoundedForeground(imageBuffer, Math.round(width * 0.33));
    const background = await createBackground(foreground, width, height);
    const composedImage = await composeImages(background, foreground, width, height);
    return composedImage;
  }

  public async getSignedUrls(objectIds: string[]) {
    const hostname = urlConfig.APP_HOSTNAME;
    const protocol = urlConfig.PROTOCOL;
    const presigner = new S3RequestPresigner({
      credentials: {
        accessKeyId: 'cgadmin',
        secretAccessKey: s3_secret
      },
      region: 'global',
      sha256: Hash.bind(null, "sha256") // In Node.js
    });
    // Create a GET request from S3 url.

    const result = await Promise.all(
      objectIds.map(async (objectId) => {
        const s3ObjectUrl = parseUrl(`http://${hostname}:8333/cg-media/${objectId}`);
        const url = await presigner.presign(new HttpRequest(s3ObjectUrl), { expiresIn: s3_signedUrlExpiration });
        url.port =
          config.DEPLOYMENT === 'dev'
          ? protocol === "https"
            ? 8001
            : 8000
          : undefined;
        if (url.query) {
          const signature = url.query['X-Amz-Signature'];
          const timestamp = url.query['X-Amz-Date'];
          const expires = url.query['X-Amz-Expires'];
          url.query = undefined;
          url.path = url.path.replace('cg-media', 'files') + `/${signature}/${timestamp}/${expires}`;
          let formattedURL = formatUrl(url);
          if (protocol === "https") {
            formattedURL = `https://${formattedURL.slice(7)}`;
          }
          return {
            objectId,
            url: formattedURL,
            validUntil: new Date(Date.now() + ((s3_signedUrlExpiration - 60) * 1000)).toISOString(),
          };
        }
        return objectId;
      })
    );
    const errored = result.filter(r => typeof r === "string") as string[];
    if (errored.length > 0) {
      console.error("Some signedUrls could not be constructed, investigate!", errored);
    }
    return result.filter(r => typeof r !== "string") as {
      objectId: string;
      url: string;
      validUntil: string;
    }[];
  }

  public scheduleUserPreviewUpdate(userId: string, fileIdOrBuffer: string | Buffer) {
    setTimeout(async () => {
      await this.updateUserPreview(userId, fileIdOrBuffer);
    }, 0);
  }

  public async updateUserPreview(userId: string, fileIdOrBuffer: string | Buffer) {
    try {
      let buffer: Buffer | null = null;
      if (fileIdOrBuffer instanceof Buffer) {
        buffer = fileIdOrBuffer;
      } else if (typeof fileIdOrBuffer === "string") {
        buffer = await this.getFile(fileIdOrBuffer);
      }
      if (!buffer) {
        throw new Error(errors.server.NOT_FOUND);
      }
      const composedImage = await fileHelper.composeProfileImage(buffer);
      // source image passed the filter when it was stored
      const previewImage = await fileHelper.saveImage(userId, { type: 'userProfileImage' }, composedImage, undefined, { skipModeration: true });
      await userHelper.updateUser(userId, { previewImageId: previewImage.fileId });
    } catch (e) {
      console.log("Error: could not update user profile social preview image", e);
    }
  }

  public scheduleCommunityPreviewUpdate(userId: string, communityId: string, fileIdOrBuffer: string | Buffer) {
    setTimeout(async () => {
      await this.updateCommunityPreview(userId, communityId, fileIdOrBuffer);
    }, 0);
  }

  public async updateCommunityPreview(userId: string, communityId: string, fileIdOrBuffer: string | Buffer) {
    try {
      let buffer: Buffer | null = null;
      if (fileIdOrBuffer instanceof Buffer) {
        buffer = fileIdOrBuffer;
      } else if (typeof fileIdOrBuffer === "string") {
        buffer = await this.getFile(fileIdOrBuffer);
      }
      if (!buffer) {
        throw new Error(errors.server.NOT_FOUND);
      }
      const composedImage = await fileHelper.composeCommunityImage(buffer);
      // source image passed the filter when it was stored
      const previewImage = await fileHelper.saveImage(userId, { type: 'communityLogoSmall' }, composedImage, undefined, { skipModeration: true });
      await communityHelper.updateCommunity({ id: communityId, previewImageId: previewImage.fileId });
    } catch (e) {
      console.log("Error: could not update community social preview image", e);
    }
  }

  public async makeCircleImage(imageBuffer: Buffer, size: number): Promise<Buffer> {
    const roundedImage = await createRoundedForeground(imageBuffer, size);
    return roundedImage;
  }

  public async makeRoundedRectImage(imageBuffer: Buffer, size: number, borderRadius: number): Promise<Buffer> {
    const roundedImage = await createRoundedRectForeground(imageBuffer, size, borderRadius);
    return roundedImage;
  }
}

const fileHelper = new FileHelper();
export default fileHelper;