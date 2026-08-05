// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import './EditField.css';
import ReactDOM from 'react-dom';
import _ from 'lodash';
import { useDropzone } from 'react-dropzone'
import { BaseEditor, createEditor, Range, Text, Editor, Transforms, Descendant } from 'slate';
import { HistoryEditor, withHistory } from 'slate-history'
import { Slate, Editable, withReact, ReactEditor, RenderElementProps, RenderLeafProps, useSelected, useFocused, RenderPlaceholderProps } from 'slate-react';
import { getDisplayNameString } from '../../../util';
import { clearEditor, convertToMessageBody, currentWord, CustomElement, CustomText, emptyState, findAndSetWordType, insertMention, isCurrentNodeEmptyParagraph, isCurrentNodeParagraph, isFirstNodeOfType, MentionElement, recalculateNodeTypes, removeAttachment, updateAttachmentImageId } from './EditField.helpers';

import ImageIcon from "../../atoms/icons/16/Image.svg?react";
import Spinner from '../../../components/atoms/icons/16/Spinner.svg?react';
import CheckmarkIcon from '../../../components/atoms/icons/16/Checkmark.svg?react';
import CloseIcon from '../../../components/atoms/icons/16/Close.svg?react';
import MentionIcon from '../../../components/atoms/icons/20/MentionLarge.svg?react';
import EmojiOutlineIcon from "../../atoms/icons/24/EmojiOutlineIcon.svg?react";
import PaperPlaneIcon from "../../atoms/icons/misc/PaperPlane.svg?react";

import MentionSuggestion from './MentionSuggestion/MentionSuggestion';
import Scrollable from '../../molecules/Scrollable/Scrollable';
import { linkRegexGenerator } from '../../../common/validators';
import HoveringToolbar from './HoveringToolbar/HoveringToolbar';
import { Popover } from '../../atoms/Tooltip/Tooltip';
import FieldMediaImage from './FieldMediaImage/FieldMediaImage';
import { useWindowSizeContext } from '../../../context/WindowSizeProvider';

import FieldEmbed from './FieldEmbed/FieldEmbed';
import MediaPickerDropdown, { addImageMedia } from './MediaPickerDropdown/MediaPickerDropdown';
import MediaAttachment from '../../molecules/MediaAttachment/MediaAttachment';
import Button from '../../atoms/Button/Button';
import AttachmentDropdown from './AttachmentDropdown/AttachmentDropdown';
import { addFiles } from './AttachmentDropdown/AttachmentDropdown.helpers';
import EditFieldReplyPreview from './EditFieldReplyPreview';
import SimpleLink from '../../atoms/SimpleLink/SimpleLink';
import Tag from '../../atoms/Tag/Tag';
import AddLinkModal from './AddLinkModal/AddLinkModal';
import LinkPreview from 'components/molecules/LinkPreview/LinkPreview';
import { useAttachments } from './useAttachments/useAttachments';
import LinkPreviewSkeleton from 'components/molecules/LinkPreview/LinkPreviewSkeleton';
import communityApi from 'data/api/community';
import { useMultipleUserData } from 'context/UserDataProvider';
import GiphyPicker from './GiphyPicker/GiphyPicker';
import { giphyEnabled } from 'util/giphy';
import GiphyAttachment from 'components/molecules/GiphyAttachment/GiphyAttachment';
import EmojiPickerTooltip from 'components/molecules/EmojiPickerTooltip/EmojiPickerTooltip';
import { useSnackbarContext } from 'context/SnackbarContext';

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor & HistoryEditor
    Element: CustomElement
    Text: CustomText
  }
}

// const mentionRegex = /(^|\s)(@)([^\s@]*)($|\s)/;
// const tagAndTickerRegex = /(^|\s)(#|\$)([^\s#$]+)($|\s)/;
const linkRegex = linkRegexGenerator();

const withElements = (editor: Editor) => {
  const { isInline, isVoid } = editor;

  editor.isInline = (element) => element.type === 'mention' || isInline(element);
  editor.isVoid = (element) => element.type === 'mention' || element.type === 'image' || element.type === 'embed' || isVoid(element);

  return editor;
}

type EditFieldHandle = {
  setCurrentValue: (value: Descendant[]) => void;
  setCurrentAttachments: (attachments: Models.Message.Attachment[]) => void;
  focus: () => void;
};

type Props = {
  mentionableUsersSource?: {
    type: 'community-channel';
    communityId: string;
    channelId: string;
  };
  send?: (body: Models.Message.Body, attachments: Models.Message.Attachment[]) => Promise<boolean>;
  placeholder: string;
  onChange?: (value: Descendant[]) => void;
  initialValue?: Descendant[];
  initialAttachments?: Models.Message.Attachment[];
  overrideClassName?: string;
  overridePlaceholderClassName?: string;
  tabIndex?: number;

  replyingTo?: {
    id: string;
    senderId: string;
    body: Models.Message.Body;
  } | null,
  cancelReply?: () => void

  richTextMode?: true;
  callMode?: true;
  disableAttachments?: true;
  isEditing?: boolean;
  attachmentLimit?: number;

  isFocused?: boolean;
  setFocused?: (value: boolean) => void;
};

