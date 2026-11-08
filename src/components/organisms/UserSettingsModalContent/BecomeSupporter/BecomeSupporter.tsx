// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './BecomeSupporter.css';
import React, { useMemo } from 'react';
import { PageType } from '../UserSettingsModalContent';
import { useOwnUser } from 'context/OwnDataProvider';
import Button from 'components/atoms/Button/Button';
import config from 'common/config';
import { useUserSettingsContext } from 'context/UserSettingsProvider';
import SupporterIcon from 'components/atoms/SupporterIcon/SupporterIcon';
import SparkIcon from 'components/atoms/icons/misc/spark.svg?react';
import useLocalStorage from 'hooks/useLocalStorage';
import { usePremiumTier } from 'hooks/usePremiumTier';
import SupporterScreen from 'components/organisms/SupporterScreen/SupporterScreen';
import { calculateSupporterUpgradeCost } from 'common/util';
import { UserPremiumFeatureName } from 'common/enums';

type Props = {
  setCurrentPage: (pageType: PageType) => void;
};

export type SupporterTileProps = {
  duration: 'month' | 'year' | 'upgrade';
  type: 'silver' | 'gold';
  price: number;
  clickable?: boolean;
};

const supporterEntries: SupporterTileProps[] = [{
  type: 'silver',
  duration: 'month',
  price: config.PREMIUM.USER_SUPPORTER_1.MONTHLY_PRICE
}, {
  type: 'silver',
  duration: 'year',
  price: config.PREMIUM.USER_SUPPORTER_1.MONTHLY_PRICE * 12 * (1 - (config.PREMIUM.YEARLY_DISCOUNT_PERCENT / 100))
}, {
  type: 'gold',
  duration: 'month',
  price: config.PREMIUM.USER_SUPPORTER_2.MONTHLY_PRICE
}, {
  type: 'gold',
  duration: 'year',
  price: config.PREMIUM.USER_SUPPORTER_2.MONTHLY_PRICE * 12 * (1 - (config.PREMIUM.YEARLY_DISCOUNT_PERCENT / 100))
}];

const BecomeSupporter: React.FC<Props> = (props) => {
  const { setCurrentPage } = props;
  const tier = usePremiumTier();

  const upgradePrice = useMemo(() => {
    if (tier.type === 'silver') {
      const { price } = calculateSupporterUpgradeCost([{
        featureName: UserPremiumFeatureName.SUPPORTER_1,
        activeUntil: tier.activeUntil.toISOString()
      }], UserPremiumFeatureName.SUPPORTER_2);

      return price;
    }

    return 0;
  }, [tier]);

  return (<div className='flex flex-col px-4 gap-4 cg-text-main cg-text-lg-400'>
    {tier.type === 'free' && <>
      <div className='flex flex-col gap-2'>
        <span>Support CG: get a shiny badge on your profile picture, get access to “Supporters Only” Roles in communities</span>
        <span className='cg-text-secondary'>Badges may offer other benefits in future.</span>

        <div className='grid grid-cols-2 gap-2'>
          {supporterEntries.map(entry => <SupporterTile
            key={entry.type + entry.price}
            {...entry}
            clickable
          />)}
        </div>
      </div>

      <Button
        iconLeft={<SparkIcon className='w-5 h-5' />}
        role='secondary'
        text='Get Spark'
        onClick={() => setCurrentPage('get-spark')}
      />
    </>}
    {tier.type !== 'free' && <SupporterScreen />}

    {tier.type === 'silver' && <>
      <div className='flex flex-col gap-2'>
        <h3 className='cg-heading-3'>Upgrade</h3>
        <SupporterTile
          duration='upgrade'
          price={upgradePrice}
          type='gold'
          clickable
        />
      </div>
      <Button
        iconLeft={<SparkIcon className='w-5 h-5' />}
        role='secondary'
        text='Get Spark'
        onClick={() => setCurrentPage('get-spark')}
      />
    </>}
  </div>);
}

