// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { Range, Text, Editor, Transforms } from 'slate';
import { useFocused, useSlate } from 'slate-react';

import EditorHeaderIcon from "../../../atoms/icons/20/EditorHeaderIcon.svg?react";
import EditorBoldIcon from "../../../atoms/icons/20/EditorBoldIcon.svg?react";
import EditorItalicIcon from "../../../atoms/icons/20/EditorItalicIcon.svg?react";
import EditorLinkIcon from "../../../atoms/icons/20/EditorLinkIcon.svg?react";
import CloseIcon from '../../../atoms/icons/16/Close.svg?react';
import { linkRegexGenerator } from '../../../../common/validators';
import { Portal } from '../EditField';

import './HoveringToolbar.css';

type EditorFormatOptions = 'bold' | 'italic' | 'header' | 'richTextLink';

const onlyLinkRegex = linkRegexGenerator();

function validateLink(link: string) {
  return !link.includes(' ') && !!link.match(onlyLinkRegex);
}

const HoveringToolbar = () => {
  const editor = useSlate();
  const inFocus = useFocused();
  const { selection } = editor;
  
  const ref = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [isInputMode, setInputMode] = React.useState(false);
  const [hasError, setError] = React.useState(false);
  const [lastSelection, setLastSelection] = React.useState(selection);

  const clearInput = React.useCallback(() => {
    const input = inputRef.current;
    if (input) {
      setInputMode(false);
      input.value = '';
      setError(false);
    }
  }, []);

  if (lastSelection !== selection) {
    if (isInputMode) {
      clearInput();
    }
    setLastSelection(selection);
  }

  React.useEffect(() => {
    const el = ref.current;

    if (!el || isInputMode) {
      return;
    }

    const selectionDoesNotExist = !selection || !inFocus || Range.isCollapsed(selection) || Editor.string(editor, selection) === '';
    if (selectionDoesNotExist) {
      if (el.hasAttribute('style')) el.removeAttribute('style');
      return;
    }

    const domSelection = window.getSelection();
    if (domSelection) {
      const domRange = domSelection.getRangeAt(0);
      const rect = domRange.getBoundingClientRect();
      el.style.opacity = '1';
      el.style.top = `${rect.top + window.pageYOffset - el.offsetHeight}px`;
      el.style.left = `${rect.left +
        window.pageXOffset -
        el.offsetWidth / 2 +
        rect.width / 2}px`;
    }
  }, [editor, inFocus, isInputMode, selection]);

  const submitInput = React.useCallback(() => {
    const input = inputRef.current;
    if (input && input.value) {
      if (!validateLink(input.value)) {
        setError(true);
        return;
      } else {
        toggleFormat(editor, 'richTextLink', { url: input.value });
      }
    }
    setInputMode(false);
  }, [editor]);

  const handleInputCommands = React.useCallback((ev: React.KeyboardEvent) => {
    setError(false);
    if (ev.key === 'Enter' || ev.key === 'Escape') {
      ev.preventDefault();
      inputRef.current?.blur();
    }
  }, []);

  const content = React.useMemo(() => {
    if (isInputMode) {
      return null;
    }

    const linkOnClick = () => {
      if (isFormatActive(editor, 'richTextLink')) {
        toggleFormat(editor, 'richTextLink');
        return;
      }

      setInputMode(true);
      setTimeout(() => {
        const input = inputRef.current;
        if (input) {
          input.value = '';
          input.focus();
        }
      }, 1);
    };

    return <>
      <FormatButton format='header' icon={<EditorHeaderIcon />} />
      <FormatButton format='bold' icon={<EditorBoldIcon />} />
      <FormatButton format='italic' icon={<EditorItalicIcon />} />
      <FormatButton onClick={linkOnClick} format='richTextLink' icon={<EditorLinkIcon />} />
    </>
  }, [editor, isInputMode]);

  const inputStyle = isInputMode ? undefined : { display: 'none' };
  const toolbarClassname = ['editorHoveringToolbar', hasError ? 'error' : ''].join(' ').trim();

  return (
    <Portal>
      <div className={toolbarClassname} ref={ref} onMouseDown={isInputMode ? undefined : (ev => ev.preventDefault())}>
        {content}
        <div className='editorHoveringInput' style={inputStyle}>
          <EditorLinkIcon />
          <input ref={inputRef}
            onBlur={submitInput}
            onKeyDown={handleInputCommands}
            placeholder='Enter a link'
          />
          <button onMouseDown={ev => ev.preventDefault()} onClick={clearInput}>
            <CloseIcon />
          </button>
        </div>
      </div>
    </Portal>
  );
}

type FormatButtonProps = {
  format: EditorFormatOptions;
  icon: React.JSX.Element;
  onClick?: () => void;
}

const FormatButton: React.FC<FormatButtonProps> = React.memo(({ format, icon, onClick }) => {
  const editor = useSlate();
  const isActive = isFormatActive(editor, format);
  return <button className={isActive ? 'active' : undefined} onClick={onClick ?? (() => toggleFormat(editor, format))}>{icon}</button>;
});

const isFormatActive = (editor: Editor, format: EditorFormatOptions) => {
  const resultIterator = Editor.nodes(editor, {
    match: n => (n as any)[format] === true || (n as any).type === format,
    mode: 'all',
  })

  return !!resultIterator.next().value;
}

const toggleFormat = (editor: Editor, format: EditorFormatOptions, extra?: { url: string; }) => {
  const isActive = isFormatActive(editor, format);
  if (format === 'bold' || format === 'italic') {
    Transforms.setNodes(
      editor,
      { [format]: isActive ? undefined : true },
      { match: Text.isText, split: true }
    );
  } else if (format === 'header') {
    Transforms.setNodes(
      editor,
      { type: isActive ? 'paragraph' : format },
    );
  } else if (format === 'richTextLink') {
    Transforms.setNodes(
      editor,
      { type: isActive ? undefined : format, url: extra?.url },
      { match: Text.isText, split: !isActive }
    )
  }
}

export default React.memo(HoveringToolbar);
