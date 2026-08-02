// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useState } from 'react';
import Button from 'components/atoms/Button/Button';
import { useUserSettingsContext } from 'context/UserSettingsProvider';
import CommunityPhoto from 'components/atoms/CommunityPhoto/CommunityPhoto';
import { getCommunityDisplayName } from '../../../../util';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import SparkIcon from '../../../atoms/icons/misc/spark.svg?react';
import { useCommunityListView } from 'context/CommunityListViewProvider';
import { useOwnUser } from 'context/OwnDataProvider';
import communityApi from 'data/api/community';

type Props = {};

const GiveSpark: React.FC<Props> = (props) => {
  const ownUser = useOwnUser();
  const { giveSparkCommunityId, setCurrentPage, setIsOpen } = useUserSettingsContext();
  const [coinAmount, _setCoinAmount] = useState(0);
  const [customAmount, _setCustomAmount] = useState('');
  const [isLoading, setLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [error, setError] = useState('');

  const setCoinAmount = useCallback((amount: number) => {
    _setCoinAmount(amount);
    _setCustomAmount('');
    setError('');
  }, []);

  const setCustomAmount = useCallback((value: string) => {
    _setCustomAmount(value);
    _setCoinAmount(0);
    setError('');
  }, []);

  const giveSparkRequest = useCallback(async (amount: number) => {
    if (amount < 1000) {
      setError('The minimum donation amount is 1000');
      return;
    }
  
    setLoading(true);
    try {
      await communityApi.givePointsToCommunity({
        communityId: giveSparkCommunityId,
        amount,
      });
      setIsOpen(false);
    } catch (e) {
      setHasError(true);
      setError('Something went wrong. Please refresh and try again.');
    } finally {
      setLoading(false);
    }
  }, [giveSparkCommunityId, setIsOpen]);

  const onGiveSpark = useCallback(() => {
    if (!coinAmount && !customAmount) {
      setError('Please select an amount to give');
      return;
    }
    const giveAmount = !!customAmount ? Number(customAmount) : coinAmount;

    if (giveAmount > (ownUser?.pointBalance || 0)) {
      setCurrentPage('not-enough-spark');
    } else {
      giveSparkRequest(giveAmount);
    }
  }, [coinAmount, customAmount, giveSparkRequest, ownUser?.pointBalance, setCurrentPage]);

  const community = useCommunityListView(giveSparkCommunityId);

  return <div className='flex flex-col px-4 gap-6 cg-text-main'>
    <div className='flex flex-col gap-2'>
      <span className='cg-text-md-400 cg-text-secondary'>Giving Spark to</span>
      {!!community && <div className='flex items-center gap-1 cg-text-lg-500'>
        <CommunityPhoto
          noHover
          community={community}
          size='small-32'
        />
        <span>{getCommunityDisplayName(community)}</span>
      </div>}
    </div>
    <div className='flex flex-col gap-1'>
      <h3 className='cg-heading-3'>Select Spark to give</h3>
      <span className='cg-text-md-400 cg-text-secondary'>Your Spark supports the community</span>
    </div>
    <div className='grid grid-cols-2 gap-2'>
      {[5000, 10000, 20000, 50000].map((amount) => (
        <Button
          key={`give_coins_${amount}`}
          role='secondary'
          iconLeft={<SparkIcon className='h-4 w-4' />}
          text={amount.toLocaleString()}
          className={amount === coinAmount ? 'active justify-start' : 'justify-start'}
          onClick={() => {
            setCoinAmount(amount);
          }}
        />
      ))}
    </div>
    <TextInputField
      type='number'
      inputClassName='h-12'
      value={customAmount}
      onChange={setCustomAmount}
      placeholder='Or enter amount'
    />
    <div className='flex flex-col w-full gap-2'>
      <Button
        iconLeft={<SparkIcon className='w-5 h-5' />}
        className='w-full'
        role='primary'
        text='Give Spark'
        onClick={onGiveSpark}
        loading={isLoading}
        disabled={hasError}
      />
      {!!error && <span className='cg-text-warning'>{error}</span>}
    </div>
  </div>
}

export default React.memo(GiveSpark);
