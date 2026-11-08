// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

export function convertUuidToBinary(uuid: string) {
  const uuidParts = uuid.split("-");
  const uuidBinary = Buffer.concat([
    Buffer.from(uuidParts[0], "hex"),
    Buffer.from(uuidParts[1], "hex"),
    Buffer.from(uuidParts[2], "hex"),
    Buffer.from(uuidParts[3], "hex"),
    Buffer.from(uuidParts[4], "hex"),
  ]);
  return uuidBinary.toString("utf16le");
}

export function convertBinaryToUuid(uuid: string) {
  const uuidBinary = Buffer.from(uuid, "utf16le");
  const uuidParts = [
    uuidBinary.slice(0, 4).toString("hex"),
    uuidBinary.slice(4, 6).toString("hex"),
    uuidBinary.slice(6, 8).toString("hex"),
    uuidBinary.slice(8, 10).toString("hex"),
    uuidBinary.slice(10).toString("hex"),
  ];
  return uuidParts.join("-");
}

function convertMemberArrayItem(item: [string, string[]]): [string, string[]] {
  return [convertBinaryToUuid(item[0]), item[1].map(convertBinaryToUuid)];
}

export function convertBinaryMemberListToUuid(memberList: Models.Community.ChannelMemberList): Models.Community.ChannelMemberList;
export function convertBinaryMemberListToUuid(memberList: Models.Community.MemberList): Models.Community.MemberList;
export function convertBinaryMemberListToUuid(memberList: Models.Community.ChannelMemberList | Models.Community.MemberList): Models.Community.ChannelMemberList | Models.Community.MemberList {
  if ('online' in memberList) {
    const result: Models.Community.MemberList = {
      totalCount: memberList.totalCount,
      resultCount: memberList.resultCount,
      roles: memberList.roles.map(r => [convertBinaryToUuid(r[0]), r[1]]),
      online: memberList.online.map(convertMemberArrayItem),
      offline: memberList.offline.map(convertMemberArrayItem),
    };
    return result;
  }
  else {
    const result: Models.Community.ChannelMemberList = {
      count: memberList.count,
      adminCount: memberList.adminCount,
      moderatorCount: memberList.moderatorCount,
      writerCount: memberList.writerCount,
      readerCount: memberList.readerCount,
      offlineCount: memberList.offlineCount,
      admin: memberList.admin.map(convertMemberArrayItem),
      moderator: memberList.moderator.map(convertMemberArrayItem),
      writer: memberList.writer.map(convertMemberArrayItem),
      reader: memberList.reader.map(convertMemberArrayItem),
      offline: memberList.offline.map(convertMemberArrayItem),
    };
    return result;
  }
}
/**
 * Merges two member id lists, each sorted by `compare`, into one list sorted
 * by `compare` (for a total order the result equals sorting both together).
 */
export function mergeSortedMemberIds(a: string[], b: string[], compare: (x: string, y: string) => number): string[] {
  const result: string[] = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) {
    result[k++] = compare(a[i], b[j]) <= 0 ? a[i++] : b[j++];
  }
  while (i < a.length) {
    result[k++] = a[i++];
  }
  while (j < b.length) {
    result[k++] = b[j++];
  }
  return result;
}
