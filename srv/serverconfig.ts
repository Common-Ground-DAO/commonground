// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import config from './common/config';

const positiveInteger = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const platformOperatorUserIds = Object.freeze((process.env.PLATFORM_OPERATOR_USER_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean));

const serverconfig = {
    SESSION_COOKIE_NAME: config.DEPLOYMENT === 'prod' ? 'connect.sid' : `cg_${config.DEPLOYMENT}.sid`,
    PLATFORM_OPERATOR_USER_IDS: platformOperatorUserIds,
    BOT_USER_OWNER_LIMIT: positiveInteger(process.env.BOT_USER_OWNER_LIMIT, 5),
    BOT_COMMUNITY_OWNER_LIMIT: positiveInteger(process.env.BOT_COMMUNITY_OWNER_LIMIT, 10),
    BOT_PLATFORM_OWNER_LIMIT: positiveInteger(process.env.BOT_PLATFORM_OWNER_LIMIT, 10),
    BOT_ACTIVE_TOKEN_LIMIT: positiveInteger(process.env.BOT_ACTIVE_TOKEN_LIMIT, 10),
    BOT_API_RATE_LIMIT_PER_MINUTE: positiveInteger(process.env.BOT_API_RATE_LIMIT_PER_MINUTE, 120),
    BOT_MESSAGE_RATE_LIMIT_PER_MINUTE: positiveInteger(process.env.BOT_MESSAGE_RATE_LIMIT_PER_MINUTE, 30),
}

export default Object.freeze(serverconfig);
