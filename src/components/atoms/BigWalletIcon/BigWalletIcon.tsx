// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import './BigWalletIcon.css';
import { CheckCircleIcon } from '@heroicons/react/24/solid';
import { WalletIcon } from '@heroicons/react/20/solid';
import { getTruncatedId } from '../../../util';
import BigWalletIconIcon from '../icons/misc/BigWallet.svg?react';

type Props = {
  walletAddress: string;
  className?: string;
  style?: React.CSSProperties;
}

const BigWalletIcon: React.FC<Props> = (props) => {
  const { walletAddress, className, style } = props;
  return (<div className={`big-wallet-icon ${!!className ? className : ''}`} style={style}>
    <CheckCircleIcon className='w-6 h-6 cg-text-success absolute top-2 right-2' />
    <BigWalletIconIcon className='cg-text-main' style={{
      width: '91.775px',
      height: '91.775px',
      transform: 'rotate(-15deg)'
    }} />
    <div className='big-wallet-wallet'>
      <WalletIcon className='w-5 h-5 cg-text-secondary' />
      <span className='cg-text-lg-500 cg-text-main'>{getTruncatedId(walletAddress)}</span>
    </div>
  </div>);
}

export default React.memo(BigWalletIcon);