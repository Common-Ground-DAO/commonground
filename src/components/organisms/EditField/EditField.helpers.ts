// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import _ from 'lodash';
import React from 'react';
import { Descendant, Range, Text, Editor, Point, Transforms, BaseRange } from 'slate';
import { InMemoryAttachment } from './useAttachments/useAttachments';
import { getDisplayNameString } from '../../../util';
import { linkRegexGenerator } from 'common/validators';

export type TextElement = { type: 'paragraph'; children: Text[]; };
export type MentionElement = { type: 'mention'; children: Text[]; userData: Models.User.Data; };
export type HeaderElement = { type: 'header'; children: Text[]; };
export type ImageElement = { type: 'image'; children: Text[]; imageId: string; largeImageId: string; caption: string; size: Common.Content.MediaSize; id: string; fileCandidate?: File };
export type EmbedElement = { type: 'embed'; children: Text[]; embedId: string; size: Common.Content.MediaSize; id: string; urlCandidate?: string };

export type TextType = 'ticker' | 'link' | 'tag' | 'richTextLink';
export type CustomElement = TextElement | MentionElement | HeaderElement | ImageElement | EmbedElement;
export type CustomText = { text: string; type?: TextType; url?: string; bold?: true, italic?: true };

type LeafContentType =
  Common.Content.Text |
  Common.Content.Tag |
  Common.Content.Ticker |
  Common.Content.Link |
  Common.Content.RichTextLink;

type AllContentType = Models.BaseArticle.ContentElementV2 | Models.Message.BodyContentV1;

export const emptyState: Descendant[] = [{ type: "paragraph", children: [{ text: "" }] }];

// From https://github.com/ianstormtaylor/slate/issues/4162#issuecomment-1127062098
export function currentWord(
  editor: Editor,
  location: Range,
  options: {
    terminator?: string[]
    include?: boolean // Include terminator on extracted string?
    directions?: 'both' | 'left' | 'right'
  } = {},
): Range | undefined {
  const { terminator = [' '], include = false, directions = 'both' } = options;

  const { selection } = editor;
  if (!selection) return;

  // Get start and end, modify it as we move along.
  let [start, end] = Range.edges(location);

  let point: Point = start;

  function move(direction: 'right' | 'left'): boolean {
    const next =
      direction === 'right'
        ? Editor.after(editor, point, { unit: 'character' })
        : Editor.before(editor, point, { unit: 'character' })

    const wordNext =
      next &&
      Editor.string(
        editor,
        direction === 'right' ? { anchor: point, focus: next } : { anchor: next, focus: point },
      )

    const last = wordNext && wordNext[direction === 'right' ? 0 : wordNext.length - 1]
    if (next && last && !terminator.includes(last)) {
      point = next;

      if (point.offset === 0) {
        // Means we've wrapped to beginning of another block
        return false;
      }
    } else {
      return false;
    }

    return true;
  }

  // Move point and update start & end ranges

  // Move forwards
  if (directions !== 'left') {
    point = end;
    while (move('right'));
    end = point;
  }

  // Move backwards
  if (directions !== 'right') {
    point = start;
    while (move('left'));
    start = point;
  }

  if (include) {
    return {
      anchor: Editor.before(editor, start, { unit: 'offset' }) ?? start,
      focus: Editor.after(editor, end, { unit: 'offset' }) ?? end,
    }
  }

  return { anchor: start, focus: end };
}

export function areAllSelectedNodesCorrectType(editor: Editor, foundWordRange: BaseRange, expectedType?: TextType): boolean {
  const resultIterator = Editor.nodes(editor, {
    at: foundWordRange,
    match: n => Text.isText(n)
  });

  // Iterate through found nodes and check that they all match
  let everyNodeIsAssigned = true;
  while (everyNodeIsAssigned) {
    const result = resultIterator.next();
    if (result.value) {
      const [currentNode, nodePath] = result.value;
      const currentNodeType = (currentNode as Text).type;

      // If current node is the starting node and the offset is the same as the text length:
      // Selection actually starts at the end of currentNode, so it does not need to be checked
      if (_.isEqual(nodePath, foundWordRange.anchor.path) && (currentNode as Text).text.length === foundWordRange.anchor.offset) {
        continue;
      }

      // If current node is the ending node and the offset is 0:
      // Selection ends at the start of currentnode, so it does not need to be checked
      if (_.isEqual(nodePath, foundWordRange.focus.path) && foundWordRange.focus.offset === 0) {
        continue;
      }

      // TODO: Ignore rich text link
      if (currentNodeType !== expectedType && currentNodeType !== 'richTextLink') {
        everyNodeIsAssigned = false;
      }
    } else {
      break;
    }
  }

  return everyNodeIsAssigned;
}