const EditFieldThree: React.ForwardRefRenderFunction<EditFieldHandle, Props> = (props, thisRef) => {
  const { send, onChange, overridePlaceholderClassName, isEditing, isFocused, setFocused, tabIndex, callMode, attachmentLimit = 10 } = props;
  const { showSnackbar } = useSnackbarContext();

  const { isMobile } = useWindowSizeContext();
  const [recreateOnErrorCounter, setRecreateOnErrorCounter] = useState(0);
  const editor = React.useMemo(() => (withHistory(withElements(withReact(createEditor())))), []);
  const hasInitializedValue = useRef(false);

  const [mentionSearchValue, setMentionSearchValue] = React.useState<string | undefined>();
  const [mentionTargetRange, setMentionTargetRange] = React.useState<Range | undefined>();
  const [mentionIndex, setMentionIndex] = React.useState<number>(0);
  const [mentionableUserIds, setMentionableUserIds] = React.useState<string[]>([]);
  const [showEmojiPicker, setShowEmojiPicker] = React.useState(false);
  const [lockFocus, setLockFocus] = React.useState(false);

  const { attachments, setAttachments, parseLinks, loadingLinkAttachment, removePreview } = useAttachments(props.initialAttachments);
  const [attachmentError, setAttachmentError] = React.useState('');
  const canMention = useMemo(() => !!props.mentionableUsersSource, [props.mentionableUsersSource]);

  const mentionsRef = React.useRef<HTMLDivElement>(null);
  const emojiTriggerRef = React.useRef<HTMLButtonElement>(null);
  const emojiPickerRef = React.useRef<HTMLDivElement>(null);
  const richMediaButtonRef = React.useRef<HTMLDivElement>(null);
  const addMentionButtonRef = React.useRef<HTMLDivElement>(null);
  const mentionRetrievalDebounceRef = React.useRef<any>(undefined);

  const __filteredUsers = useMultipleUserData(mentionableUserIds);

  const filteredUsers = React.useMemo(() => {
    if (!__filteredUsers || mentionSearchValue === undefined) return [];
    const lowerSearchValue = mentionSearchValue.toLocaleLowerCase();
    return Object.values(__filteredUsers).filter(user => {
      if (!user) return false;
      const displayName = getDisplayNameString(user);
      return displayName.toLocaleLowerCase().startsWith(lowerSearchValue);
    }) as Models.User.Data[];
  }, [__filteredUsers, mentionSearchValue]);

  const setCurrentValue = useCallback((value: Descendant[]) => {
    clearEditor(editor);
    Transforms.insertNodes(editor, value, { at: [0] });
    Transforms.removeNodes(editor, { at: Editor.end(editor, []) });
  }, [editor]);

  const setCurrentAttachments = useCallback((attachments: Models.Message.Attachment[]) => {
    setAttachments(attachments.map(att => ({ ...att, state: 'INITIAL' })));
  }, [setAttachments]);

  const focus = useCallback(() => {
    const endOfEditor = Editor.end(editor, []);
    Transforms.select(editor, { anchor: endOfEditor, focus: endOfEditor });
    ReactEditor.focus(editor);
    setFocused?.(true);
  }, [editor, setFocused]);

  useImperativeHandle(thisRef, () => ({
    setCurrentValue,
    setCurrentAttachments,
    focus,
  }), [setCurrentValue, setCurrentAttachments, focus]);

  const startHidingAttachmentError = React.useCallback(() => {
    const element = document.querySelector('.attachmentErrorContainer');
    if (element?.className.includes('hiding')) return;

    if (element) {
      element.className += ' hiding';
    }

    setTimeout(() => {
      setAttachmentError('');
    }, 200);
  }, [setAttachmentError]);

  const setAttachmentUploadedState = React.useCallback((imageId: string, state: boolean) => {
    setAttachments(oldAttachments => {
      const oldAttachmentIndex = oldAttachments.findIndex(att => att.type === 'image' && att.imageId === imageId);
      const newAttachments = [...oldAttachments];
      newAttachments[oldAttachmentIndex].state = state ? 'LOADED' : 'LOADING';
      return newAttachments;
    });
  }, [setAttachments]);

  const areAttachmentsLoaded = React.useMemo(() => {
    if (!!attachments) {
      const foundLoadingAttachment = attachments.find((attachment) => attachment.state === 'LOADING');
      return !foundLoadingAttachment;
    }
    return true;
  }, [attachments]);

  // Async since the NSFW pre-check; react-dropzone ignores the returned
  // promise, which is fine — nothing here depends on the drop being finished.
  const onFilesDrop = React.useCallback(async (files: File[]) => {
    const imageFiles = files.filter(file => file.type.startsWith('image'));
    if (props.richTextMode) {
      for (const file of files) {
        await addImageMedia(editor, file);
      }
    } else {
      await addFiles(setAttachments, setAttachmentError, imageFiles, attachmentLimit);
    }
  }, [props.richTextMode, editor, setAttachments, attachmentLimit]);

  // `noPaste` is required, not cosmetic: react-dropzone 20 turned paste-to-upload
  // on by default and wires the handler into `getRootProps`, so a screenshot
  // pasted into the Slate `<Editable>` below would bubble to the dropzone root
  // and be attached a second time on top of `handlePaste`'s own `addFiles` call.
  const { getInputProps, getRootProps, isDragActive, rootRef } = useDropzone({ onDrop: onFilesDrop, noClick: true, noPaste: true })

  // Update mentionable users on search string change
  React.useEffect(() => {
    if (mentionRetrievalDebounceRef.current !== undefined) {
      clearTimeout(mentionRetrievalDebounceRef.current);
      mentionRetrievalDebounceRef.current = undefined;
    }
    if (mentionSearchValue && props.mentionableUsersSource) {
      const { channelId, communityId } = props.mentionableUsersSource;
      mentionRetrievalDebounceRef.current = setTimeout(() => {
        // Debounce
        communityApi.getChannelMemberList({
          channelId,
          communityId,
          offset: 0,
          limit: 100,
          search: mentionSearchValue,
          startsWithSearch: true,
        }).then(res => {
          const _mentionableUserIds = res.admin.concat(res.moderator, res.writer, res.reader, res.offline).map(([userId, roleIds]) => userId);
          setMentionableUserIds(_mentionableUserIds);
          setMentionIndex(0);
        }).catch(err => {
          console.log(err);
        });
      }, 500);
    }
    else {
      setMentionableUserIds([]);
    }
  }, [mentionSearchValue, props.mentionableUsersSource]);

  // Regain focus when replying to someone
  React.useEffect(() => {
    if (props.replyingTo) {
      setTimeout(() => ReactEditor.focus(editor), 10);
    }
  }, [editor, props.replyingTo])

  React.useEffect(() => {
    if (isEditing) {
      setFocused?.(true);
      ReactEditor.focus(editor);
      setTimeout(() => {
        const endOfEditor = Editor.end(editor, []);
        Transforms.select(editor, { anchor: endOfEditor, focus: endOfEditor });
      }, 10);
    }
  }, [editor, isEditing, isMobile, setFocused])

  // Set initial value
  React.useEffect(() => {
    if (!hasInitializedValue.current) {
      hasInitializedValue.current = true;
      if (props.initialValue && props.initialValue.length > 0) {
        setCurrentValue(props.initialValue);
      }

      // Focus if you're on desktop and not richtext
      if (!isMobile && !props.richTextMode) {
        setTimeout(focus, 100);
      }
    }
  }, [editor, focus, isMobile, props.initialValue, props.richTextMode, setCurrentValue]);

  // Add click listeners for mentions
  React.useEffect(() => {
    function onClickListener(event: MouseEvent) {
      const mentionsDiv = mentionsRef.current;
      const emojiDiv = emojiPickerRef.current;
      const emojiTriggerDiv = emojiTriggerRef.current;
      const addMentionButton = addMentionButtonRef.current;

      const clickedOnMentions = mentionsDiv && event.composedPath().includes(mentionsDiv);
      const clickedOnEmojiDiv = emojiDiv && event.composedPath().includes(emojiDiv);
      const clickedOnEmojiTrigger = emojiTriggerDiv && event.composedPath().includes(emojiTriggerDiv);
      const clickedOnMentionButton = addMentionButton && event.composedPath().includes(addMentionButton);

      // If clicked on mentions, set focus
      if (clickedOnMentions) {
        ReactEditor.focus(editor);
        setFocused?.(true);
      }

      if (mentionTargetRange) {
        // Clicking anywhere besides addButton => Always hide
        if (!clickedOnMentionButton) setMentionTargetRange(undefined);
      }

      // Hide emoji popup on outside click 
      if (!clickedOnEmojiTrigger && !clickedOnEmojiDiv) {
        setShowEmojiPicker(false);
      }
    }

    function onMentionsHoverListener(event: MouseEvent): void {
      function getIndexOnParent(node: Node): number {
        const parent = node.parentNode;
        return Array.prototype.findIndex.call(parent?.children, (child => child === node));
      }

      let target = event.target;
      // Climb up to row element
      while (target instanceof HTMLElement && target.className !== 'mentionSuggestion') {
        target = target.parentElement;
      }

      const mentionsDiv = mentionsRef.current;
      if (target && target !== mentionsDiv && target instanceof HTMLElement) {
        const index = getIndexOnParent(target);
        setMentionIndex(index);
      }
    }

    document.addEventListener('click', onClickListener);
    const mentionsDiv = mentionsRef.current;
    if (mentionsDiv) {
      mentionsDiv.addEventListener('mouseover', onMentionsHoverListener);
    }

    return () => {
      document.removeEventListener('click', onClickListener);
      if (mentionsDiv) {
        mentionsDiv.removeEventListener('mouseover', onMentionsHoverListener);
      }
    }

  }, [editor, filteredUsers, mentionIndex, mentionTargetRange, setFocused]);

  React.useEffect(() => {
    const focusedListener = (event: MouseEvent) => {
      const rootDiv = rootRef.current;
      const clickedInside = (rootDiv && event.composedPath().includes(rootDiv)) || false;

      setFocused?.(clickedInside);
    }

    document.addEventListener('click', focusedListener);
    return () => {
      document.removeEventListener('click', focusedListener);
    }
  }, [rootRef, setFocused]);

  React.useEffect(() => {
    // Restore to default bottom nav state when (1) tapping "Done" on iOS virtual keyboard AND (2) there is nothing typed to the input field
    const focusOutListener = (event: FocusEvent) => {
      // check if clicked "Done" button on iOS virtual keyboard, instead of other elements in the UI (e.g. upload attachment, emoji, mention controls, etc.) that may trigger focusout
      if (event.relatedTarget === null) {
        const contentLength = convertToMessageBody(editor.children).content.length;
        if (contentLength === 0) {
          setFocused?.(false);
        }
      }
    }
    document.addEventListener('focusout', focusOutListener);
    return () => {
      document.removeEventListener('focusout', focusOutListener);
    }
  }, [editor.children, setFocused]);

  const renderElement = React.useCallback((props: RenderElementProps) => <FieldElement {...props} />, []);
  const renderLeaf = React.useCallback((props: RenderLeafProps) => <Leaf {...props} />, []);
  const renderPlaceholder = React.useMemo(() => {
    if (overridePlaceholderClassName) {
      return (placeholderProps: RenderPlaceholderProps) => <Placeholder {...placeholderProps} overrideClassName={overridePlaceholderClassName} />;
    }
    return undefined;
  }, [overridePlaceholderClassName]);

  const onEditorChange = React.useCallback(() => {
    const { selection } = editor;

    // Update media floating button
    const isAtEmptyParagraph = isCurrentNodeEmptyParagraph(editor);
    const mediaButton = richMediaButtonRef.current;

    // hide attachment errors
    if (attachmentError) startHidingAttachmentError();

    if (mediaButton) {
      if (isAtEmptyParagraph) {
        setTimeout(() => {
          const domSelection = window.getSelection();
          const mediaButton = richMediaButtonRef.current;

          if (mediaButton && domSelection) {
            const domRange = domSelection.getRangeAt(0);

            const containerElement = mediaButton.parentElement!;
            const rect = domRange.getBoundingClientRect();
            const containerRect = containerElement?.getBoundingClientRect();

            mediaButton.style.top = `${rect.top - containerRect.top + window.pageYOffset - mediaButton.offsetHeight / 2 + rect.height / 2}px`;
            mediaButton.style.opacity = '1';
          }
        }, 1);
      } else {
        mediaButton.style.opacity = '0';
      }
    }

    if (selection && Range.isCollapsed(selection)) {
      const foundWordRange = currentWord(editor, selection);
      if (foundWordRange) {
        const foundWord = Editor.string(editor, foundWordRange);
        if (foundWord) {
          const { mentionData } = findAndSetWordType(editor, foundWordRange, foundWord, props.richTextMode);

          if (!!mentionData) {
            setMentionSearchValue(mentionData.mentionValue);
            setMentionTargetRange(mentionData.mentionRange);
          } else {
            setMentionSearchValue(undefined);
            setMentionTargetRange(undefined);
          }
        } else {
          // If has found no word and offset is > 0: adding spaces
          // Try to add empty pure text breaks if possible
          if (foundWordRange.anchor.offset > 0) {
            const isPlainTextType = isFirstNodeOfType(editor, foundWordRange, undefined);
            if (!isPlainTextType) {
              // copy range, move selection one field back, and apply plain text type
              const wordRangeCopy = _.cloneDeep(foundWordRange);
              wordRangeCopy.anchor.offset -= 1;
              Transforms.setNodes(editor, { type: undefined }, { match: Text.isText, at: wordRangeCopy, split: true });
            }
          }

          setMentionSearchValue(undefined);
          setMentionTargetRange(undefined);
        }
      }
    }

    if (!props.richTextMode) parseLinks(editor);
    onChange?.(editor.children);
  }, [editor, attachmentError, startHidingAttachmentError, parseLinks, onChange, props.richTextMode]);

  const handleEmojiInput = React.useCallback((emoji: string) => {
    const { selection } = editor;
    // If no selection, set at end
    if (!selection) {
      const endOfEditor = Editor.end(editor, []);
      Transforms.select(editor, { anchor: endOfEditor, focus: endOfEditor });
    }

    Editor.insertText(editor, emoji);
    if (!isMobile) ReactEditor.focus(editor);
  }, [editor, isMobile]);

  const sendHandler = React.useCallback((sendEmpty = false) => {
    if (areAttachmentsLoaded) {
      // if getting message body is inside timeout, then editor.children are affected by something and got wrong state until timeout reach 100ms
      let messageBody: Models.Message.Body;
      if (sendEmpty) {
        messageBody = {
          version: '1',
          content: []
        };
      } else {
        messageBody = convertToMessageBody(editor.children);
      }

      const attachmentData: Models.Message.Attachment[] = attachments.map(att => {
        if (att.type === 'image') {
          return { type: att.type, imageId: att.imageId, largeImageId: att.largeImageId };
        } else if (att.type === 'linkPreview') {
          const { originalUrl, ...linkAttachment } = att;
          return linkAttachment;
        } else if (att.type === 'giphy') {
          const previewWidth = att.giphyGif?.images.fixed_height.width;
          const previewHeight = att.giphyGif?.images.fixed_height.height;
          return { type: att.type, gifId: att.gifId, previewWidth, previewHeight };
        }

        return att;
      });
      const validAttachments = attachmentData.filter(attachment => attachment.type !== 'image' || (attachment.imageId && attachment.largeImageId));
      send?.(messageBody, validAttachments);
      setAttachments([]);
      setAttachmentError('');

      setTimeout(() => {
        clearEditor(editor);
        setTimeout(() => {
          focus();
        }, 1);
      }, 1);
    }
  }, [attachments, editor, send, setAttachments, setAttachmentError, focus, areAttachmentsLoaded]);

  const normalizeLinks = React.useCallback(() => {
    const { selection } = editor;
    if (selection && Range.isCollapsed(selection)) {
      const foundWordRange = currentWord(editor, selection);
      if (foundWordRange) {
        const foundWord = Editor.string(editor, foundWordRange);
        if (foundWord) {
          const urlMatches = linkRegex.exec(foundWord);
          if (urlMatches) {
            if (urlMatches[0] !== urlMatches[2]) {
              // ignore end-of-sentence letters
              const newAnchor = Editor.before(editor, foundWordRange.focus, { unit: 'character' });
              if (newAnchor) {
                foundWordRange.anchor = newAnchor;
              }
              Transforms.setNodes(editor, { type: undefined }, { match: Text.isText, at: foundWordRange, split: true });
            }
          }
        }
      }
    }
  }, [editor]);

  const handleCommandKeys = React.useCallback((event: React.KeyboardEvent) => {
    if (mentionTargetRange && filteredUsers[mentionIndex]) {
      let currentIndex = 0;
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          const prevIndex = mentionIndex >= filteredUsers.length - 1 ? 0 : mentionIndex + 1;
          setMentionIndex(prevIndex);
          currentIndex = prevIndex;
          break;
        case 'ArrowUp':
          event.preventDefault();
          const nextIndex = mentionIndex <= 0 ? filteredUsers.length - 1 : mentionIndex - 1;
          setMentionIndex(nextIndex);
          currentIndex = nextIndex;
          break;
        case 'Tab':
        case 'Enter':
          event.preventDefault();
          insertMention(editor, mentionTargetRange, filteredUsers[mentionIndex]);
          setMentionTargetRange(undefined);
          break;
        case 'Escape':
          event.preventDefault();
          setMentionTargetRange(undefined);
          break;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const currentDiv = mentionsRef.current;
        if (currentDiv) {
          const scrollable = currentDiv.children[0];
          const scrollableContent = scrollable.children[0];
          const currentElement = scrollableContent.children[currentIndex];
          currentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
    } else {
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp':
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'Tab':
        case 'Enter':
        case ' ':
          normalizeLinks();
      }
      if (props.send && !isMobile && !event.shiftKey && !event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        sendHandler();
      } else if (props.richTextMode && event.shiftKey && event.key === 'Enter') {
        // Add soft line break
        event.preventDefault();
        Transforms.insertText(editor, '\n');
      } else if (event.key === 'Enter' && !isCurrentNodeParagraph(editor)) {
        event.preventDefault();
        Transforms.insertNodes(editor, { type: 'paragraph', children: [{ text: '' }] });
      } else if (event.key === 'Escape') {
        if (isEditing) {
          // Stop editing with empty value
          sendHandler(true);
        } else {
          setShowEmojiPicker(false);
        }
      }
    }
  }, [editor, filteredUsers, isEditing, isMobile, mentionIndex, mentionTargetRange, props.richTextMode, props.send, sendHandler, normalizeLinks]);

  // Async since the NSFW pre-check. The clipboard items are read out
  // synchronously below, before the first await, so the event data is still
  // alive when we touch it.
  const handlePaste = React.useCallback(async (ev: React.ClipboardEvent<HTMLDivElement>) => {
    try {
      const items = (ev.clipboardData || ev.nativeEvent.clipboardData).items;

      const imageFiles: File[] = [];
      for (const index in items) {
        const item = items[index];
        if (item.kind === 'file' && item.type.startsWith('image')) {
          const file = item.getAsFile();
          if (file) {
            imageFiles.push(file);
          }
        }
      }

      if (!props.richTextMode && !props.disableAttachments) {
        await addFiles(setAttachments, setAttachmentError, imageFiles, attachmentLimit);
      } else if (props.richTextMode) {
        for (const file of imageFiles) {
          await addImageMedia(editor, file);
        }
      }

      setTimeout(() => {
        recalculateNodeTypes(editor, props.richTextMode);
      }, 0);
    } catch (error) {
      showSnackbar({type: 'warning', text: 'Failed to paste content. This operation may not be supported'});
      console.log(error);
    }
  }, [props.richTextMode, props.disableAttachments, setAttachments, attachmentLimit, editor, showSnackbar]);

  // Update mention box position
  React.useEffect(() => {
    if (mentionTargetRange && filteredUsers.length > 0) {
      const el = mentionsRef.current;
      const domRange = ReactEditor.toDOMRange(editor, mentionTargetRange);
      const rect = domRange.getBoundingClientRect();
      if (el) {
        if (isMobile) {
          el.style.left = '0px';
          el.style.right = '0px';
          el.style.maxHeight = `${Math.round(window.innerHeight / 2)}px`;
        } else {
          const minWidth = 200;
          const left = rect.left + window.pageXOffset;
          if (left + minWidth > window.innerWidth) {
            el.style.right = `${window.innerWidth - rect.right - window.pageXOffset}px`;
          } else {
            el.style.left = `${left}px`;
          }
        }
        el.style.bottom = `${window.innerHeight - rect.top + 5}px`;
      }
    }
  }, [filteredUsers.length, editor, mentionTargetRange, isMobile]);

  const onEditFieldError = React.useCallback((error: Error, errorInfo: React.ErrorInfo) => {
    setRecreateOnErrorCounter(oldCounter => oldCounter + 1);
  }, []);

  const editableContent = React.useMemo(() => {
    let returnValue = <EditFieldErrorBoundary
      key={`editable-errorboundary-key-error${recreateOnErrorCounter}`}
      onEditFieldError={onEditFieldError}
    >
      <Editable
        key={`editable-key-error${recreateOnErrorCounter}`}
        onPaste={handlePaste}
        className='message-field-input'
        renderPlaceholder={renderPlaceholder}
        placeholder={props.placeholder}
        renderElement={renderElement}
        renderLeaf={renderLeaf}
        onKeyDown={handleCommandKeys}
        tabIndex={tabIndex}
        autoCorrect='off'
        autoCapitalize='off'
        autoComplete='off'
        spellCheck='false'
      />
    </EditFieldErrorBoundary>;

    if (!props.richTextMode) {
      returnValue = <Scrollable>
        {returnValue}
      </Scrollable>;
    }
    return returnValue;
  }, [handleCommandKeys, handlePaste, props.placeholder, props.richTextMode, renderElement, renderLeaf, renderPlaceholder, tabIndex, recreateOnErrorCounter, onEditFieldError]);

  const inputMentionCharacter = React.useCallback(() => {
    Transforms.insertText(editor, '@');
    ReactEditor.focus(editor);
    // Force change
    onEditorChange();
  }, [editor, onEditorChange]);

  const showAttachmentError = React.useCallback((error: string) => {
    setAttachmentError(error);
    setTimeout(() => {
      startHidingAttachmentError()
    }, 7800);
  }, [startHidingAttachmentError]);

  const onInputClick = React.useCallback((ev: React.MouseEvent) => {
    if ((ev.target as Element).className === 'message-field-input-container') {
      ev.preventDefault();
      focus();
    }
  }, [focus]);

  const inputControls = React.useMemo(() => {
    if (props.richTextMode || (isMobile && !isFocused && !lockFocus)) return null;

    return <div className='message-field-input-controls'>
      {!props.disableAttachments && <AttachmentDropdown
        setAttachments={setAttachments}
        setAttachmentError={showAttachmentError}
        setLockFocus={setLockFocus}
        onPick={focus}
        attachmentLimit={attachmentLimit}
      />}
      {giphyEnabled && <GiphyPicker
        setAttachments={setAttachments}
        setAttachmentError={showAttachmentError}
        setLockFocus={setLockFocus}
        onPick={focus}
        attachmentLimit={attachmentLimit}
      />}

      {!isMobile && <EmojiPickerTooltip
        placement='top-start'
        isTooltipOpen={setShowEmojiPicker}
        onEmojiClick={handleEmojiInput}
        triggerContent={<div className={`message-field-control${showEmojiPicker ? ' selected' : ''}`}>
          <button
            className="message-field-emoji-button"
            ref={emojiTriggerRef}
          >
            <EmojiOutlineIcon className="message-field-control-icon" />
          </button>
        </div>}
      />}

      {!callMode && canMention && <div className={`message-field-control resize-svg${!!mentionTargetRange ? ' selected' : ''}`} role="button" ref={addMentionButtonRef} onClick={inputMentionCharacter} >
        <MentionIcon className="message-field-control-icon" />
      </div>}

      {!(callMode && isMobile) && <AddLinkModal editFieldHeight={rootRef.current?.clientHeight || 0} />}

      <div className='send-button-container'>
        {isEditing && <Button
          className='send-button'
          text='Cancel'
          iconRight={<CloseIcon />}
          role='secondary'
          onClick={() => {
            // Send empty body to cancel edit
            sendHandler(true);
          }}
        />}
        {areAttachmentsLoaded && <Button
          className='send-button'
          role='secondary'
          text={isEditing ? 'Done' : 'Send'}
          onClick={() => {
            ReactEditor.androidScheduleFlush(editor);
            ReactEditor.focus(editor);
            setTimeout(() => {
              sendHandler();
            }, 1);
          }}
          iconRight={isEditing ? <CheckmarkIcon /> : <PaperPlaneIcon />}
        />}
        {!areAttachmentsLoaded && <Button
          className='send-button'
          text="Uploading..."
          disabled
          iconRight={<Spinner />}
        />}
      </div>
    </div>
  }, [
    setAttachments,
    areAttachmentsLoaded,
    editor,
    handleEmojiInput,
    inputMentionCharacter,
    isEditing,
    isFocused,
    lockFocus,
    isMobile,
    props.disableAttachments,
    props.richTextMode,
    sendHandler,
    showAttachmentError,
    showEmojiPicker,
    rootRef,
    mentionTargetRange,
    canMention,
    focus,
    callMode,
    attachmentLimit,
  ]);

  const imageAttachments = attachments.filter(att => att.type === 'image' || att.type === 'giphy');
  const linkPreview = attachments.find(att => att.type === 'linkPreview');
  return (
    <div {...getRootProps({ className: props.overrideClassName || `message-field${isMobile && isFocused ? ' message-field-expanded' : ''}` })}>
      {/* react-dropzone 20 stopped absolutely positioning the hidden input (its
          own #1413: an out-of-flow input scrolls the page when focused). Here
          the input is a direct child of a `flex flex-col gap-2` container, so
          in flow it becomes a zero-height flex item and adds one 8px gap above
          the composer. Putting it back out of flow restores the old layout.
          CAUTION: getInputProps spreads the passed props AFTER its defaults, so
          a partial `style` REPLACES the library's hiding style wholesale (a
          bare `position: absolute` left a fully visible native file widget
          floating over the composer). The library's hidden style is therefore
          reproduced here in full, plus the out-of-flow position. */}
      <input {...getInputProps({
        style: {
          border: 0,
          display: 'block',
          height: 0,
          margin: 0,
          opacity: 0,
          overflow: 'hidden',
          padding: 0,
          width: 0,
          position: 'absolute',
        },
      })} />
      {isDragActive && <div className='message-field-drop-tip'>
        <ImageIcon />
        <span>Drop your files here</span>
      </div>}
      <div className='message-field-input-container' onClick={onInputClick}>
        {props.replyingTo && props.cancelReply && <EditFieldReplyPreview replyingTo={props.replyingTo} cancelReply={props.cancelReply} />}
        <Slate
          editor={editor}
          initialValue={emptyState}
          onChange={onEditorChange}
        >
          {props.richTextMode && <div className='editorNewMediaButton' ref={richMediaButtonRef}><MediaPickerDropdown /></div>}
          {props.richTextMode && <HoveringToolbar />}
          {editableContent}
          {linkPreview?.type === 'linkPreview' && <div className='py-1'>
            <LinkPreview key={linkPreview.originalUrl} onRemove={() => removePreview(linkPreview.originalUrl || linkPreview.url)} {...linkPreview} />
          </div>}
          {loadingLinkAttachment && <LinkPreviewSkeleton />}
          {inputControls}
          {filteredUsers.length > 0 && mentionTargetRange && <Portal>
            <div ref={mentionsRef} style={{ position: 'absolute' }} className="message-field-mentions-box">
              <Scrollable>
                {filteredUsers.map((userData, index) => {
                  const selected = mentionIndex === index;
                  return (<MentionSuggestion
                    mentionTargetRange={mentionTargetRange}
                    currentInput={mentionSearchValue}
                    key={userData.id}
                    userData={userData}
                    selected={selected}
                  />);
                })}
              </Scrollable>
            </div>
          </Portal>}
        </Slate>
      </div>
      {imageAttachments.length > 0 && <div className='mediaAttachmentContainer'>
        {imageAttachments.map((attachment, index) => {
          if (attachment.type === 'image') {
            const fileKey = `image_${index}_${(attachment.tentativeFile?.name || '')}_${(attachment.tentativeFile?.lastModified || '')}`;
            const imageKey = attachment.imageId;

            return <MediaAttachment
              {...attachment}
              key={fileKey || imageKey}
              updateAttachment={updateAttachmentImageId(setAttachments, attachment.imageId)}
              removeAttachment={removeAttachment(setAttachments, attachment.imageId)}
              setIsLoadedState={setAttachmentUploadedState}
            />;
          } else if (attachment.type === 'giphy') {
            return <GiphyAttachment
              {...attachment}
              key={attachment.gifId}
              removeAttachment={() => {
                setAttachments(oldAttachments => oldAttachments.filter(att => !(att.type === 'giphy' && att.gifId === attachment.gifId)));
              }}
            />
          }
          else return null;
        })}
        <Button role='borderless' text='Remove all' onClick={() => setAttachments(oldAttachments => oldAttachments.filter(att => att.type !== 'image' && att.type !== 'giphy'))} />
      </div>}
      {attachmentError && <div className='attachmentErrorContainer'>
        <Tag label={attachmentError} variant="error" />
      </div>}
    </div>
  )
}