export const SupporterTile: React.FC<SupporterTileProps> = React.memo((props) => {
  const { setCurrentPage } = useUserSettingsContext();
  const ownUser = useOwnUser();
  const [, setSupporterPack] = useLocalStorage<SupporterTileProps>({
    duration: 'month',
    type: 'silver',
    price: 0
  }, "CHOSEN_SUPPORTER_PACK");

  const className = [
    'h-44 cg-bg-subtle cg-border-xxl flex flex-col items-center justify-center cg-text-main overflow-hidden relative self-stretch',
    props.clickable ? 'cursor-pointer' : ''
  ].join(' ').trim();

  return <div
    className={className}
    onClick={props.clickable ? () => {
      if ((ownUser?.pointBalance || 0) < props.price) {
        setCurrentPage('not-enough-spark');
      } else {
        setSupporterPack(props);
        setCurrentPage('supporter-purchase-confirm');
      }
    } : undefined}
  >
    <div className='blurred-support-tile absolute'>
      <SupporterIcon type={props.type} size={40} />
    </div>

    <div className={`flex items-center justify-center h-20 flex-1`}>
      {props.duration === 'year' && <SupporterIcon type={props.type} size={40} className='opacity-40' />}
      <SupporterIcon type={props.type} size={40} />
      {props.duration === 'year' && <SupporterIcon type={props.type} size={40} className='opacity-40' />}
    </div>
    <div className='flex flex-col py-2 px-1 gap-1 items-center cg-text-main'>
      {props.duration !== 'upgrade' && <>
        <span>1 {props.duration}</span>
        <span>CG {props.type === 'silver' ? 'Silver' : 'Gold'}</span>
      </>}
      {props.duration === 'upgrade' && <span>Upgrade to CG {props.type === 'silver' ? 'Silver' : 'Gold'}</span>}
    </div>
    <div className='flex items-center justify-center h-9 self-stretch cg-bg-subtle'>
      <span className={`cg-text-md-500 ${props.duration === 'year' ? 'cg-text-success' : 'cg-text-main'}`}>{props.price.toLocaleString()}</span>
    </div>
  </div>;
});

// const BecomeSupporter: React.FC<Props> = (props) => {
//   const { setCurrentPage } = props;
//   const ownUser = useOwnUser();

//   const buyPremium = useCallback(async (featureName: UserPremiumFeatureName, duration: 'month' | 'year' | 'upgrade') => {
//     await userApi.buyUserPremiumFeature({
//       featureName,
//       duration,
//     });
//   }, []);

//   const setAutoRenew = useCallback(async (featureName: UserPremiumFeatureName, autoRenew: Common.PremiumRenewal | null) => {
//     await userApi.setPremiumFeatureAutoRenew({
//       featureName,
//       autoRenew,
//     });
//   }, []);

//   const tier: {
//     type: 'free';
//    } | {
//     type: 'silver' | 'gold';
//     activeUntil: Date;
//     autoRenew: Common.PremiumRenewal | null | undefined;
//   } = useMemo(() => {
//     const now = new Date();
//     let feature: Models.User.PremiumFeature | undefined = ownUser?.premiumFeatures.find(f => f.featureName === 'SUPPORTER_2' && new Date(f.activeUntil) > now);
//     if (!!feature) {
//       return {
//         type: 'gold',
//         activeUntil: new Date(feature.activeUntil),
//         autoRenew: feature.autoRenew,
//       };
//     }
//     feature = ownUser?.premiumFeatures.find(f => f.featureName === 'SUPPORTER_1' && new Date(f.activeUntil) > now);
//     if (!!feature) {
//       return {
//         type: 'silver',
//         activeUntil: new Date(feature.activeUntil),
//         autoRenew: feature.autoRenew,
//       };
//     }
//     return {
//       type: 'free',
//     };
//   }, [ownUser?.premiumFeatures]);

