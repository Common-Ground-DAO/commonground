// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useState } from 'react';
import SparkIcon from 'components/atoms/icons/misc/spark.svg?react';
import useLocalStorage from 'hooks/useLocalStorage';
import { SupporterTile, SupporterTileProps } from '../BecomeSupporter/BecomeSupporter';
import Button from 'components/atoms/Button/Button';
import userApi from 'data/api/user';
import { useUserSettingsContext } from 'context/UserSettingsProvider';

const SupporterPurchaseConfirm = () => {
  const { setCurrentPage } = useUserSettingsContext();
  const [error, setError] = useState('');

  // random default values
  const [supporterPack] = useLocalStorage<SupporterTileProps>({
    duration: 'month',
    type: 'silver',
    price: 0
  }, "CHOSEN_SUPPORTER_PACK");
  const [buttonLoading, setButtonLoading] = useState(false);

  const buyPremium = useCallback(async () => {
    try {
      const featureName = supporterPack.type === 'silver' ? 'SUPPORTER_1' : 'SUPPORTER_2';
      setButtonLoading(true);
      await userApi.buyUserPremiumFeature({
        featureName,
        duration: supporterPack.duration,
      });
      setCurrentPage('supporter-purchase-success');
    } catch (e) {
      setError('Something went wrong, please try again later');
    } finally {
      setButtonLoading(false);
    }
  }, [setCurrentPage, supporterPack.duration, supporterPack.type]);

  return <div className='flex flex-col px-4 gap-6 cg-text-main cg-text-lg-400'>
    <div className='flex flex-col gap-2'>
      <span className='cg-text-lg-500'>You spend</span>
      <div className='cg-simple-container cg-border-xl flex gap-2 py-3 px-4'>
        <SparkIcon className='w-5 h-5' />
        {supporterPack.price.toLocaleString()}
      </div>
    </div>

    <div className='flex flex-col gap-2'>
      <span className='cg-text-lg-500'>You get</span>
      <SupporterTile {...supporterPack} clickable={false} />
    </div>

    <div className='flex flex-col w-full gap-2'>
      <Button
        role='primary'
        text='Hold to confirm'
        longPress
        loading={buttonLoading}
        onClick={buyPremium}
      />
      {!!error && <span className='cg-text-warning'>{error}</span>}
    </div>
  </div>;
}

export default React.memo(SupporterPurchaseConfirm);