const Leaf: React.FC<RenderLeafProps> = React.memo((props) => {
  const { leaf, attributes } = props;
  let { children } = props;

  if (leaf.bold) {
    children = <strong>{children}</strong>;
  }

  if (leaf.italic) {
    children = <em>{children}</em>;
  }

  switch (leaf.type) {
    case 'link':
      return <span {...attributes} className='text-link'>{children}</span>;
    case 'richTextLink': {
      let url = leaf.url || '';
      if (!(url.startsWith('http'))) {
        url = 'https://' + url;
      }
      return <span {...attributes} className='text-link text-rich-link'>
        <Popover
          placement='bottom'
          tooltipContent={<SimpleLink href={url} skipInternalLinkProcessing>{url}</SimpleLink>}
          triggerContent={<span>{children}</span>}
          tooltipClassName="tooltip-url-preview"
          triggerType="hover"
          closeOn="mouseleaveTriggerAndPopover"
        />
      </span>;
    } case 'tag':
      return <span {...attributes} className='text-tag'>{children}</span>;
    case 'ticker':
      return <span {...attributes} className='text-ticker'>{children}</span>;
    default:
      return <span {...attributes}>{children}</span>;
  }
});

export const Portal: React.FC<{ children?: React.JSX.Element }> = React.memo(({ children }) => {
  return typeof document === 'object' ? ReactDOM.createPortal(children, document.body) : null;
});