export function isFirstNodeOfType(editor: Editor, foundWordRange: BaseRange, expectedType?: TextType): boolean {
  const resultIterator = Editor.nodes(editor, {
    at: foundWordRange,
    match: n => Text.isText(n)
  });

  const result = resultIterator.next();
  if (result.value) {
    const type = (result.value[0] as Text).type;
    return type === expectedType;
  }

  return false;
}

export function isCurrentNodeParagraph(editor: Editor) {
  const resultIterator = Editor.nodes(editor, {
    match: n => (n as any).type === 'paragraph',
    mode: 'all',
  });

  return !!resultIterator.next().value;
}

export function isCurrentNodeEmptyParagraph(editor: Editor) {
  const result = Editor.nodes(editor, { match: node => (node as CustomElement).type === 'paragraph' }).next().value;
  if (result) {
    const typedResult = result[0] as CustomElement;
    return (typedResult.type === 'paragraph' && typedResult.children.length === 1 && typedResult.children[0].text === '');
  }
  return false;
}

export function isEditorEmpty(editor: Editor) {
  if (editor.children.length === 0) return true;
  if (editor.children.length > 1) return false;

  const firstChild = editor.children[0];
  if (firstChild.type === 'paragraph') {
    if (firstChild.children.length > 1) return false;

    const firstSubChild = firstChild.children[0];
    return firstSubChild.text === '';
  }

  return false;
}

export function clearEditor(editor: Editor) {
  Transforms.delete(editor, {
    at: {
      anchor: Editor.start(editor, []),
      focus: Editor.end(editor, []),
    },
  });

  Transforms.setNodes(editor, { type: undefined, url: undefined, bold: undefined, italic: undefined }, { match: Text.isText });
}

export function convertToContentFormat(inputContent: Descendant[]): AllContentType[] {
  function extractParagraph(element: TextElement): AllContentType[] {
    const content: AllContentType[] = [];
    for (const leaf of element.children) {
      // Check for mention element since mention can be inlined
      if (leaf.type as string === 'mention') {
        content.push(...extractMention(leaf as unknown as MentionElement));
      } else {
        content.push(...extractTextLeaf(leaf));
      }
    }

    return content;
  }

  function extractHeader(element: HeaderElement): Common.Content.Header {
    const content: AllContentType[] = [];
    for (const leaf of element.children) {
      content.push(...extractTextLeaf(leaf));
    }

    // Return only text elements
    return {
      type: 'header',
      value: (content.filter(unit => unit.type === 'text')) as Common.Content.Text[]
    };
  }

  function extractImage(element: ImageElement): Common.Content.ArticleImage | null {
    if (!element.imageId) return null;

    return {
      type: 'articleImage',
      imageId: element.imageId,
      largeImageId: element.largeImageId,
      caption: element.caption,
      size: element.size
    };
  }

  function extractEmbed(element: EmbedElement): Common.Content.ArticleEmbed | null {
    if (!element.embedId) return null;

    return {
      type: 'articleEmbed',
      embedId: element.embedId,
      size: element.size,
    };
  }

  function extractMention(element: MentionElement): AllContentType[] {
    return [{
      type: 'mention',
      userId: element.userData.id,
      alias: getDisplayNameString(element.userData) || undefined
    }];
  }

  function extractTextLeaf(text: CustomText): LeafContentType[] {
    if (!text.text) return [];

    let textValue = text.text;
    if (text.type === 'tag' || text.type === 'ticker') {
      textValue = textValue.slice(1);
    }

    // Text and link
    const returnValue: any = {
      type: (text.type || 'text') as LeafContentType["type"],
      value: textValue,
    };
    if (text.bold) returnValue.bold = true;
    if (text.italic) returnValue.italic = true;

    if (text.type === 'richTextLink') {
      return [{
        ...returnValue,
        url: text.url || ''
      }];
    }

    return [returnValue];
  }

  const content: AllContentType[] = [];
  for (const element of inputContent) {
    if (content.length !== 0) content.push({ type: 'newline' });

    if (element.type === 'paragraph') {
      content.push(...extractParagraph(element));
    } else if (element.type === 'mention') {
      content.push(...extractMention(element));
    } else if (element.type === 'header') {
      content.push(extractHeader(element));
    } else if (element.type === 'image') {
      const extractedImage = extractImage(element);
      if (extractedImage) content.push(extractedImage);
    } else if (element.type === 'embed') {
      const extractedEmbed = extractEmbed(element);
      if (extractedEmbed) content.push(extractedEmbed);
    } else {
      console.error('unknown element, could not extract to content type');
    }
  }

  return content;
}

