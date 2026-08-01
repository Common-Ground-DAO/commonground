// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useMemo, useRef, useState } from 'react'
import './UserSettingsModalContent.css';

import PickerPage from './PickerPage/PickerPage';
import ThemePage from './ThemePage/ThemePage';
import FeedbackPage from './FeedbackPage/FeedbackPage';
import NotificationsPage from './NotificationsPage/NotificationsPage';
import CommunityNotificationsPage from './CommunityNotificationsPage/CommunityNotificationsPage';
import AccountsPage from './AccountsPage/AccountsPage';
import ProfilePage from './ProfilePage/ProfilePage';
import UserSettingsTitle from './UserSettingsTitle/UserSettingsTitle';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import AvailableProviders from './AvailableProvidersPage/AvailableProvidersPage';
import EmailPage from './EmailPage/EmailPage';
import WalletPage from './WalletPage/WalletPage';
import { UserWidgetContent } from 'components/molecules/UserWidget/UserWidget';
import SignWalletPage from './SignWalletPage/SignWalletPage';
import ExternalAccountPage from './ExternalAccountPage/ExternalAccountPage';
import { ExternalAccountType } from './AccountsPage/AccountsPage';
import SignWithUniversalProfile from './SignWalletPage/SignWithUniversalProfile';
import AnimatedTabPageContainer from 'components/atoms/AnimatedTabPage/AnimatedTabPageContainer';
import AnimatedTabPage from 'components/atoms/AnimatedTabPage/AnimatedTabPage';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { useUserSettingsContext } from 'context/UserSettingsProvider';
import BecomeSupporter from './BecomeSupporter/BecomeSupporter';
import GetSpark from './GetSpark/GetSpark';
import PaySpark from './PaySpark/PaySpark';
import GiveSpark from './GiveSpark/GiveSpark';
import NotEnoughSpark from './NotEnoughSpark/NotEnoughSpark';
import PaySparkSuccess from './PaySparkSuccess/PaySparkSuccess';
import HowSparkWorks from './HowSparkWorks/HowSparkWorks';
import SupporterPurchaseConfirm from './SupporterPurchaseConfirm/SupporterPurchaseConfirm';
import SupporterPurchaseSuccess from './SupporterPurchaseSuccess/SupporterPurchaseSuccess';
import { usePremiumTier } from 'hooks/usePremiumTier';
import PasskeySettings from './PasskeySettings/PasskeySettings';
import { SignWithFarcaster } from './SignWalletPage/SignWithFarcaster';
import BotsPage from './BotsPage/BotsPage';
import BotEditor from './BotsPage/BotEditor';

export const allPageTypes = [
  'home',
  'theme',
  'feedback',
  'notifications',
  'profile',
  'accounts',
  'become-supporter',
  'supporter-purchase-confirm',
  'supporter-purchase-success',
  'how-spark-works',
  'get-spark',
  'pay-spark',
  'pay-spark-success',
  'give-spark',
  'not-enough-spark',
  'community-notifications',
  'available-providers',
  'email-account-accounts',
  'email-account-available-providers',
  'wallet',
  'external-account',
  'sign-with-universal-profile',
  'sign-with-farcaster',
  'sign-wallet',
  'passkey-settings',
  'bots',
  'bot-editor'
] as const;

export type PageType = typeof allPageTypes[number];

type Props = {
  lockModal?: (lock: boolean) => void;
  collapsed?: boolean;
  closed?: boolean;
  setIsClosed: (open: boolean) => void;
  closedWidth?: number;
  callMode?: boolean;
};

const FOOTERHEIGHTCOLLAPSED = 64;
const FOOTERHEIGHT = 64;
const DESKTOP_EXPANDED_WIDTH = 340;

const screenOrder: Record<PageType, number> = {
  home: 0,
  theme: 1,
  feedback: 1,
  notifications: 1,
  accounts: 1,
  "become-supporter": 1,
  "supporter-purchase-confirm": 2,
  "supporter-purchase-success": 3,
  "how-spark-works": 1,
  "get-spark": 1,
  "pay-spark": 2,
  "not-enough-spark": 3,
  "pay-spark-success": 4,
  profile: 1,
  "community-notifications": 2,
  "available-providers": 2,
  "email-account-accounts": 3,
  "email-account-available-providers": 3,
  wallet: 3,
  "external-account": 3,
  "sign-wallet": 4,
  "sign-with-universal-profile": 4,
  "sign-with-farcaster": 4,
  "give-spark": 1,
  "passkey-settings": 2,
  bots: 1,
  "bot-editor": 2,
};

