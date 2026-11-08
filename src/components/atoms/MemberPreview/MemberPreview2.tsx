// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './MemberPreview.css';
import React, { useMemo } from 'react'
import Jdenticon from '../Jdenticon/Jdenticon';

type Props = {
  memberIds: string[];
  memberCount: number;
  limit?: number;
  rightElement?: React.JSX.Element | string;
  vertical?: boolean;
  forceShowRightElement?: boolean;
};

const MemberPreview2: React.FC<Props> = (props) => {
  const { memberIds: origMemberIds, memberCount, rightElement, limit = 6, vertical, forceShowRightElement } = props;
  const memberIds = useMemo(() => origMemberIds.slice(0, limit).filter(id => !!id), [limit, origMemberIds]);

  const previewText = typeof rightElement === 'string' ?
    `${memberCount} ${rightElement}` :
    <>{memberCount}{rightElement}</>
  
  const className = [
    "member-preview-2 flex flex-row",
    vertical ? 'vertical' : ''
  ].join(' ').trim();

  if (memberIds.length === 0) {
    return <div className={className} style={{ minHeight: "40px", maxHeight: "40px" }} />;
  }

  return <div className={className}>
    {memberIds.map(memberId => <Jdenticon key={memberId} userId={memberId} predefinedSize='40' hideStatus />)}
    {(origMemberIds.length > limit || forceShowRightElement) && <div className='member-preview-text cg-text-md-500 cg-text-secondary whitespace-nowrap'>
      {previewText}
    </div>}
  </div>;
}

export default React.memo(MemberPreview2);