// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useState } from 'react';

import { useLoadedCommunityContext } from 'context/CommunityProvider';
import './PremiumManagement.css';
import { useOwnUser } from 'context/OwnDataProvider';
import Button from 'components/atoms/Button/Button';
import communityApi from 'data/api/community';
import SparkIcon from '../../../atoms/icons/misc/spark.svg?react';
import SimpleLink from 'components/atoms/SimpleLink/SimpleLink';
import UpgradesTab from './UpgradesTab';
import BillingTab from './BillingTab';
import { UserWidgetContent } from 'components/molecules/UserWidget/UserWidget';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import { useSnackbarContext } from 'context/SnackbarContext';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { useNavigate } from 'react-router-dom';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import { useUserSettingsContext } from 'context/UserSettingsProvider';
import ManagementHeader2 from 'components/molecules/ManagementHeader2/ManagementHeader2';

const learnMoreLink = 'https://app.cg/c/commonground/article/introducing-spark---upgrade-your-community-%26-support-common-ground-svnJ15teLA9JxAxCC8yafT';

const PremiumManagement: React.FC = () => {
  const { community } = useLoadedCommunityContext();
  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const { showSnackbar } = useSnackbarContext();
  const [isLoading, setLoading] = useState(false);
  const [isGiveCoinsExpanded, setIsGiveCoinsExpanded] = useState(false);
  const [coinAmount, _setCoinAmount] = useState(0);
  const [customAmount, _setCustomAmount] = useState('');
  const [tab, setTab] = useState<'upgrades' | 'billing'>('upgrades');
  const { setCurrentPage, setIsOpen } = useUserSettingsContext();
  const ownUser = useOwnUser();
  
  const onClickBuySpark = useCallback(() => {
    navigate({search: ''});

    setCurrentPage('get-spark');
    setIsOpen(true);
  }, [navigate, setCurrentPage, setIsOpen]);

  const setCoinAmount = useCallback((amount: number) => {
    _setCoinAmount(amount);
    _setCustomAmount('');
  }, []);

  const setCustomAmount = useCallback((value: string) => {
    _setCustomAmount(value);
    _setCoinAmount(0);
  }, []);

  const givePointsToCommunity = useCallback(async (amount: number) => {
    if (amount <= (ownUser?.pointBalance || 0)) {
      setLoading(true);
      try {
        await communityApi.givePointsToCommunity({
          communityId: community.id,
          amount,
        });
      }
      finally {
        setLoading(false);
      }
    }
  }, [community.id, ownUser?.pointBalance]);

  const onGiveCoins = useCallback(() => {
    const amount = customAmount ? Number(customAmount) : coinAmount;
    if (amount === 0) {
      showSnackbar({ type: 'warning', text: 'Please select an amount first' });
    } else if (amount < 1000) {
      showSnackbar({type: 'warning', text: 'The minimum donation amount is 1000'});      
    } else  {
      givePointsToCommunity(amount);
    } 
  }, [coinAmount, customAmount, givePointsToCommunity, showSnackbar]);

  const content = <>
    <div className='flex flex-col p-4 gap-4 self-stretch cg-bg-subtle cg-border-xxl cg-text-main'>
      <div className='flex flex-wrap gap-2 justify-between items-center'>
        <div className='flex flex-col flex-1 gap-2'>
          <div className='flex items-center gap-1'>
            <SparkIcon className='w-8 h-8' />
            <span className='cg-heading-2'>{community.pointBalance.toLocaleString()}</span>
          </div>
          <span className='cg-text-secondary whitespace-nowrap'>in Community Safe</span>
        </div>

        {!isGiveCoinsExpanded && <Button
          role='secondary'
          iconLeft={<SparkIcon className='w-5 h-5' />}
          text='Give Spark'
          onClick={() => setIsGiveCoinsExpanded(true)}
        />}
      </div>

      {isGiveCoinsExpanded && <>
        <div className='flex flex-col gap-4'>
          <div className='flex flex-col gap-2'>
            <span className='cg-text-lg-500'>Your wallet</span>
            <UserWidgetContent
              collapsed={false}
              standalone
            />
          </div>
          <div className='flex flex-col gap-1'>
            <span className='cg-text-lg-500'>Select amount to give</span>
            <span className='cg-text-md-400 cg-text-secondary'>Spark to give to this community</span>
          </div>
          <div className='grid grid-cols-2 gap-2'>
            {[5000, 10000, 20000, 50000].map((amount) => (
              <Button
                key={`give_coins_${amount}`}
                role='secondary'
                iconLeft={<SparkIcon className='h-4 w-4' />}
                text={amount.toLocaleString()}
                className={amount === coinAmount ? 'active justify-start max-w-full' : 'justify-start max-w-full'}
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
        </div>
        <Button
          longPress
          className='w-full self-center'
          role='primary'
          text='Hold to confirm'
          onClick={onGiveCoins}
          loading={isLoading}
        />
      </>}
    </div>

    <div className='flex flex-col gap-0.5'>
      <span className='cg-heading-3 cg-text-main'>Upgrade Community</span>
      <span className='cg-text-md-400 cg-text-secondary'>Use Spark to upgrade your community. Upgrades are optional and non-refundable. Prices are in Spark. <SimpleLink inlineLink className='underline' href={learnMoreLink}>Learn more</SimpleLink> or <span className='underline cursor-pointer' onClick={onClickBuySpark}>Buy Spark</span></span>
    </div>

    <div className='flex gap-2'>
      <Button
        role='chip'
        text='Upgrades'
        className={tab === 'upgrades' ? 'active cg-text-md-500' : 'cg-text-md-500'}
        onClick={() => setTab('upgrades')}
      />
      <Button
        role='chip'
        text='Billing'
        className={tab === 'billing' ? 'active cg-text-md-500' : 'cg-text-md-500'}
        onClick={() => setTab('billing')}
      />
    </div>

    {tab === 'upgrades' && <UpgradesTab />}
    {tab === 'billing' && <BillingTab />}

    {/* <div> OLD STUFF =============================================================</div>

    <div className="premium-management-header">
      Premium Management
    </div>

    <div className="premium-management-points">
      You have {community.pointBalance} premium points in this community.<br />
      You have {ownUser?.pointBalance || 0} premium points on your user account.
    </div>

    <div className="premium-management-give">
      <Button
        role='primary'
        text='Give 1.000'
        onClick={() => givePointsToCommunity(1_000)}
        disabled={(ownUser?.pointBalance || 0) < 1_000 || isLoading}
      />
      <Button
        role='primary'
        text='Give 5.000'
        onClick={() => givePointsToCommunity(5_000)}
        disabled={(ownUser?.pointBalance || 0) < 5_000 || isLoading}
      />
      <Button
        role='primary'
        text='Give 10.000'
        onClick={() => givePointsToCommunity(10_000)}
        disabled={(ownUser?.pointBalance || 0) < 10_000 || isLoading}
      />
    </div>

    <TokenRolePremium community={community} /> */}
  </>

  if (isMobile) {
    return <div className='flex flex-col h-full'>
      <ManagementHeader2
        title="Community Safe"
        goBack={() => navigate(-1)}
        help='The Community Safe keeps the Spark of the community. You can spend Spark on community upgrades. Give Spark to top up the Safe.'
      />
      <Scrollable>
        <div className="flex flex-col gap-4 p-4">
          {content}
        </div>
      </Scrollable>
    </div>
  } else {
    return <div>
      <div className="flex flex-col gap-4 pb-4 max-w-full">
        <ManagementHeader2
          title="Community Safe"
          help='The Community Safe keeps the Spark of the community. You can spend Spark on community upgrades. Give Spark to top up the Safe.'
        />
        {content}
      </div>
    </div>;
  }
}

export default React.memo(PremiumManagement);