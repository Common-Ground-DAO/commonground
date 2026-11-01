// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from "./errors";
import config from "./config";
import { DurationOption } from "./enums";
import Joi from "joi";
import { tlds } from "@hapi/tlds";

export function linkRegexGenerator(options?: { pureLink?: boolean; }): RegExp {
  const protocol = "https?://";
  const userWithPassword = "([a-zA-Z0-9\\-._~%!$&'\\(\\)*+,;=]+(:[^@]+)?@)?";
  const domain = "[a-zA-Z0-9\\-._~%]+";
  const ipv4 = "\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}";
  const ipv6 = "\\[[a-f0-9:.]+\\]";
  const host = `(${domain}|${ipv4}|${ipv6})`;
  const port = "(:[0-9]+)?";
  const path = "(\\/[a-zA-Z0-9\\-._~%!$&'()*+,;=:@]+)*\\/?";
  const query = "(\\?[a-zA-Z0-9\\-._~%!$&'()*+,;=:@/?]*)?";
  const fragment = "(\\#[a-zA-Z0-9\\-._~%!$&'()*+,;=:@/?]*)?";
  const pathWithAuthority = protocol + userWithPassword + host + port + path + query + fragment; // it covers all http(s)://xxxx urls

  const domainWithoutProtocol = "(((?!]\\-))(xn\\-\\-)?[a-z0-9\\-_]{0,61}[a-z0-9]{1,1}\\.)*(xn\\-\\-)?[a-zA-Z]+[a-zA-Z0-9\\-\\._~%]{0,2}[a-zA-Z0-9]\\.[a-z]{2,}"; // t.my, t-p.myc, xn--abc.com, abc.co.uk ....
  const hostWithoutProtocol = `(localhost|${domainWithoutProtocol}|${ipv4}|${ipv6})`;
  const pathWithoutAuthority = hostWithoutProtocol + port + path + query + fragment; // it covers all urls without http(s) and authority

  if (options && options.pureLink) {
    return new RegExp(`^(${pathWithAuthority}|${pathWithoutAuthority})$`);
  } else {
    return new RegExp(`(^|\\s)(${pathWithAuthority}|${pathWithoutAuthority})($|\\s|[.,;])`);
  }
};

const onlyLinkRegex = linkRegexGenerator({pureLink: true});
const idRegex = /^[a-z0-9]{10,18}$/i;
const reAddr = /^0x[0-9a-f]{40}$/;

export function validateAddress(address: Common.Address) {
  if (typeof address !== 'string' || !address.match(reAddr)) {
    throw new Error('Invalid Address');
  }
}

const invalidBody = () => {
  throw new Error('Invalid Message Body');
};

const validDurations: Common.Content.DurationOption[] = [DurationOption.FIFTEENMIN, DurationOption.ONEHOUR, DurationOption.ONEDAY, DurationOption.ONEWEEK, DurationOption.PERMANENTLY];
const validWarnReasons: Common.Content.WarnReason[] = ["Behavior", "Breaking rules", "Language", "Off-topic", "Spam"];

export function validateMessageBody(body: Models.Message.Body) {
  switch (body.version) {
    case '1': {
      if (Object.keys(body).length !== 2 || !Array.isArray(body.content)) {
        invalidBody();
      }
      for (const c of body.content) {
        switch (c.type) {
          case 'link':
          case 'tag':
          case 'text':
          case 'ticker': {
            if (
              Object.keys(c).length !== 2 ||
              typeof c.value !== 'string' ||
              c.value.length === 0 ||
              (c.type === 'link' && !c.value.match(onlyLinkRegex))
            ) {
              invalidBody();
            }
            break;
          }
          case 'richTextLink': {
            if (
              Object.keys(c).length !== 3 ||
              typeof c.value !== 'string' ||
              c.value.length === 0
            ) {
              invalidBody();
            }
            break;
          }
          case 'newline': {
            if (Object.keys(c).length !== 1) {
              invalidBody();
            }
            break;
          }
          case 'mention': {
            const keyLen = Object.keys(c).length;
            //validateAddress(c.address);
            if (keyLen < 2 || keyLen > 3 || (c.alias !== undefined && typeof c.alias !== 'string')) {
              invalidBody();
            }
            break;
          }
          case 'special': {
            const keyLen = Object.keys(c).length;
            //validateAddress(c.address);
            if (
              keyLen !== 4 ||
              body.content.length !== 1 ||
              !(["warn", "mute", "banned"].includes(c.action)) ||
              (c.action === "warn" && !(validWarnReasons.includes(c.reason))) ||
              (c.action !== "warn" && !(validDurations.includes(c.duration)))
            ) {
              invalidBody();
            }
            break;
          }
          default: {
            invalidBody();
          }
        }
      }
      break;
    }
    default: {
      invalidBody();
    }
  }
}