export function convertToMessageBody(inputContent: Descendant[]): Models.Message.Body {
  return {
    version: "1",
    content: convertToContentFormat(inputContent) as Models.Message.BodyContentV1[],
  }
}

export function convertToFieldFormat(content: (Models.BaseArticle.ContentElementV2 | Models.Message.BodyContentV1 | Common.Content.ModerationSpecial)[]): Descendant[] {
  const result: Descendant[] = [];
  let currentChildren: (CustomText | CustomElement)[] = [];
  let skipNextEmptyNewline = false;

  for (const element of content) {
    switch (element.type) {
      case 'text':
        currentChildren.push({ text: element.value, bold: element.bold, italic: element.italic });
        break;
      case 'link':
        currentChildren.push({ type: 'link', text: element.value, bold: element.bold, italic: element.italic });
        break;
      case 'richTextLink':
        currentChildren.push({ type: 'richTextLink', text: element.value, url: element.url, bold: element.bold, italic: element.italic });
        break;
      case 'tag':
        currentChildren.push({ type: 'tag', text: `#${element.value}`, bold: element.bold, italic: element.italic });
        break;
      case 'ticker':
        currentChildren.push({ type: 'ticker', text: `$${element.value}`, bold: element.bold, italic: element.italic });
        break;
      case 'header': {
        const headerChildren: CustomText[] = element.value.map(textEl => ({ text: textEl.value, bold: textEl.bold, italic: textEl.italic }));
        result.push({ type: 'header', children: headerChildren });
        skipNextEmptyNewline = true;
        break;
      }
      case 'articleImage':
        result.push({
          type: 'image',
          caption: element.caption,
          imageId: element.imageId,
          largeImageId: element.largeImageId,
          size: element.size,
          id: element.imageId,
          children: [{ text: '' }]
        });
        skipNextEmptyNewline = true;
        break;
      case 'articleEmbed':
        result.push({
          type: 'embed',
          embedId: element.embedId,
          id: element.embedId,
          size: element.size,
          children: [{ text: '' }]
        });
        skipNextEmptyNewline = true;
        break;
      case 'mention':
        currentChildren.push({
          type: 'mention',
          userData: {
            id: element.userId,
            alias: element.alias || ''
          } as any,
          children: [{ text: '' }]
        });
        break;
      case 'newline':
        // In order to skip adding extra paragraphs when last element added was also a complete element
        if (skipNextEmptyNewline) {
          skipNextEmptyNewline = false;
          break;
        }

        if (currentChildren.length === 0) {
          currentChildren.push({ text: '' });
        }
        result.push({ type: 'paragraph', children: currentChildren as any });
        currentChildren = [];
        break;
      default:
        throw new Error('Unknown type on field format conversion');
    }
  }

  if (currentChildren.length > 0) {
    result.push({ type: 'paragraph', children: currentChildren as any });
  }

  return result;
}

export function insertMention(editor: Editor, range: BaseRange, userData: Models.User.Data) {
  // We know for sure that mention inserts should always start and end on the same path
  // Adding these avoids some random characters getting deleted
  range.anchor.path = range.focus.path;

  const mention: MentionElement = {
    type: 'mention',
    userData,
    children: [{ text: '' }],
  };
  Transforms.select(editor, range);
  Transforms.insertNodes(editor, mention);
  Transforms.move(editor);
}

export const updateAttachmentImageId = (setAttachments: React.Dispatch<React.SetStateAction<InMemoryAttachment[]>>, originalImageId: string) => (imageId: string, largeImageId: string) => {
  setAttachments(oldAttachments => {
    const newAttachments = [...oldAttachments];
    const oldAttachmentIndex = newAttachments.findIndex(att => att.type === 'image' && att.imageId === originalImageId);
    if (oldAttachmentIndex < 0) return oldAttachments;

    const modifiedAttachment = { ...oldAttachments[oldAttachmentIndex], imageId, largeImageId };
    newAttachments[oldAttachmentIndex] = modifiedAttachment;
    return newAttachments;
  });
}

/**
 * Matched by the picked file itself, not by its name: pasted screenshots all
 * share one name (e.g. "image.png") until their upload gives them ids.
 */
