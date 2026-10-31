// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import common from "../common";
import { messageContentV1Validator } from "../content";

const linkPreviewAttachmentValidator = Joi.object({
  type: Joi.equal("linkPreview").required(),
  title: Joi.string().required(),
  description: Joi.string().required().allow(""),
  imageId: Joi.string().required().allow(""),
  url: Joi.string().required(),
}).strict(true);

const imageAttachmentValidator = Joi.object({
  type: Joi.equal("image").required(),
  imageId: common.ImageId.required(),
  largeImageId: common.ImageId.required(),
}).strict(true);

const giphyAttachmentValidator = Joi.object({
  type: Joi.equal("giphy").required(),
  gifId: Joi.string().required(),
  previewWidth: Joi.number().integer().min(50).max(600).required(),
  previewHeight: Joi.number().equal(200).required(),
}).strict(true);

const attachmentValidator = Joi.alternatives().try(
  imageAttachmentValidator,
  linkPreviewAttachmentValidator,
  giphyAttachmentValidator,
).strict(true);

export const messageAccessValidator = Joi.object({
  channelId: common.Uuid.required(),
  communityId: common.Uuid,
  chatId: common.Uuid,
  callId: common.Uuid,
  articleId: common.Uuid,

  articleCommunityId: common.Uuid,
  articleUserId: common.Uuid,
}).xor('communityId', 'chatId', 'callId', 'articleId').strict(true);

const messageApi = {
  createMessage: Joi.object<API.Messages.createMessage.Request>({
    id: common.Uuid.required(),
    access: messageAccessValidator.required(),
    body: Joi.object({
      version: Joi.equal('1'),
      content: messageContentV1Validator,
    }).required(),
    parentMessageId: Joi.alternatives().try(common.Uuid, Joi.equal(null)).required(),
    attachments: Joi.array().items(attachmentValidator).required(),
  }).strict(true).required(),

  createModerationMessage: Joi.object<API.Messages.createMessage.Request>({
    id: common.Uuid.required(),
    access: messageAccessValidator.required(),
    body: Joi.object({
      version: Joi.equal('1'),
      content: Joi.array().length(1).items(Joi.object({
        type: Joi.string().valid('special').required(),
        userId: common.Uuid.required(),
        action: Joi.string().valid('warn', 'mute', 'banned').required(),
        reason: Joi.when('action', {
          is: 'warn',
          then: Joi.string().valid('Behavior', 'Off-topic', 'Language', 'Spam', 'Breaking rules').required(),
          otherwise: Joi.forbidden(),
        }),
        duration: Joi.when('action', {
          is: 'warn',
          then: Joi.forbidden(),
          otherwise: Joi.string().valid('15m', '1h', '1d', '1w', 'permanently').required(),
        }),
      })).required(),
    }).required(),
    parentMessageId: Joi.equal(null).required(),
    attachments: Joi.array().empty().required(),
  }).strict(true).required(),

  editMessage: Joi.object<API.Messages.editMessage.Request>({
    access: messageAccessValidator.required(),
    id: common.Uuid.required(),
    body: Joi.object({
      version: Joi.equal('1'),
      content: messageContentV1Validator,
    }),
    attachments: Joi.array().items(attachmentValidator),
    parentMessageId: Joi.alternatives().try(common.Uuid, Joi.equal(null)),
  }).strict(true).required(),

  deleteMessage: Joi.object<API.Messages.deleteMessage.Request>({
    access: messageAccessValidator.required(),
    messageId: common.Uuid.required(),
    creatorId: common.Uuid.required(),
  }).strict(true).required(),

  deleteAllUserMessages: Joi.object<API.Messages.deleteAllUserMessages.Request>({
    access: messageAccessValidator.required(),
    creatorId: common.Uuid.required(),
  }).strict(true).required(),

  loadMessages: Joi.object<API.Messages.loadMessages.Request>({
    access: messageAccessValidator.required(),
    order: Joi.string().valid('ASC', 'DESC'),
    createdBefore: common.DateString,
    createdAfter: common.DateString,
  }).strict(true).required(),

  messagesById: Joi.object<API.Messages.messagesById.Request>({
    access: messageAccessValidator.required(),
    messageIds: Joi.array().items(common.Uuid.required()).unique().required(), // at least one
  }).strict(true).required(),

  loadUpdates: Joi.object<API.Messages.loadUpdates.Request>({
    access: messageAccessValidator.required(),
    createdStart: common.DateString.required(),
    createdEnd: common.DateString.required(),
    updatedAfter: common.DateString.required(),
  }).strict(true).required(),

  setReaction: Joi.object<API.Messages.setReaction.Request>({
    access: messageAccessValidator.required(),
    messageId: common.Uuid.required(),
    reaction: common.Emoji.required(),
  }).strict(true).required(),

  unsetReaction: Joi.object<API.Messages.unsetReaction.Request>({
    access: messageAccessValidator.required(),
    messageId: common.Uuid.required(),
  }).strict(true).required(),

  setChannelLastRead: Joi.object<API.Messages.setChannelLastRead.Request>({
    access: messageAccessValidator.required(),
    lastRead: common.DateString.required(),
  }).strict(true).required(),

  getUrlPreview: Joi.object({
    url: Joi.string().max(2048).required(),
  }).strict(true).required(),

  joinArticleEventRoom: Joi.object<API.Messages.joinArticleEventRoom.Request>({
    access: messageAccessValidator.required(),
  }).strict(true).required(),

  leaveArticleEventRoom: Joi.object<API.Messages.leaveArticleEventRoom.Request>({
    access: messageAccessValidator.required(),
  }).strict(true).required(),
}

export default messageApi;