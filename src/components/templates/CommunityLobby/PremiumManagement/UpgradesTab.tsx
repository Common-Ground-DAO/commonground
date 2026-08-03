// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLoadedCommunityContext } from "context/CommunityProvider";
import config from "common/config";
import ToggleInputField from "components/molecules/inputs/ToggleInputField/ToggleInputField";
import Tag from "components/atoms/Tag/Tag";
import dayjs from "dayjs";
import SparkIcon from '../../../atoms/icons/misc/spark.svg?react';
import { useCommunityPremiumTier } from "hooks/usePremiumTier";
import "./UpgradesTab.css";
import Button from "components/atoms/Button/Button";
import communityApi from "data/api/community";
import { calculateCommunityUpgradeCost } from "common/util";
import { PokerChip, UserCircle, Users, Lectern } from "@phosphor-icons/react";
import { getTierElementIcon, getTierElementTitle, getTierIcon, getTierTitle } from "util/index";
import TextInputField from "components/molecules/inputs/TextInputField/TextInputField";
import { ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import { useSnackbarContext } from "context/SnackbarContext";

const UpgradesTab: React.FC = () => {
  const { community } = useLoadedCommunityContext();
  const [annualBilling, setAnnualBilling] = useState(false);

  const { premium } = community;
  const { tier, autoRenew } = useCommunityPremiumTier(premium);
  const activeUntil = !!premium ? dayjs(premium.activeUntil) : null;
  const [tierToBuy, setTierToBuy] = useState<Models.Community.PremiumName | null>(null);
  const [pickedUrl, setPickedUrl] = useState(community.url);
  const [urlError, setUrlError] = useState<string | null>(null);
  const { isMobile } = useWindowSizeContext();
  const { showSnackbar } = useSnackbarContext();
  const [isUrlLoading, setIsUrlLoading] = useState(false);

  const upgradeUrl = useCallback(async () => {
    if (isUrlLoading) return;
    try {
      setIsUrlLoading(true);
      if (!pickedUrl) {
        setUrlError('Don’t forget to pick a url');
        return;
      } else if (pickedUrl === community.url) {
        return;
      }

      await communityApi.buyCommunityPremiumFeature({
        communityId: community.id,
        featureName: 'URL_CHANGE',
        url: pickedUrl
      });

      showSnackbar({ type: 'success', text: 'URL changed successfully' });
    }
    catch (error) {
      showSnackbar({ type: 'warning', text: 'URL is already taken' });
    }
    finally {
      setIsUrlLoading(false);
    }
  }, [community.id, community.url, pickedUrl, isUrlLoading]);

  const confirmBuyTierOverlay = useMemo(() => {
    if (!tierToBuy) return null;

    let tierDataKey: 'COMMUNITY_BASIC' | 'COMMUNITY_PRO' | 'COMMUNITY_ENTERPRISE' | 'COMMUNITY_FREE';
    if (tierToBuy === 'BASIC') tierDataKey = 'COMMUNITY_BASIC' as const;
    else if (tierToBuy === 'PRO') tierDataKey = 'COMMUNITY_PRO' as const;
    else if (tierToBuy === 'ENTERPRISE') tierDataKey = 'COMMUNITY_ENTERPRISE' as const;
    else tierDataKey = 'COMMUNITY_FREE' as const;

    let isUpgrade = false;
    let price: number = config.PREMIUM[tierDataKey].MONTHLY_PRICE;
    
    if (!!tier && !!activeUntil) {
      price = calculateCommunityUpgradeCost({ featureName: tier, activeUntil: activeUntil.toISOString() }, tierToBuy, true);
      isUpgrade = true;
    }
    else if (annualBilling) {
      price = Math.round(price * 12 * ((100 - config.PREMIUM.YEARLY_DISCOUNT_PERCENT) / 100));
    }

    let buyButtonContent: string = isUpgrade ? 'Upgrade' : 'Buy';

    const buyTier = async () => {
      await communityApi.buyCommunityPremiumFeature({
        communityId: community.id,
        featureName: tierToBuy,
        duration: isUpgrade ? 'upgrade' : annualBilling ? 'year' : 'month'
      });
      setTierToBuy(null);
    };

    return <div className="confirm-buy-tier-overlay">
      <div className="confirm-buy-tier-overlay-content cg-text-main">
        <div className="cg-heading-2">Upgrade</div>
        <div>
          You are about to upgrade your community to the {getTierTitle(tierToBuy)}.
          <br/>
          This will cost you <SparkIcon className="w-4 h-4 inline-block mr-1" />{price.toLocaleString()} and will be effective immediately.
          <br/><br/>
          Proceed?
        </div>
        <div className="flex flex-row gap-2 items-stretch">
          <Button
            role="secondary"
            text="Cancel"
            onClick={() => setTierToBuy(null)}
            className="flex-1"
          />
          <Button
            role="primary"
            text={buyButtonContent}
            onClick={buyTier}
            className="flex-1"
          />
        </div>
      </div>
    </div>
  }, [tier, annualBilling, tierToBuy, activeUntil]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-stretch gap-2">
        <h3 className="cg-heading-3 cg-text-main p-2">Community tiers</h3>
        <div className="flex items-center gap-2 ml-auto">
          <span className="cg-text-lg-500 cg-text-main">Yearly Billing</span>
          <ToggleInputField
            toggled={annualBilling}
            onChange={setAnnualBilling}
          />
          <Tag variant="live" label="-20%" iconLeft={<></>} />
        </div>
      </div>
      <div className="flex flex-row rounded-xl w-full cg-content-stack">
        <div className="community-upgrades-labels-column">
          <div className="community-upgrades-title" style={{ color: 'var(--text-primary)' }}>
            Plans
          </div>
          <div>
            <span className="cg-text-secondary">&nbsp;</span>
          </div>
          <div className="community-upgrades-labels cg-text-secondary">
            <div className="mt-2 font-bold" style={{ color: 'var(--text-primary)' }}>{annualBilling ? 'Yearly' : 'Monthly'} price</div>
            <div className="mt-2 font-bold" style={{ color: 'var(--text-primary)' }}>Community</div>
            <div>Custom roles</div>
            <div>Tokens</div>
            <div>On frontpage</div>
            <div className="mt-2 font-bold" style={{ color: 'var(--text-primary)' }}>Calls</div>
            <div>1080p Video</div>
            <div className="mt-2 font-bold" style={{ color: 'var(--text-primary)' }}>Broadcasts</div>
            <div>Presenters</div>
            <div>720p Video</div>
            <div>1080p Video</div>
            <div>Audio</div>
          </div>
        </div>
        <div className="flex flex-row overflow-x-auto flex-1">
          <TierElement
            tier="FREE"
            activeTier={tier || 'FREE'}
            isYearly={annualBilling}
            autoRenew={autoRenew}
            community={community}
            setTierToBuy={setTierToBuy}
          />
          <TierElement
            tier="BASIC"
            activeTier={tier || 'FREE'}
            activeUntil={activeUntil?.format('MMM D, YYYY')}
            isYearly={annualBilling}
            autoRenew={autoRenew}
            community={community}
            setTierToBuy={setTierToBuy}
          />
          <TierElement
            tier="PRO"
            activeTier={tier || 'FREE'}
            activeUntil={activeUntil?.format('MMM D, YYYY')}
            isYearly={annualBilling}
            autoRenew={autoRenew}
            community={community}
            setTierToBuy={setTierToBuy}
          />
          <TierElement
            tier="ENTERPRISE"
            activeTier={tier || 'FREE'}
            activeUntil={activeUntil?.format('MMM D, YYYY')}
            isYearly={annualBilling}
            autoRenew={autoRenew}
            community={community}
            setTierToBuy={setTierToBuy}
          />
        </div>
      </div>

      <div className="flex items-stretch gap-2">
        <h3 className="cg-heading-3 cg-text-main pt-4 pb-2">Community URL</h3>
      </div>

      <div className={`flex py-6 px-4 gap-4 flex-1${isMobile ? ' flex-col' : ''} rounded-xl cg-content-stack`}>
        <div className="cg-bg-subtle h-10 w-10 cg-border-m">{getTierIcon('URL_CHANGE')}</div>
        <div className="flex-1">
          <span className="cg-heading-3 cg-text-main">Unique community URL</span>
          <div className="flex flex-col gap-2 cg-text-lg-400 cg-text-secondary">
            <span>Get a clean URL for your community permanently. Buy it once and it’s yours permanently! It can be changed anytime at additional cost, and you can only have 1 unique URL at a time.</span>
            <div className="flex flex-col">
              <span className="cg-text-lg-500 cg-text-main">Choose your URL</span>
              <span className="cg-text-md-400 cg-text">Must be unique</span>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <span className="cg-text-md-400">app.cg/c/</span>
              <TextInputField
                placeholder="your-url"
                value={pickedUrl}
                onChange={setPickedUrl}
                inputClassName="max-w-xs w-auto"
              />
            </div>
            {!!urlError && <div className="flex items-center gap-1 cg-text-warning">
              <ExclamationTriangleIcon className="w-5 h-5" />
              <span>{urlError}</span>
            </div>}
          </div>
        </div>
        <div className="cg-bg-subtle cg-border-xxl cg-text-main flex flex-col w-36 items-center overflow-hidden cursor-pointer h-fit" onClick={upgradeUrl}>
          <div className="py-4 px-2">Change URL</div>
          <div className="flex items-center justify-center w-full h-full py-4 px-3 gap-1 cg-bg-subtle">
            <SparkIcon className="w-5 h-5" />
            <span className="cg-text-md-500">{config.PREMIUM.URL_CHANGE.ONETIME_PRICE.toLocaleString()}</span>
          </div>
        </div>
      </div>

      {confirmBuyTierOverlay}
    </div>
  );
};

function TierElement(props: {
  tier: Models.Community.PremiumName | 'FREE',
  activeTier: Models.Community.PremiumName | 'FREE',
  activeUntil?: string,
  isYearly: boolean,
  autoRenew: Common.PremiumRenewal | null,
  community: Models.Community.DetailView,
  setTierToBuy: (tier: Models.Community.PremiumName) => void,
}) {
  const [recalcCounter, setRecalcCounter] = useState(0);

  const {
    tier,
    activeTier,
    activeUntil,
    isYearly,
    autoRenew,
    community,
    setTierToBuy,
  } = props;
  const key = useMemo(() => {
    if (tier === 'BASIC') return 'COMMUNITY_BASIC' as const;
    if (tier === 'PRO') return 'COMMUNITY_PRO' as const;
    if (tier === 'ENTERPRISE') return 'COMMUNITY_ENTERPRISE' as const;
    return 'COMMUNITY_FREE' as const;
  }, [tier]);

  const {
    MONTHLY_PRICE,
    ROLE_LIMIT,
    TOKEN_LIMIT,
    CALL_AUDIO,
    CALL_STANDARD,
    CALL_HD,
    BROADCASTERS_SLOTS,
    BROADCAST_HD,
    BROADCAST_STANDARD,
    BROADCAST_AUDIO,
  } = config.PREMIUM[key];

  const isActive = tier === activeTier;

  const { showBuyButton, buyButtonText, price, isUpgrade } = useMemo(() => {
    let price: number = MONTHLY_PRICE;
    if (isYearly) {
      price = Math.round(MONTHLY_PRICE * 12 * ((100 - config.PREMIUM.YEARLY_DISCOUNT_PERCENT) / 100));
    }
    let isUpgrade = false;
    let showBuyButton = false;
    let buyButtonText = 'Buy';
    if (tier === 'BASIC') {
      if (activeTier === 'FREE') {
        showBuyButton = true;
      }
    }
    else if (tier === 'PRO') {
      if (activeTier === 'FREE') {
        showBuyButton = true;
      }
      else if (activeTier === 'BASIC') {
        showBuyButton = true;
        buyButtonText = `Upgrade`;
        isUpgrade = true;
      }
    }
    else if (tier === 'ENTERPRISE') {
      if (activeTier === 'FREE') {
        showBuyButton = true;
      }
      else if (activeTier === 'BASIC' || activeTier === 'PRO') {
        showBuyButton = true;
        buyButtonText = `Upgrade`;
        isUpgrade = true;
      }
    }
    return { showBuyButton, buyButtonText, price, isUpgrade };
  }, [tier, activeTier, activeUntil, isYearly, recalcCounter]);

  

  const setAutoRenew = useCallback(async (renewal: Common.PremiumRenewal | null) => {
    if (tier === 'FREE') return;
    await communityApi.setPremiumFeatureAutoRenew({ communityId: community.id, featureName: tier, autoRenew: renewal });
  }, [community.id, tier]);

  useEffect(() => {
    if (isUpgrade) {
      const interval = setInterval(() => {
        setRecalcCounter(prev => prev + 1);
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [isUpgrade]);

  return (
    <div className={`community-upgrades-tier-container ${isActive ? 'community-tier-selected' : ''}`}>
      <div className="community-upgrades-title" style={{ color: 'var(--text-primary)' }}>
        {tier !== 'FREE' && getTierElementIcon(tier)} {getTierElementTitle(tier)}
      </div>
      <div>
        {!!isActive
          ? activeUntil
            ? <span className="cg-text-secondary">Until {activeUntil}</span>
            : <span className="cg-text-secondary">Active</span>
          : <span className="cg-text-secondary">{tier === "PRO" ? 'Recommended' : <>&nbsp;</>}</span>}
      </div>
      
      <div className="community-upgrades-values cg-text-secondary">
        <div className="mt-2">{tier === 'FREE' ? 'Free' : <><SparkIcon className="w-4 h-4 inline-block mr-1" />{price.toLocaleString()}</>}</div>
        <div className="mt-2">&nbsp;</div>
        <div><UserCircle className="w-4 h-4 inline-block mr-1" />{ROLE_LIMIT}</div>
        <div><PokerChip className="w-4 h-4 inline-block mr-1" />{TOKEN_LIMIT}</div>
        <div>{tier === 'FREE' ? '✗' : '✔'}</div>
        <div className="mt-2">&nbsp;</div>
        <div><Users className="w-4 h-4 inline-block mr-1" />{CALL_HD}</div>
        <div className="mt-2">&nbsp;</div>
        <div><Lectern className="w-4 h-4 inline-block mr-1" />{BROADCASTERS_SLOTS}</div>
        <div><Users className="w-4 h-4 inline-block mr-1" />{BROADCAST_STANDARD}</div>
        <div><Users className="w-4 h-4 inline-block mr-1" />{BROADCAST_HD}</div>
        <div><Users className="w-4 h-4 inline-block mr-1" />{BROADCAST_AUDIO}</div>
      </div>
      {showBuyButton && tier !== 'FREE' && <div className="w-full">
        <Button
          role="primary"
          text={buyButtonText}
          onClick={() => setTierToBuy(tier)}
          className="w-full mt-4"
        />
      </div>}
      {tier !== 'FREE' && !!isActive && <div className="w-full cg-text-main mt-4">
        <span className="cg-text-secondary">Auto-renewal</span><br />
        <div className="pb-1" onClick={() => setAutoRenew('MONTH')}>
          <input type="radio" name="renewal" checked={autoRenew === 'MONTH'} /><span className="ml-2">monthly</span><br />
        </div>
        <div className="pb-1" onClick={() => setAutoRenew('YEAR')}>
          <input type="radio" name="renewal" checked={autoRenew === 'YEAR'} /><span className="ml-2">yearly</span><br />
        </div>
        <div className="pb-1" onClick={() => setAutoRenew(null)}>
          <input type="radio" name="renewal" checked={!autoRenew} /><span className="ml-2">disabled</span>
        </div>
      </div>}
    </div>
  );
}

export default React.memo(UpgradesTab);