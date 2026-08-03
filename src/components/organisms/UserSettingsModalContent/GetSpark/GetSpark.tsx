// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './GetSpark.css';
import React, { useEffect, useState } from 'react';
import { PageType } from '../UserSettingsModalContent';
import Button from 'components/atoms/Button/Button';
import useLocalStorage from 'hooks/useLocalStorage';
import SparkMultiIcon from 'components/atoms/SparkMultiIcon/SparkMultiIcon';
import { useUserSettingsContext } from 'context/UserSettingsProvider';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import PaddedIcon from 'components/atoms/PaddedIcon/PaddedIcon';
import { ArrowRightCircleIcon } from '@heroicons/react/24/solid';
import config from 'common/config';
import { getSparkBonusPercentByAmount } from 'common/premiumConfig';
import userApi from 'data/api/user';
import dayjs from 'dayjs';
import { useCommunityListView } from 'context/CommunityListViewProvider';
import CommunityPhoto from 'components/atoms/CommunityPhoto/CommunityPhoto';
import SparkIcon from 'components/atoms/icons/misc/spark.svg?react';

type Props = {
  setCurrentPage: (pageType: PageType) => void;
};

const defaultSparks = [{
  spark: 5000,
  price: 5,
}, {
  spark: 10000,
  price: 10,
}, {
  spark: 50000,
  price: 50,
}, {
  spark: 100000,
  price: 100,
}]

const GetSpark: React.FC<Props> = (props) => {
  const { setCurrentPage } = props;
  const [currentTab, setCurrentTab] = useState<'buy' | 'billing'>('buy');
  const [coinAmount, setCoinAmount] = useLocalStorage(0, "CHOSEN_SPARK_AMOUNT");
  const [customAmount, setCustomAmount] = useState('');
  const [transactions, setTransactions] = useState<Models.Premium.Transaction[]>([]);
  useEffect(() => {
    let mounted = true;
    userApi.getTransactionData().then((transactions) => {
      if (!mounted) return;
      setTransactions(transactions.map(transaction => ({
        ...transaction,
        createdAt: new Date(transaction.createdAt),
      })));
    });
    return () => { mounted = false; };
  }, [])

  return (<div className='flex flex-col px-4 gap-4 cg-text-main'>
    <div className='flex gap-2'>
      <Button
        role='chip'
        text='Buy Spark'
        active={currentTab === 'buy'}
        onClick={() => setCurrentTab('buy')}
      />
      <Button
        role='chip'
        text='Billing'
        active={currentTab === 'billing'}
        onClick={() => setCurrentTab('billing')}
      />
    </div>
    {currentTab === 'buy' && <div className='flex flex-col gap-4'>
      <h3 className='cg-heading-3 cg-text-main'>Upgrade communities and support CG with <span className='cg-text-spark'>Spark</span></h3>
      <span className='cg-text-md-400 cg-text-secondary'>Spark is optional and non-refundable</span>

      <div className='grid grid-cols-2 gap-2'>
        {defaultSparks.map((sparkInfo) => (
          <SparkTile key={sparkInfo.spark} {...sparkInfo} clickable />
        ))}
      </div>

      <TextInputField
        type='number'
        inputClassName='h-12'
        value={customAmount}
        onChange={setCustomAmount}
        placeholder='Or enter amount of Spark'
        iconRight={<PaddedIcon
          onClick={() => {
            if (!customAmount) return;
            setCoinAmount(Number(customAmount));
            setCurrentPage('pay-spark');
          }}
          className='absolute right-2 cg-circular cg-bg-subtle p-2'
          icon={<ArrowRightCircleIcon className='w-6 h-6' />}
        />}
      />
    </div>}
    {currentTab === 'billing' && <div className='spark-billing-container flex flex-col w-full'>
      {transactions.length === 0 && <h3 className='p-2'>No billing history</h3>}
      {transactions.length > 0 && <div className='spark-billing-info'>
        {transactions.map(transaction => <HistoryPayment transaction={transaction} />)}
      </div>}
    </div>}
  </div>);
}

export function getSparkTileIconCount(sparkAmount: number) {
  if (sparkAmount >= 100000) return 4;
  if (sparkAmount >= 50000) return 3;
  if (sparkAmount >= 10000) return 2;
  return 1;
}

export function getSparkBonus(sparkAmount: number) {
  return getSparkBonusPercentByAmount(sparkAmount);
}