//   return (<div className='flex flex-col px-4 gap-4 cg-text-main'>
//     {tier.type === 'free' && <>
//       <div>Free tier</div>
//       <Button
//         role='primary'
//         text={`Buy silver 1 month (${config.PREMIUM.USER_SUPPORTER_1.MONTHLY_PRICE})`}
//         onClick={() => buyPremium(UserPremiumFeatureName.SUPPORTER_1, 'month')}
//       />
//       <Button
//         role='primary'
//         text={`Buy silver 1 year (${config.PREMIUM.YEARLY_DISCOUNT_PERCENT}% off, ${config.PREMIUM.USER_SUPPORTER_1.MONTHLY_PRICE * 12 * (1 - (config.PREMIUM.YEARLY_DISCOUNT_PERCENT / 100))})`}
//         onClick={() => buyPremium(UserPremiumFeatureName.SUPPORTER_1, 'year')}
//       />
//       <Button
//         role='primary'
//         text={`Buy gold 1 month (${config.PREMIUM.USER_SUPPORTER_2.MONTHLY_PRICE})`}
//         onClick={() => buyPremium(UserPremiumFeatureName.SUPPORTER_2, 'month')}
//       />
//       <Button
//         role='primary'
//         text={`Buy gold 1 year (${config.PREMIUM.YEARLY_DISCOUNT_PERCENT}% off, ${config.PREMIUM.USER_SUPPORTER_2.MONTHLY_PRICE * 12 * (1 - (config.PREMIUM.YEARLY_DISCOUNT_PERCENT / 100))})`}
//         onClick={() => buyPremium(UserPremiumFeatureName.SUPPORTER_2, 'year')}
//       />
//     </>}
//     {tier.type === 'silver' && <>
//       <div>Silver tier (active until {dayjs(tier.activeUntil).format()})</div>
//       <div>Renewal: {tier.autoRenew || 'off'}</div>
//       <Button
//         role='primary'
//         text='Upgrade to Pro for the remaining time'
//         onClick={() => buyPremium(UserPremiumFeatureName.SUPPORTER_2, 'upgrade')}
//       />
//       {(!tier.autoRenew || tier.autoRenew === 'YEAR') && <Button
//         role='primary'
//         text={`Set to monthly renewal`}
//         onClick={() => setAutoRenew(UserPremiumFeatureName.SUPPORTER_1, PremiumRenewal.MONTH)}
//       />}
//       {(!tier.autoRenew || tier.autoRenew === 'MONTH') && <Button
//         role='primary'
//         text={`Set to yearly renewal`}
//         onClick={() => setAutoRenew(UserPremiumFeatureName.SUPPORTER_1, PremiumRenewal.YEAR)}
//       />}
//       {(tier.autoRenew === 'MONTH' || tier.autoRenew === 'YEAR') && <Button
//         role='primary'
//         text={`Switch off renewal`}
//         onClick={() => setAutoRenew(UserPremiumFeatureName.SUPPORTER_1, null)}
//       />}
//     </>}
//     {tier.type === 'gold' && <>
//       <div>Gold tier (active until {dayjs(tier.activeUntil).format()})</div>
//       <div>Renewal: {tier.autoRenew || 'off'}</div>
//       {(!tier.autoRenew || tier.autoRenew === 'YEAR') && <Button
//         role='primary'
//         text={`Set to monthly renewal`}
//         onClick={() => setAutoRenew(UserPremiumFeatureName.SUPPORTER_2, PremiumRenewal.MONTH)}
//       />}
//       {(!tier.autoRenew || tier.autoRenew === 'MONTH') && <Button
//         role='primary'
//         text={`Set to yearly renewal`}
//         onClick={() => setAutoRenew(UserPremiumFeatureName.SUPPORTER_2, PremiumRenewal.YEAR)}
//       />}
//       {(tier.autoRenew === 'MONTH' || tier.autoRenew === 'YEAR') && <Button
//         role='primary'
//         text={`Switch off renewal`}
//         onClick={() => setAutoRenew(UserPremiumFeatureName.SUPPORTER_2, null)}
//       />}
//     </>}
//   </div>);
// }

export default React.memo(BecomeSupporter);