export function validateAccessRules(rules: Models.Community.AccessRules): void {
  const properties = Object.keys(rules);
  if (properties.length === 1 && "rule1" in rules) {
    validateGatingRule(rules.rule1);
  } else if (
    properties.length === 3 &&
    "rule1" in rules && "rule2" in rules && "logic" in rules &&
    (rules.logic === "and" || rules.logic === "or")
  ) {
    validateGatingRule(rules.rule1);
    validateGatingRule(rules.rule2);
  } else {
    throw new Error("Invalid gating rules");
  }
}

export function validateGatingRule(rule: Models.Community.GatingRule) {
  const properties = Object.keys(rule);
  if (!(
    typeof rule === "object" &&
    "contractId" in rule && "type" in rule && "amount" in rule &&
    typeof rule.contractId === "string" &&
    typeof rule.amount === "string" &&
    !!rule.amount.match(/^\d+$/) &&
    BigInt(rule.amount) >= BigInt(0) &&
    // next rule: amount < 2 ** 256
    BigInt(rule.amount) < BigInt("115792089237316195423570985008687907853269984665640564039457584007913129639936") &&
    typeof rule.type === "string" &&
    (
      (
        properties.length === 3 &&
        ["ERC20", "ERC721"].includes(rule.type)
      )
      ||
      (
        properties.length === 4 &&
        rule.type === "ERC1155" &&
        "tokenId" in rule && rule.tokenId.match(/^\d+/)
      )
    )
  )) {
    throw new Error("Invalid gating rules");
  }
}

const validChains = Object.keys(config.AVAILABLE_CHAINS) as Models.Contract.ChainIdentifier[];
export function validateChain(chain: Models.Contract.ChainIdentifier) {
  if (!validChains.includes(chain)) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
}

export function validateReaction(reaction: string): void {
  // TODO: check unicode range U+1F600..U+1F64F
  if (!reaction || reaction.length > 3) {
    throw new Error('Cannot validate empty reaction');
  }

  // TODO use regex to check if valid emoji https://github.com/mathiasbynens/emoji-regex
}

const alphanumericWSpacesRegex = /^[ a-z0-9]*$/i;
const tagRegex = /^[ a-z0-9-_/]*$/i;
const regex_emoji = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F9B0}-\u{1F9B3}]/u;
const emojiError = "We all love emojis but we want to keep CG as clean as possible. Try letters?";
const tagSpecialCharacterError = 'Those special characters are cool! Unfortunately, we only allow A-Z and 0-9 for now.';

export function getCharLimitError(charLimit: number) {
  return `You’ve reached the ${charLimit} character limit! Well done!`;
}

export function validateGenericTextInput(text: string, charLimit?: number) : string | undefined {
  if(regex_emoji.test(text)) {
    return emojiError;
  } else if (text.length > (charLimit || 30)) {
    return getCharLimitError(charLimit || 30);
  } else {
    return undefined;
  }
}

export function validateTagTextInput(text: string, charLimit?: number) : string | undefined {
  if(!tagRegex.test(text)) {
    return tagSpecialCharacterError;
  } else if (text.length > (charLimit || 30)) {
    return getCharLimitError(charLimit || 30);
  } else {
    return undefined;
  }
}