export const markAttachmentUploadFailed = (setAttachments: React.Dispatch<React.SetStateAction<InMemoryAttachment[]>>, file: File | undefined) => (failed: boolean) => {
  if (!file) return;
  setAttachments(oldAttachments => {
    const index = oldAttachments.findIndex(att => att.type === 'image' && att.tentativeFile === file);
    if (index < 0 || !!oldAttachments[index].uploadFailed === failed) return oldAttachments;
    const newAttachments = [...oldAttachments];
    newAttachments[index] = { ...oldAttachments[index], uploadFailed: failed };
    return newAttachments;
  });
}

export const removeAttachment = (setAttachments: React.Dispatch<React.SetStateAction<InMemoryAttachment[]>>, imageId: string) => () => {
  setAttachments(oldAttachments => oldAttachments.filter(att => !(att.type === 'image' && att.imageId === imageId)));
}

const mentionRegex = /(^|\s)(@)([^\s@]*)($|\s)/;
const tagAndTickerRegex = /(^|\s)(#|\$)([^\s#$]+)($|\s)/;
const linkRegex = linkRegexGenerator();

export const findAndSetWordType = (editor: Editor, range: BaseRange, word: string, richTextMode: boolean = false) => {
  const tagAndTickerMatches = tagAndTickerRegex.exec(word);
  const mentionMatches = mentionRegex.exec(word);
  const urlMatches = linkRegex.exec(word);

  let resultType: TextType | undefined = undefined;
  let mentionValue: string | undefined = undefined;
  let mentionRange: BaseRange | undefined = undefined;
  if (!richTextMode && tagAndTickerMatches) {
    resultType = tagAndTickerMatches[2] === '#' ? 'tag' : 'ticker';
  } else if (urlMatches) {
    resultType = 'link';
  } else if (!richTextMode && mentionMatches) {
    const rangeClone = _.clone(range);
    if (word.startsWith(' ')) rangeClone.anchor.offset += 1;
    if (word.endsWith(' ')) rangeClone.focus.offset -= 1;

    mentionValue = mentionMatches[3];
    mentionRange = rangeClone;
  }

  // Assign only if currentNodes do not match selected type
  const everyNodeIsAssigned = areAllSelectedNodesCorrectType(editor, range, resultType);
  if (!everyNodeIsAssigned) {
    // FIXME: PUT ME BACK IN IF BAD STATE
    // if (resultType) {
    //   // Remove first and last characters from range if they are blank spaces
    //   if (foundWord.startsWith(' ')) foundWordRange.anchor.offset += 1;
    //   if (foundWord.endsWith(' ')) foundWordRange.focus.offset -= 1;
    // }
    Transforms.setNodes(editor, { type: resultType }, { match: Text.isText, at: range, split: true });
  }

  return {
    resultType,
    mentionData: (mentionValue && mentionRange) ? {
      mentionValue,
      mentionRange
    } : undefined
  }
}

export const recalculateNodeTypes = (editor: Editor, richTextMode: boolean = false) => {
  const children = editor.children;

  for (let currentNode = 0; currentNode < children.length; currentNode++) {
    const child = children[currentNode];
    if (child.type !== 'paragraph') {
      continue;
    }

    const paragraphChildren = child.children;
    for (let currentPath = 0; currentPath < paragraphChildren.length; currentPath++) {
      const paragraphChild = paragraphChildren[currentPath];

      if (paragraphChild.type === undefined || paragraphChild.type === 'link') {
        let slowCounter = 0;
        let fastCounter = 0;

        const text = paragraphChild.text;
        const textLength = text.length;

        while (slowCounter < textLength) {
          // Skip any leading spaces
          while (slowCounter < textLength && text[slowCounter] === ' ') {
            slowCounter++;
          }
          fastCounter = slowCounter;

          // Move fast counter until we find a space or end of text
          while (fastCounter < textLength && text[fastCounter] !== ' ') {
            fastCounter++;
          }

          // Get the word between slow and fast counters
          const word = text.slice(slowCounter, fastCounter);

          // Find and set word type
          findAndSetWordType(editor, {
            anchor: {
              path: [currentNode, currentPath],
              offset: slowCounter
            },
            focus: {
              path: [currentNode, currentPath],
              offset: fastCounter
            }
          }, word, richTextMode);

          // Move both counters past the space
          slowCounter = fastCounter + 1;
          fastCounter = slowCounter;
        }
      }
    }
  }
}
