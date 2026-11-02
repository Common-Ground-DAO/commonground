// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Models {
  namespace Message {
    type BodyContentV1 =
      Common.Content.Text |
      Common.Content.Tag |
      Common.Content.Ticker |
      Common.Content.Link |
      Common.Content.RichTextLink |
      Common.Content.Newline |
      Common.Content.Mention;

    type BodyV1 = {
      version: "1",
      content: (BodyContentV1 | Common.Content.ModerationSpecial)[];
    };

    type Body = BodyV1;

    type ImageAttachment = {
      type: 'image',
      imageId: string;
      imageData?: Common.ImageMetadata;
      largeImageId: string;
      largeImageData?: Common.ImageMetadata;
    };

    type LinkPreviewAttachment = {
      type: 'linkPreview',
      title: string;
      description: string;
      imageId: string;
      imageData?: Common.ImageMetadata;
      url: string;
    };

    type GiphyAttachment = {
      type: 'giphy',
      gifId: string;
      previewWidth?: number;
      previewHeight?: number;
    };

    type Attachment = ImageAttachment | LinkPreviewAttachment | GiphyAttachment;

    type Reactions = {
      [emoji: string]: number;
    }
  
    type Message = {
      id: string;
      creatorId: string;
      channelId: string;
      body: Body;
      attachments: Attachment[];
      editedAt: string | null;
      createdAt: Date;
      updatedAt: Date;
      reactions: Reactions;
      ownReaction: string | null;
      parentMessageId: string | null;
      sendStatus?: Models.ItemList.Item["sendStatus"];
      /**
       * chat-sync: per-channel, commit-ordered change sequence of this row
       * (set by the database on every insert and update, deletes included).
       * A higher value is a newer version of the message. chat-sync servers
       * send it on loadMessages, messagesById, getChanges, the createMessage
       * response and all message events. Absent on older servers, on rows
       * not written since the migration (until their next write) and on
       * pending (unsent) items.
       */
      syncSeq?: number;
    };

    type ApiMessage = Omit<Message, "createdAt" | "updatedAt" | "sendStatus"> & {
      createdAt: string;
      updatedAt: string;
    }
  }
}

