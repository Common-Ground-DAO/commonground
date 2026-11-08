// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button from '../../../atoms/Button/Button';
import Modal from '../../../atoms/Modal/Modal';
import React from 'react'
import { Transforms } from 'slate';
import { createTranslator } from 'short-uuid';
import { ReactEditor, useSlate } from 'slate-react';


import './EmbedModal.css';
import { matchEmbedNodeRule } from '../FieldEmbed/FieldEmbed.projections';

type Props = {
  closeModal: () => void;
  id?: string;
};

const randomIdGen = createTranslator();

const EmbedModal: React.FC<Props> = ({ closeModal, id }) => {
  const editor = useSlate();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const submitEmbed = React.useCallback(() => {
    const inputValue = inputRef.current?.value;
    // If editing 
    if (inputValue) {
      if (id) {
        // Editing existing node
        Transforms.setNodes(editor, {
          type: 'embed', urlCandidate: inputValue
        }, {
          match: matchEmbedNodeRule(id),
          at: []
        });
      } else {
        // Creating new embed node
        Transforms.setNodes(editor, { type: 'embed', id: randomIdGen.generate(), size: 'medium', children: [{text: ''}], embedId: '', urlCandidate: inputValue });
        Transforms.insertNodes(editor, { type: 'paragraph', children: [{ text: '' }]});
        ReactEditor.focus(editor);
      }
    }
    closeModal();
  }, [closeModal, editor, id]);

  return (
    <Modal headerText='Embed Youtube Video' close={closeModal}>
      <div className='embedModal'>
        <input ref={inputRef} placeholder='Link to Youtube video' />
        <Button className='embedModalAddButton' role='primary' text='Add' onClick={submitEmbed} />
      </div>
    </Modal>
  )
}

export default React.memo(EmbedModal);