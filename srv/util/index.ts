// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import fs from "fs";
import crypto from "crypto";
import http from 'http';
import https from "https";
import config from "../common/config";

// moves a file to a new location
// if oldPath and newPath are not in the same
// filesystem, falls back to copying
export async function move(oldPath: string, newPath: string) {
  return new Promise<void>((resolve, reject) => {
    fs.rename(oldPath, newPath, function (err) {
      if (err) {
        if (err.code === 'EXDEV') {
          copy();
        } else {
          reject(err);
        }
        return;
      }
      resolve();
    });

    function copy() {
      var readStream = fs.createReadStream(oldPath);
      var writeStream = fs.createWriteStream(newPath);

      readStream.on('error', reject);
      writeStream.on('error', reject);

      readStream.on('close', function () {
        fs.unlink(oldPath, function (err) {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      readStream.pipe(writeStream);
    }
  });
}

export async function sha256(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    var algo = 'sha256';
    var shasum = crypto.createHash(algo);

    var s = fs.createReadStream(filePath);
    s.on('data', function (d) { shasum.update(d); });
    s.on('end', function () {
      var d = shasum.digest('hex');
      resolve(d);
    });
    s.on('error', function (e) {
      reject(e);
    });
  });
}

export async function sleep(ms: number) {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}

export async function requestData(url: string, acceptContentTypes?: string[]) {
  return await new Promise<ReturnType<typeof handleRequest> extends Promise<infer T> ? T : never>(async (resolve, reject) => {
    let request: http.ClientRequest;
    let rejected = false;
    const cb = async (msg: http.IncomingMessage) => {
      try {
        resolve(await handleRequest(msg, acceptContentTypes));
      } catch (e) {
        if (!rejected) {
          rejected = true;
          reject(e);
        }
      }
    }
    if (url.startsWith('https')) {
      request = https.request(url, cb);
    } else if (url.startsWith('http')) {
      request = http.request(url, cb);
    } else {
      reject(new Error(`Unknown protocol ${url}`));
      return;
    }
    request.on('error', error => {
      if (!rejected) {
        rejected = true;
        reject(error);
      }
    });
    request.end();
  });
}

async function handleRequest(msg: http.IncomingMessage, acceptedContentTypes?: string[]) {
  return new Promise<{ contentType: string, buffer: Buffer }>((resolve, reject) => {
    const { statusCode } = msg;
    const contentType = msg.headers['content-type'];

    let error: Error | undefined;
    if (statusCode !== 200) {
      error = new Error(`Request failed.\nStatus Code: ${statusCode}`);
    } else if (!contentType || (acceptedContentTypes && acceptedContentTypes.indexOf(contentType) === -1)) {
      error = new Error(`Invalid content type.\nExpected ${acceptedContentTypes?.join(',')} but received ${contentType}`);
    }
    if (error) {
      msg.resume();
    }

    let data: any[] = [];
    let rejected = false;
    msg.on('data', chunk => {
      data.push(chunk);
    });
    msg.on("error", (err) => {
      if (!rejected) {
        rejected = true;
        reject(err);
      }
    });
    msg.on("end", () => {
      if (error || !contentType || rejected) {
        console.log(Buffer.concat(data).toString().substring(0, 500));
        if (!rejected) {
          rejected = true;
          reject(error);
        }
      } else {
        resolve({
          contentType,
          buffer: Buffer.concat(data)
        });
      }
    });
  });
}

const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function randomString(length: number = 20) {
  let str = '';
  for (let i = 0; i < length; i++) {
    str += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return str;
}

export function realRandomHexString(byteLength: number = 16) {
  return crypto.randomBytes(byteLength).toString('hex');
}

export const isoDateRe = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*)?)((-(\d{2}):(\d{2})|Z)?)$/;
export const uuidRe = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export function dockerSecret(secretName: string) {
  if (!fs.existsSync(`/run/secrets/${secretName}`)) {
    if (config.DEPLOYMENT !== 'dev') {
      console.warn(`WARNING! Could not find the secret ${secretName}, this should not happen outside of development mode!`);
    }
    return false;
  } else {
    try {
      return fs.readFileSync(`/run/secrets/${secretName}`, 'utf8');
    } catch (err) {
      console.error(`An error occurred while trying to read the secret: ${secretName}. Err: ${err}`);
      return false;
    }
  }
};

export function getTruncatedId(userId: string) {
  userId = userId || '';
  return `${userId.slice(0, 4)}...${userId.slice(-4)}`;
}

export function getDisplayNameString(userData: Pick<Models.User.Data, 'id' | 'displayAccount' | 'accounts'>) {
  if (userData.displayAccount) {
    return userData.accounts.find(acc => acc.type === userData.displayAccount)?.displayName || getTruncatedId(userData.id);
  }
  return getTruncatedId(userData.id);
}

export const userRoomKey = (userId: string) => `user:${userId}`;
export const communityRoomKey = (communityId: string) => `community:${communityId}`;
export const roleRoomKey = (roleId: string) => `role:${roleId}`;
export const deviceRoomKey = (deviceId: string) => `device:${deviceId}`;
export const expressSessionRoomKey = (sessionId: string) => `expressSession:${sessionId}`;
export const articleRoomKey = (articleId: string) => `article:${articleId}`;
export const botTokenRoomKey = (tokenId: string) => `botToken:${tokenId}`;