export const EmailValidator = Joi.string().email({ tlds: { allow: tlds } }).required();
export function validateEmailInput(text: string): string | undefined {
  const { error } = EmailValidator.validate(text);
  if (error) {
    return 'That email doesn’t seem right, please double check';
  }
  /*
  // how-can-i-validate-an-email-address-using-a-regular-expression
  const regexEmail = "^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|\"(?:[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x21\\x23-\\x5b\\x5d-\\x7f]|\\\\[\\x01-\\x09\\x0b\\x0c\\x0e-\\x7f])*\")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\\[(?:(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9]))\\.){3}(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9])|[a-z0-9-]*[a-z0-9]:(?:[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x21-\\x5a\\x53-\\x7f]|\\\\[\\x01-\\x09\\x0b\\x0c\\x0e-\\x7f])+)\\])$";
  const regexp = new RegExp(regexEmail, 'i');
  if (!regexp.test(text)) {
    return 'That email doesn’t seem right, please double check';
  }
  */
  return undefined;
}

export function validateGroupId(id: string): void {
  if (!idRegex.test(id) || id.length !== 10) {
    throw new Error("Invalid group id");
  }
}

export function validateAreaId(id: string): void {
  if (!idRegex.test(id) || id.length !== 14) {
    throw new Error("Invalid group id");
  }
}

export function validateChannelId(id: string): void {
  if (!idRegex.test(id) || id.length !== 18) {
    throw new Error("Invalid group id");
  }
}

export function parseAreaId(id: string): {
  communityId: string;
} {
  if (typeof id !== "string" || id.length !== 14) {
    throw new Error("Invalid ID");
  }

  const communityId = id.slice(0,10);
  return {
    communityId,
  };
}

export function parseChannelId(id: string): {
  communityId: string;
  areaId: string;
} {
  if (typeof id !== "string" || id.length !== 18) {
    throw new Error("Invalid ID");
  }

  const communityId = id.slice(0,10);
  const areaId = id.slice(0,14);
  return {
    communityId,
    areaId
  };
}

export function parseId(id: string): {
  communityId: string;
  areaId?: string;
  channelId?: string;
} {
  if (typeof id !== "string") {
    throw new Error("Invalid ID");
  }
  if (![10,14,18].includes(id.length)) {
    console.warn(`id ${id} is of incorrect length`);
  }

  const communityId = id.slice(0,10) as string;
  const areaId = id.length >= 14 ? id.slice(0,14) : undefined;
  const channelId = id.length >= 18 ? id.slice(0,18) : undefined;
  return {
    communityId,
    areaId,
    channelId
  };
}

export async function validateFractalData(data: Common.FractalData) {
  if (
    typeof data.address === "string" &&
    typeof data.fractalId === "string" &&
    typeof data.proof === "string" &&
    typeof data.approvedAt === "number" && 
    typeof data.validUntil === "number" &&
    data.validUntil * 1000 > Date.now()
  ) {
    const { recoverPersonalSignature } = await import('@metamask/eth-sig-util');
    const signer = recoverPersonalSignature({
      data: `${data.address.toLowerCase()};${data.fractalId.toLowerCase()};${data.approvedAt};${data.validUntil};level:uniqueness+wallet;citizenship_not:;residency_not:`,
      signature: data.proof
    });
    if (signer.toLowerCase() === config.FRACTAL_SIGNER.toLowerCase()) {
      return;
    }
  }
  throw new Error("Invalid Fractal Data");
}

export function validatePassword(password: string, minLength: number): string {
  if (password.length < minLength) {
    return `Use at least ${minLength} characters.`;
  }

  // const withoutRepeatedCharacters = password.replace(/[^\w\s]|(.)(?=\1)/gi, ""); 
  // if (withoutRepeatedCharacters.length < minLength) {
  //   return `Password contains too much repeated characters`;
  // }

  // const lowerCase = password.match(/[a-z]/);
  // const upperCase = password.match(/[A-Z]/);
  // const numbers = password.match(/[0-9]/);
  // const specialCharacters = password.match(/[^0-9A-Za-z]/);

  // if (!lowerCase) {
  //   return `Password has to contain a lowercase letter`;
  // }

  // if (!upperCase) {
  //   return `Password has to contain an uppercase letter`;
  // }

  // if (!numbers) {
  //   return `Password has to contain a number`;
  // }

  // if (!specialCharacters) {
  //   return `Password has to contain a special character`;
  // }

  return '';
}

export const validateEmailRegex = /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/;
