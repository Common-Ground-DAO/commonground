// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from 'react'
import SupporterSilverIcon from 'components/atoms/icons/24/SupporterSilverIcon.svg?react';
import SupporterGoldIcon from 'components/atoms/icons/24/SupporterGoldIcon.svg?react';
import SupporterIconBg from 'components/atoms/icons/24/SupporterIconBg.svg?react';
import { useUserSettingsContext } from 'context/UserSettingsProvider';


type Props = {
  type: 'silver' | 'gold';
  size?: number;
  className?: string;
  redirectToSupporterPurchase?: boolean;
};

const SupporterIcon: React.FC<Props> = (props) => {
  const { setCurrentPage, setIsOpen } = useUserSettingsContext();
  const size = props.size || 20;
  const innerSize = size * 0.9;
  const centerSize = size * 0.5;

  const outerStyle = { width: `${size}px`, height: `${size}px` };
  const innerStyle = { width: `${innerSize}px`, height: `${innerSize}px`, zIndex: 2 };
  const centerStyle = { width: `${centerSize}px`, height: `${centerSize}px`, zIndex: 1, borderRadius: '500px', background: 'white' };

  const openSettings = useMemo(() => {
    if (!props.redirectToSupporterPurchase) return undefined;
    return (ev: React.MouseEvent) => {
      ev.stopPropagation();
      setCurrentPage('become-supporter');
      setIsOpen(true);
    }
  }, [props.redirectToSupporterPurchase, setCurrentPage, setIsOpen]);

  return <div className={`flex items-center justify-center relative${props.className ? ` ${props.className}` : ''}`} style={outerStyle} onClick={openSettings}>
    <SupporterIconBg className='absolute' style={outerStyle} />
    <div className='absolute' style={centerStyle} />
    {props.type === 'gold' ? <SupporterGoldIcon style={innerStyle} /> : <SupporterSilverIcon style={innerStyle} />}
  </div>;
}

export default React.memo(SupporterIcon);