const FieldElement: React.FC<RenderElementProps> = React.memo((props) => {
  const { element, attributes, children } = props;

  if (element.type === 'mention') {
    return <Mention {...props} element={element} />;
  }
  if (element.type === 'header') {
    return <h3 {...attributes}>{children}</h3>;
  }
  if (element.type === 'image') {
    return <FieldMediaImage {...props} element={element} />;
  }
  if (element.type === 'embed') {
    return <FieldEmbed {...props} element={element} />;
  }
  return <div {...attributes} style={{ position: 'relative' }}>{children}</div>;
});

const Mention: React.FC<RenderElementProps & { element: MentionElement }> = React.memo(({ attributes, children, element }) => {
  const selected = useSelected({ suppressThrow: true });
  const focused = useFocused();
  const displayName = element.userData ? getDisplayNameString(element.userData) : 'Failed to fetch';
  return (
    <span
      {...attributes}
      contentEditable={false}
      className="mention-editable"
      style={{
        boxShadow: selected && focused ? '0 0 0 1px #BABABA' : 'none',
      }}
    >
      {children}@{displayName}
    </span>
  )
});

const Placeholder: React.FC<RenderPlaceholderProps & { overrideClassName: string }> = React.memo(
  ({ children, attributes, overrideClassName }) =>
    <span {...attributes} style={{ ...attributes.style, opacity: 1 }} className={overrideClassName}>{children}</span>
);

