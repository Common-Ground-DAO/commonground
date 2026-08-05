// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Editor, Node, Transforms } from "slate";
import { ImageElement } from "../EditField.helpers";
import config from "../../../../common/config";
import fileApi from "data/api/file";
import { imageUploadErrorText } from "moderation/imageUploadError";

export const validateAndUpdateImage = async (editor: Editor, file: File, id: string): Promise<string | undefined> =>  {
    if (file.size > config.IMAGE_UPLOAD_SIZE_LIMIT) {
      // Warn error, over upload limit
      return 'Images must have at most 5MB in size';
    } else {
      try {
        // Remove imageId
        Transforms.setNodes(editor, { imageId: '' }, {
          match: matchNodeRule(id),
          at: []
        });

        // Upload, get image id
        const { imageId, largeImageId } = await fileApi.uploadImage({
          type: "articleContentImage",
        }, file);

        Transforms.setNodes(editor, { imageId, largeImageId }, {
          match: matchNodeRule(id),
          at: []
        });
      } catch (err: any) {
        return imageUploadErrorText(err, "An unknown error has occurred, please try again");
      }
    }
}

export const matchNodeRule = (targetId: string) => (node: Node) => {
    const nodeTyped = node as ImageElement;
    return (nodeTyped as ImageElement).type === 'image' && nodeTyped.id === targetId;
  }