export const SparkTile: React.FC<typeof defaultSparks[0] & {
  hideTopRightBonus?: boolean;
  clickable?: boolean;
  successTile?: boolean;
}> = React.memo((props) => {
  const { setCurrentPage } = useUserSettingsContext();
  const [coinAmount, setCoinAmount] = useLocalStorage(0, "CHOSEN_SPARK_AMOUNT");

  const iconCount = getSparkTileIconCount(props.spark);
  const bonusPercent = getSparkBonus(props.spark);

  const className = [
    'h-44 cg-bg-subtle cg-border-xxl flex flex-col items-center justify-center cg-text-main overflow-hidden relative self-stretch',
    props.clickable ? 'cursor-pointer' : ''
  ].join(' ').trim();

  const sparkString = props.successTile ?
    (props.spark + (props.spark * bonusPercent / 100)).toLocaleString() :
    props.spark.toLocaleString();

  return <div
    className={className}
    onClick={!!props.clickable ? () => {
      setCoinAmount(props.spark);
      setCurrentPage('pay-spark');
    } : undefined}
  >
    {!!bonusPercent && !props.hideTopRightBonus && !props.successTile && <div className='spark-tile-bonus absolute top-2 left-2 p-1 cg-text-success cg-caption-md-600'>
      + {bonusPercent}%
    </div>}
    <div className='blurred-spark-tile absolute'>
      <SparkMultiIcon iconCount={iconCount} />
    </div>

    <div className={`flex items-center justify-center h-20${!props.successTile ? ' flex-1' : ''}`}>
      <SparkMultiIcon iconCount={iconCount} />
    </div>
    <div className='flex py-2 px-1 gap-1 items-center cg-text-main'>
      <span className='cg-text-md-500'>{sparkString}</span>
      {!!bonusPercent && !props.successTile && <span className='cg-caption-md-600 cg-text-success'>+{(props.spark * bonusPercent / 100).toLocaleString()}</span>}
    </div>
    {!props.successTile && <div className='flex items-center justify-center h-9 self-stretch cg-bg-subtle'>
      <span className='cg-text-lg-500'>{props.price}$</span>
    </div>}
  </div>;
});

export default React.memo(GetSpark);

type HistoryPaymentProps = {
  transaction: Models.Premium.Transaction;
};

const HistoryPayment: React.FC<HistoryPaymentProps> = ({ transaction }) => {
  // relevant transactions for user are of type
  // 'user-donate-community', 'user-spend', 'user-onchain-buy'
  const { data, amount, communityId, createdAt } = transaction;
  const community = useCommunityListView(data.type === 'user-donate-community' ? (communityId || undefined) : undefined);

  let content: JSX.Element;
  let sign: '+' | '-' | '' = '';
  let datePrefix = '';
  if (data.type === 'user-donate-community') {
    sign = '-';
    content = <>
      <div className="cg-bg-subtle h-10 w-10 cg-border-m flex items-center justify-center cg-heading-3">
        🫴
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        <span>Donated to</span>
        {!!community ? <div className='flex items-center gap-1 flex-1'>
          <CommunityPhoto community={community} size='tiny-20' noHover />
          <span className='whitespace-nowrap'>{community.title}</span>
        </div> : 'Loading...'}
        {/* {user ? <UserTag userData={user} hideStatus jdenticonSize="20" noOfflineDimming /> : 'Loading...'} */}
      </div>
    </>;
  }
  else if (data.type === 'user-spend') {
    sign = '-';
    if (data.triggeredBy !== 'MANUAL') datePrefix = 'Auto-Renewed ';
    else datePrefix = 'Bought ';

    content = <>
      <div className="flex items-center justify-center cg-bg-subtle h-10 w-10 cg-border-m">
        <SparkIcon className='w-6 h-6' />
      </div>
      <span className="flex-1 flex-wrap">{data.featureName === 'SUPPORTER_1' ? 'CG Silver' : 'CG Gold'}</span>
    </>;
  }
  else if (data.type === 'user-onchain-buy') {
    sign = '+';
    content = <>
      <div className="flex items-center justify-center cg-bg-subtle h-10 w-10 cg-border-m">
        <SparkIcon className='w-6 h-6' />
      </div>
      <span className="flex-1 flex-wrap">Bought {amount.toLocaleString()} Spark on {config.AVAILABLE_CHAINS[data.chain].title}</span>
    </>;
  }
  else if (data.type === 'community-spend') {
    // we won't show those since the user spent
    // for a community as an eligible community member (i.e. admin)
    return null;
  }
  else if (data.type === 'platform-donation') {
    sign = '+';
    content = <>
      <div className="cg-bg-subtle h-10 w-10 cg-border-m flex items-center justify-center cg-heading-3">
        {data.emoji}
      </div>
      <span className="flex-1 flex-wrap">{data.text}</span>
    </>;
  }
  else {
    return null;
  }
  return (
    <div className="flex flex-col p-4 gap-2 cg-text-secondary">
      <div className="flex items-center gap-1 flex-1">
        {content}
      </div>
      <div className="flex items-center gap-1">
        <span>{datePrefix}{dayjs(createdAt).format('MMM D, YYYY')}</span>
        <span className="cg-text-md-500 cg-text-main py-2 px-1">{sign}{amount.toLocaleString()}</span>
      </div>
    </div>
  );
}