type ErrorHandler = (error: Error, errorInfo: React.ErrorInfo) => void;
class EditFieldErrorBoundary extends React.Component<{ onEditFieldError: ErrorHandler } & React.PropsWithChildren, { hasError: boolean }> {
  private editFieldErrorHandler: ErrorHandler;
  private errored = false;

  constructor(props: { onEditFieldError: ErrorHandler }) {
    super(props);
    this.state = { hasError: false };
    this.editFieldErrorHandler = props.onEditFieldError;
  }

  static getDerivedStateFromError(error: Error): { hasError: boolean } {
    if (error instanceof Error) {
      if (error.message.startsWith("Cannot resolve a DOM point from Slate point:")) {
        console.log("Slate DOM error handled in EditField ErrorBoundary");
        return { hasError: true };
      }
    }

    console.error("Error received in EditField ErrorBoundary", error);
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    const { editFieldErrorHandler } = this;
    if (!this.errored) {
      this.errored = true;
      setTimeout(() => editFieldErrorHandler(error, errorInfo), 0);
    }
  }

  render(): React.ReactNode {
    const errorHeight = '32px';
    if (this.state.hasError) {
      return <div style={{ height: errorHeight, minHeight: errorHeight, maxHeight: errorHeight, overflow: 'hidden' }}></div>;
    } else {
      return this.props.children;
    }
  }
}

export default React.forwardRef(EditFieldThree);
