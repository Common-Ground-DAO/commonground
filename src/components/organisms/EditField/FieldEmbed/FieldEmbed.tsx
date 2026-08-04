// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import { RenderElementProps, useFocused, useSelected, useSlate } from 'slate-react';
import { EmbedElement } from '../EditField.helpers';
import { matchEmbedNodeRule, validateAndSetEmbedId } from './FieldEmbed.projections';

import './FieldEmbed.css';
import Button from '../../../atoms/Button/Button';
import { Popover } from '../../../atoms/Tooltip/Tooltip';
import { Transforms } from 'slate';
import EmbedModal from '../EmbedModal/EmbedModal';
import MediaControl from '../MediaControl/MediaControl';
import Tag from '../../../atoms/Tag/Tag';
import YoutubeIframe from 'components/atoms/YoutubeIframe/YoutubeIframe';

const FieldEmbed: React.FC<RenderElementProps & { element: EmbedElement }> = (props) => {
  const editor = useSlate();
  const selected = useSelected({ suppressThrow: true });
  const focused = useFocused();
  const [error, setError] = React.useState<string | undefined>();
  const [showReassignModal, setShowReassignModal] = React.useState(false);

  React.useEffect(() => {
    if (props.element.urlCandidate) {
      const resultError = validateAndSetEmbedId(editor, props.element.urlCandidate, props.element.id);
      setError(resultError);
    }
  }, [editor, props.element.id, props.element.urlCandidate]);

  const updateSize = React.useCallback((size: Common.Content.MediaSize) => {
    Transforms.setNodes(editor, { size }, {
      match: matchEmbedNodeRule(props.element.id),
      at: []
    });
  }, [editor, props.element.id])

  const removeNode = React.useCallback(() => {
    Transforms.removeNodes(editor, {
      match: matchEmbedNodeRule(props.element.id),
      at: []
    });
  }, [editor, props.element.id]);

  return (
    <div {...props.attributes} contentEditable={false} className='mediaElement' style={{
      boxShadow: selected && focused ? '0 0 0 1px #BABABA' : 'none',
    }}>
      {showReassignModal && <EmbedModal closeModal={() => setShowReassignModal(false)} id={props.element.id} />}
      <Popover
        triggerContent={
          <>
            {props.element.embedId && <div className={`fieldEmbedVideoContainer ${props.element.size}`}>
              {/** Note: https://www.youtube.com is the only allowed frame-src, configured in nginx.conf */}
              {/** Also note: Iframes always need sandbox="allow-forms allow-scripts" for security reasons */}
              <YoutubeIframe
                divClassName='fieldEmbedVideo'
                embedId={props.element.embedId}
              />
            </div>}
            {error && <div className='fieldEmbedEmpty'>
              <Button role='primary' text='Add another link' onClick={() => setShowReassignModal(true)} />
              <div className='fieldEmbedErrorContainer'>
                <Tag label={error} variant='error' />
              </div>
            </div>}
          </>
        }
        tooltipContent={<MediaControl currSize={props.element.size} onRemoveNode={removeNode} onUpdateSize={updateSize} />}
        tooltipClassName="fieldEmbedControl"
        triggerClassName="fieldEmbedContent"
        placement="top"
        triggerType="hover"
        closeOn="mouseleaveTriggerAndPopover"
        offset={-24}
        disableFlip={true}
        dismissOnScroll
      />
      {props.children}
    </div>
  )
}

export default React.memo(FieldEmbed);