const UserSettingsModalContent: React.FC<Props> = (props) => {
  const { setIsClosed } = props;
  const { isMobile } = useWindowSizeContext();
  const { currentPage, setCurrentPage } = useUserSettingsContext();
  const [currentAccount, setCurrentAccount] = useState<ExternalAccountType>('twitter');
  const [currentWallet, setCurrentWallet] = useState('');
  const [currentBot, setCurrentBot] = useState<API.Bot.BotView | null>(null);
  const [currentBotOwner, setCurrentBotOwner] = useState<API.Bot.Owner>({ ownerType: 'user', ownerId: null });
  const [currentHeight, setCurrentHeight] = useState(0);
  const lockModal = useMemo(() => props.lockModal || (() => { }), [props.lockModal]);
  const contentRef = useRef<HTMLDivElement>(null);
  const premiumTier = usePremiumTier();

  // Resize listener for grow/shrink animation
  useEffect(() => {
    const listener: ResizeObserverCallback = async ([entry]) => {
      if (entry) {
        const height = entry.contentRect.height;
        setCurrentHeight(height + (props.closed ? FOOTERHEIGHTCOLLAPSED : FOOTERHEIGHT));
      }
    }

    const observer = new ResizeObserver(listener);
    if (contentRef.current) {
      observer.observe(contentRef.current);
    }

    return () => observer.disconnect();
  }, [props.collapsed, props.closed]);

  useEffect(() => {
    // Reset page when closed
    if (props.closed) setCurrentPage('home');
  }, [props.closed, setCurrentPage]);

  const title = useMemo(() => {
    if (currentPage === 'home') return null;

    const renderTitle = () => {
      switch (currentPage) {
        case 'theme': return 'Theme';
        case 'feedback': return 'Feedback';
        case 'notifications': return 'Notifications';
        case 'community-notifications': return 'Community Notifications';
        case 'accounts': return 'Accounts';
        case 'available-providers': return 'Available Providers';
        case 'email-account-accounts': return 'Email Account';
        case 'email-account-available-providers': return 'Add an Email Account';
        case 'wallet': return 'Wallet';
        case 'external-account': return 'Account';
        case 'become-supporter':
          if (premiumTier.type === 'free') return 'Become a supporter';
          else return 'Supporter Badge';
        case 'supporter-purchase-confirm': return 'Confirmation';
        case 'supporter-purchase-success': return 'Back';
        case 'get-spark': return 'Spark';
        case 'pay-spark': return 'Payment';
        case 'pay-spark-success': return 'Spark';
        case 'not-enough-spark': return 'Not enough Spark';
        case 'how-spark-works': return 'Spark';
        case 'profile': return 'Profile';
        case 'sign-wallet': return 'Wallet';
        case 'sign-with-universal-profile': return 'Universal Profile';
        case 'sign-with-farcaster': return 'Farcaster';
        case 'give-spark': return 'Give Spark to Community';
        case 'passkey-settings': return 'Passkeys';
        case 'bots': return 'Bots';
        case 'bot-editor': return currentBot ? `@${currentBot.username}` : 'New Bot';
        default: return 'Settings';
      }
    }

    const goBack = () => {
      switch (currentPage) {
        case 'theme':
        case 'feedback':
        case 'notifications':
        case 'accounts':
        case 'become-supporter':
        case 'get-spark':
        case 'profile':
        case 'give-spark':
        case 'pay-spark-success':
        case 'how-spark-works':
        case 'supporter-purchase-success':
        case 'bots':
          setCurrentPage('home');
          break;
        case 'bot-editor':
          setCurrentPage('bots');
          break;
        case 'pay-spark':
          setCurrentPage('get-spark');
          break;
        case 'not-enough-spark':
          setCurrentPage('give-spark');
          break;
        case 'community-notifications':
          setCurrentPage('notifications');
          break;
        case 'available-providers':
        case 'email-account-accounts':
        case 'wallet':
        case 'sign-with-universal-profile':
        case 'external-account':
        case 'passkey-settings':
          setCurrentPage('accounts');
          break;
        case 'email-account-available-providers':
        case 'sign-wallet':
        case 'sign-with-farcaster':
          setCurrentPage('available-providers');
          break;
        case 'supporter-purchase-confirm':
          setCurrentPage('become-supporter');
          break;
        default:
          setCurrentPage('home');
          break;
      }
    }

    return <UserSettingsTitle title={renderTitle()} goBack={goBack} />
  }, [currentPage, premiumTier.type, setCurrentPage, currentBot]);

  const content = useMemo(() => {
    return <AnimatedTabPageContainer currentScreen={currentPage} screenOrder={screenOrder}>
      <AnimatedTabPage visible={currentPage === 'home'} className=''>
        <PickerPage setPage={setCurrentPage} lockModal={lockModal} closeModal={() => setIsClosed?.(true)} />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'theme'} className=''>
        <ThemePage />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'feedback'} className='' >
        <FeedbackPage />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'notifications'} className='' >
        <NotificationsPage setCurrentPage={setCurrentPage} />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'community-notifications'} className='' >
        <CommunityNotificationsPage />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'accounts'} className='' >
        <AccountsPage setCurrentWallet={setCurrentWallet} setCurrentAccount={setCurrentAccount} setPage={setCurrentPage} />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'become-supporter'} className='' >
        <BecomeSupporter setCurrentPage={setCurrentPage} />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'get-spark'} className='' >
        <GetSpark setCurrentPage={setCurrentPage} />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'pay-spark'} className='' >
        <PaySpark setCurrentPage={setCurrentPage} lockModal={lockModal} />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'not-enough-spark'} className='' >
        <NotEnoughSpark goBack={() => setCurrentPage('give-spark')} />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'profile'} className='' >
        <ProfilePage />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'available-providers'} className='' >
        <AvailableProviders setPage={setCurrentPage} lockModal={lockModal} />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'email-account-accounts'} className='' >
        <EmailPage saveOnCloseMode />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'email-account-available-providers'} className='' >
        <EmailPage goBack={() => setCurrentPage('available-providers')} />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'wallet'} className='' >
        <WalletPage currentWalletId={currentWallet} goBack={() => setCurrentPage('accounts')} lockModal={lockModal} />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'external-account'} className='' >
        <ExternalAccountPage currentAccountType={currentAccount} goBack={() => setCurrentPage('accounts')} lockModal={lockModal} />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'sign-wallet'} className='' >
        <SignWalletPage setCurrentWallet={setCurrentWallet} setPage={setCurrentPage} lockModal={lockModal} />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'sign-with-universal-profile'} className='' >
        <SignWithUniversalProfile setPage={setCurrentPage}/>
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'sign-with-farcaster'} className='' >
        <SignWithFarcaster setPage={setCurrentPage}/>
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'give-spark'} className='' >
        <GiveSpark />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'pay-spark-success'} className='' >
        <PaySparkSuccess />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'how-spark-works'} className='' >
        <HowSparkWorks />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'supporter-purchase-confirm'} className='' >
        <SupporterPurchaseConfirm />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'supporter-purchase-success'} className='' >
        <SupporterPurchaseSuccess />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'passkey-settings'} className='' >
        <PasskeySettings setPage={setCurrentPage} lockModal={lockModal} closeModal={() => setIsClosed?.(true)} />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'bots'} className='' >
        <BotsPage
          setPage={setCurrentPage}
          selectBot={(bot, owner) => { setCurrentBot(bot); setCurrentBotOwner(owner); }}
        />
      </AnimatedTabPage>
      <AnimatedTabPage visible={currentPage === 'bot-editor'} className='' >
        <BotEditor
          bot={currentBot}
          owner={currentBotOwner}
          onSaved={setCurrentBot}
          setPage={setCurrentPage}
        />
      </AnimatedTabPage>
    </AnimatedTabPageContainer>;
  }, [currentAccount, currentPage, currentWallet, currentBot, currentBotOwner, lockModal, setCurrentPage, setIsClosed]);

  const className = [
    'user-setting-modal-content cg-content-stack',
    props.callMode && props.closed ? 'call-mode' : '',
    !isMobile ? 'desktop-modal' : ''  
  ].join(' ').trim();

  const style: React.CSSProperties = useMemo(() => {
    const style: React.CSSProperties = {};
    if (props.closed) {
      style.width = props.closedWidth;
      style.height = props.collapsed ? FOOTERHEIGHTCOLLAPSED : FOOTERHEIGHT;
    } else {
      style.height = currentHeight;
      if (!isMobile) style.width = DESKTOP_EXPANDED_WIDTH;
    }
    
    return style;
  }, [currentHeight, isMobile, props.closed, props.closedWidth, props.collapsed]);

  return <div className={className} style={style}>
    {!props.closed && <div className='user-setting-modal-content-top-container' ref={contentRef}>
      {title}
      <Scrollable className='grid'>
        {content}
      </Scrollable>
    </div>}
    <UserWidgetContent
      collapsed={(props.collapsed && props.closed) || false}
      onClick={() => props.setIsClosed?.(!props.closed)}
      callMode={props.callMode && props.closed}
      showProfileButton={!props.closed}
    />
  </div>
}

export default React.memo(UserSettingsModalContent);
