// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import DaiIcon from "components/atoms/icons/externals/dai.svg?react";
import UsdcIcon from "components/atoms/icons/externals/usdc.svg?react";
import UsdtIcon from "components/atoms/icons/externals/usdt.svg?react";
import EthereumIcon from 'components/atoms/icons/24/Ethereum.svg?react';
import GnosisIcon from 'components/atoms/icons/externals/gnosis.svg?react';
import BaseIcon from 'components/atoms/icons/externals/base.svg?react';
import AvalancheIcon from 'components/atoms/icons/externals/avalanche.svg?react';
import ArbitrumIcon from 'components/atoms/icons/externals/arbitrum.svg?react';
import BinanceIcon from 'components/atoms/icons/externals/binance.svg?react';
import FantomIcon from 'components/atoms/icons/externals/fantom.svg?react';
import LineaIcon from 'components/atoms/icons/externals/linea.svg?react';
import LuksoIcon from 'components/atoms/icons/externals/lukso.svg?react';
import OptimismIcon from 'components/atoms/icons/externals/optimism.svg?react';
import PolygonIcon from 'components/atoms/icons/externals/polygon.svg?react';
import ScrollIcon from 'components/atoms/icons/externals/scroll.svg?react';
import ZkSyncIcon from 'components/atoms/icons/externals/zksync.svg?react';
import CardanoIcon from 'components/atoms/icons/externals/cardano.svg?react';
import SolanaIcon from 'components/atoms/icons/externals/solana.svg?react';
import XIcon from 'components/atoms/icons/24/X.svg?react';
import UniversalProfileIcon from 'components/atoms/icons/externals/universalProfile.svg?react';
import FarcasterIcon from 'components/atoms/icons/24/Farcaster.svg?react';
import CircleLogo from "components/atoms/icons/misc/Logo/logo.svg?react";
import { Hash, Robot } from '@phosphor-icons/react';

export type ExternalIconType =
  'dai' |
  'xdai' |
  'usdc' |
  'usdt' |
  'ethereum' |
  'gnosis' |
  'base' |
  'avalanche' |
  'arbitrum' |
  'binance' |
  'binance smart chain' |
  'fantom' |
  'linea' |
  'lukso' |
  'optimism' |
  'polygon' |
  'scroll' |
  'zksync' |
  'cardano' |
  'solana' |
  'x' |
  'twitter' |
  'cg' |
  'farcaster' |
  'bot' |
  'universalProfile' |
  'tag';

type Props = {
  type: ExternalIconType;
  className?: string;
}

const ExternalIcon: React.FC<Props> = (props) => {
  const { type, className } = props;
  switch (type) {
    case 'dai':
    case 'xdai':
      return <DaiIcon className={className} />;
    case 'usdc':
      return <UsdcIcon className={className} />;
    case 'usdt':
      return <UsdtIcon className={className} />;
    case 'ethereum':
      return <EthereumIcon className={className} />;
    case 'gnosis':
      return <GnosisIcon className={className} />;
    case 'base':
      return <BaseIcon className={className} />;
    case 'avalanche':
      return <AvalancheIcon className={className} />;
    case 'arbitrum':
      return <ArbitrumIcon className={className} />;
    case 'binance':
    case 'binance smart chain':
      return <BinanceIcon className={className} />;
    case 'fantom':
      return <FantomIcon className={className} />;
    case 'linea':
      return <LineaIcon className={className} />;
    case 'lukso':
      return <LuksoIcon className={className} />;
    case 'optimism':
      return <OptimismIcon className={className} />;
    case 'polygon':
      return <PolygonIcon className={className} />;
    case 'scroll':
      return <ScrollIcon className={className} />;
    case 'zksync':
      return <ZkSyncIcon className={className} />;
    case 'cardano':
      return <CardanoIcon className={className} />;
    case 'solana':
      return <SolanaIcon className={className} />;
    case 'x':
    case 'twitter':
      return <XIcon className={className} />;
    case 'cg':
      return <CircleLogo className={className}/>;
    case 'farcaster':
      return <FarcasterIcon className={className} />;
    case 'bot':
      return <Robot weight='duotone' className={className} />;
    case 'universalProfile':
      return <UniversalProfileIcon className={className} />;
    case 'tag':
      return <Hash weight='duotone' className={className} />;
    default:
      return <div className={className}>??</div>;
  }
}

export default React.memo(ExternalIcon);
