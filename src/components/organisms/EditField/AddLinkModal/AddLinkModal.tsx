// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import Button from '../../../atoms/Button/Button';
import TextInputField from '../../../molecules/inputs/TextInputField/TextInputField';
import EditorLinkIcon from "../../../atoms/icons/20/EditorLinkIcon.svg?react";
import { useSlate, ReactEditor } from 'slate-react';
import EditFieldControlPopup from '../EditFieldControlPopup/EditFieldControlPopup';
import Tag from '../../../atoms/Tag/Tag';
import { linkRegexGenerator } from '../../../../common/validators';

import './AddLinkModal.css';

type Props = {
  editFieldHeight: number;
}

const onlyLinkRegex = linkRegexGenerator();

function validateLink(link: string) {
  return !link.includes(' ') && !!link.match(onlyLinkRegex);
}

const AddLinkModal: React.FC<Props> = (props) => {
  const editor = useSlate();
  const [text, setText] = React.useState('');
  const [link, setLink] = React.useState('');
  const [isOpen, setOpen] = React.useState(false);
  const [hasError, setHasError] = React.useState(false);

  const buttonRef = React.useRef<HTMLDivElement>(null);
  const refText = React.useRef<HTMLInputElement>(null);
  const refLink = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (isOpen) refText.current?.focus();
  }, [isOpen]);

  const content = React.useMemo(() => {
    const onSubmit = () => {
      if (!validateLink(link)) {
        setHasError(true);
        return;
      }
      
      // initialize focus if not initialized
      const firstChild = editor.children[0];
      if (editor.children.length === 1 && firstChild.type === 'paragraph' && firstChild.children.length === 1 && firstChild.children[0].text === '') {
        ReactEditor.focus(editor);
      }

      setTimeout(() => {
        editor.insertFragment([{ type: 'paragraph', children: [{ text, type: 'richTextLink', url: link }] }]);
        ReactEditor.focus(editor);
      }, 10);
      setText('');
      setLink('');
      setOpen(false);
    }

    const textFieldOnKeyPress = (e: React.KeyboardEvent) => {
      if(e.key === 'Enter') {
        e.preventDefault();
        refLink.current?.focus();
      }
    }

    const linkFieldOnKeyPress = (e: React.KeyboardEvent) => {
      if(e.key === 'Enter') {
        e.preventDefault();
        onSubmit();
      }
    }

    const setLinkAndUndoError = (link: string) => {
      setLink(link);
      setHasError(false);
    }

    return <div className='add-link-modal'>
      <TextInputField onKeyPress={textFieldOnKeyPress} inputRef={refText} placeholder='Text to display' value={text} onChange={setText} />
      <TextInputField autoCapitalize='none' onKeyPress={linkFieldOnKeyPress} inputRef={refLink} placeholder='Link' value={link} onChange={setLinkAndUndoError} />
      <div className='buttons'>
        <Button role='secondary' text='Cancel' onClick={() => setOpen(false)} />
        <Button role='primary' text='Add link' onClick={onSubmit} />
      </div>
      {hasError && <Tag className='w-full' variant='error' label='The link doesn’t work. Please double check!' />}
    </div>
  }, [editor, hasError, link, text]);

  return <>
    <div ref={buttonRef} className={`message-field-control${isOpen ? ' selected' : ''}`} onClick={(ev) => setOpen(oldValue => !oldValue)}>
      <EditorLinkIcon className="message-field-control-icon" />
    </div>
    <EditFieldControlPopup
      visible={isOpen}
      close={() => setOpen(false)}
      editFieldHeight={props.editFieldHeight}
      triggerRef={buttonRef}
    >
      {content}
    </EditFieldControlPopup>
  </>
}

export default React.memo(AddLinkModal);