// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import ConnectionStatusIndicator from './components/molecules/ConnectionStatusIndicator/ConnectionStatusIndicator';
import { CommunityProvider } from './context/CommunityProvider';
import { ProfileProvider } from './context/ProfileProvider';
import { CommunitySidebarProvider } from './components/organisms/CommunityViewSidebar/CommunityViewSidebarContext';
import { CopiedToClipboardDialogProvider } from './context/CopiedToClipboardDialogContext';
import { LoginWithKeyphraseProvider } from './context/LoginWithKeyphraseProvider';
import MobileLayout, { MobileLayoutProvider } from './views/Layout/MobileLayout';
import { NotificationProvider } from './context/NotificationProvider';
import { OwnDataProvider } from './context/OwnDataProvider';
import { UserOnboardingProvider } from './context/UserOnboarding';
import { CreateCommunityModalProvider } from './context/CreateCommunityModalProvider';
import { WindowSizeProvider, useWindowSizeContext } from './context/WindowSizeProvider';
import { useConnectionContext } from './context/ConnectionProvider';
import dayjs from 'dayjs';
import isToday from 'dayjs/plugin/isToday';
import isYesterday from 'dayjs/plugin/isYesterday';
import isTomorrow from 'dayjs/plugin/isTomorrow';
import advancedFormat from 'dayjs/plugin/advancedFormat';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

import './index.css';
import './App.css';
import { DarkModeProvider, useDarkModeContext } from 'context/DarkModeProvider';

import '@rainbow-me/rainbowkit/styles.css';
import {
  getDefaultConfig,
  RainbowKitProvider,
  darkTheme,
  lightTheme,
} from '@rainbow-me/rainbowkit';
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  safeWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fallback, http, type Chain } from 'viem';
import {
  mainnet,
  polygon,
  optimism,
  arbitrum,
  gnosis,
  bsc,
  fantom,
  avalanche,
  zkSync,
  hardhat,
  base,
} from 'wagmi/chains';
import config from 'common/config';
import CommunityRouter from 'views/CommunityRouter/CommunityRouter';
import ProfileRouter from 'views/ProfileRouter/ProfileRouter';
import { CallProvider } from 'context/CallProvider';
import { CallDevicesProvider } from 'context/CallDevicesProvider';
import DesktopLayout from 'views/Layout/DesktopLayout';
import TabletLayout from 'views/Layout/TabletLayout';
import { SnackbarContextProvider } from 'context/SnackbarContext';
import { getUrl } from 'common/util';
import { SidebarDataDisplayProvider } from 'context/SidebarDataDisplayProvider';
import { UniversalProfileProvider } from 'context/UniversalProfileProvider';
import { TwitterLoginProvider } from 'context/TwitterLoginProvider';
import { CommunityModerationProvider } from 'context/CommunityModerationContext';
import { CaptchaContextProvider } from 'context/CaptchaContext';
import { ExternalModalProvider } from 'context/ExternalModalProvider';
import { RoleClaimedProvider } from 'context/RoleClaimedProvider';
import { UserSettingsProvider } from 'context/UserSettingsProvider';
import { CommunityJoinedProvider } from 'context/CommunityJoinedProvider';
import { UserOnchainProvider } from 'context/UserOnchainProvider';
import { CommunityListViewProvider } from 'context/CommunityListViewProvider';
import { CommunityOnboardingProvider } from 'context/CommunityOnboardingProvider';
import { PasskeyProvider } from 'context/PasskeyProvider';
import { EmailConfirmationProvider } from 'context/EmailConfirmationProvider';
import { PluginIframeProvider } from 'context/PluginIframeProvider';
import "@farcaster/auth-kit/styles.css";
import { AuthKitProvider } from "@farcaster/auth-kit";
import UserInfoManager from 'components/atoms/UserInfoManager/UserInfoManager';
import { PluginDetailsModalProvider } from 'context/PluginDetailsModalProvider';
import { IsolationModeProvider } from 'context/IsolationModeProvider';
import { ReportModalProvider } from 'context/ReportModalProvider';

dayjs.extend(utc);
dayjs.extend(isToday);
dayjs.extend(isTomorrow);
dayjs.extend(isYesterday);
dayjs.extend(timezone);
dayjs.extend(advancedFormat);

// const AreaChannelManagementView = React.lazy(() => import('views/AreaChannelManagementView/AreaChannelManagementView'));
// const ArticleView = React.lazy(() => import('views/ArticleView/ArticleView'));
// const BlogView = React.lazy(() => import('views/BlogView/BlogView'));
const CgUpdate = React.lazy(() => import('./views/CgUpdate/CgUpdate'));
// const CommunityView = React.lazy(() => import('views/CommunityView/CommunityView'));
// const CommunityManagementView = React.lazy(() => import('views/CommunityManagementView/CommunityManagementView'));
const ContentBrowser = React.lazy(() => import('views/ContentBrowser/ContentBrowser'));
const ConversationsBrowser = React.lazy(() => import('views/ConversationsBrowser/ConversationsBrowser'));
// const CreateArticleView = React.lazy(() => import('views/CreateArticleView/CreateArticleView'));
const CreateUserPostView = React.lazy(() => import('views/CreateUserPostView/CreateUserPostView'));
// const EditArticleView = React.lazy(() => import('views/EditArticleView/EditArticleView'));
// const EditBlogView = React.lazy(() => import('views/EditBlogView/EditBlogView'));
const Home = React.lazy(() => import('./views/Home/Home'));
const TokenSale = React.lazy(() => import('./views/TokenSale/TokenSale'));
const TokenSaleRedirect = React.lazy(() => import('./views/TokenSale/TokenSaleRedirect'));
const LearnMore = React.lazy(() => import('./views/LearnMore/LearnMore'));
// const MemberManagementView = React.lazy(() => import('views/MemberManagementView/MemberManagementView'));
const ChatView = React.lazy(() => import('./views/ChatView/ChatView'));
const NotificationsBrowser = React.lazy(() => import('views/NotificationsBrowser/NotificationsBrowser'));
const AudioDevicesManagementView = React.lazy(() => import('views/AudioDevicesManagementView/AudioDevicesManagementView'));
const ProfileManagementView = React.lazy(() => import('views/ProfileManagementView/ProfileManagementView'));
const WalletManagementView = React.lazy(() => import('views/WalletManagementView/WalletManagementView'));
const TwitterCallbackView = React.lazy(() => import('views/TwitterCallbackView/TwitterCallbackView'));
const VerifyEmailView = React.lazy(() => import('views/VerifyEmailView/VerifyEmailView'));
const IsolationModeToggle = React.lazy(() => import('views/IsolationModeToggle/IsolationModeToggle'));

const activeChains = (config.DEPLOYMENT === 'dev'
  ? [mainnet, polygon, optimism, arbitrum, gnosis, bsc, fantom, avalanche, zkSync, base, hardhat]
  : [mainnet, polygon, optimism, arbitrum, gnosis, bsc, fantom, avalanche, zkSync, base]
) as unknown as readonly [Chain, ...Chain[]];

// self-hosted instances (identified by an injected instance config) can't use
// CG's domain-locked Alchemy key — their requests fail CORS. They use each
// chain's default public RPC instead; operators can front their own RPCs.
const isSelfHosted = !!(window as any).__CG_INSTANCE__;

// Keyless RPCs matching the backend defaults (docker/selfhost/init.sh, keyed
// by numeric chain id). viem's built-in public RPCs (e.g. cloudflare-eth.com
// for mainnet) are too flaky for balance reads and transaction simulation —
// they intermittently answer "Internal error", which made wallet actions
// fail silently on self-hosted instances.
const selfhostRpcByChainId: Record<number, string> = {
  1: 'https://eth.drpc.org',
  137: 'https://polygon.drpc.org',
  100: 'https://rpc.gnosischain.com',
  42161: 'https://arb1.arbitrum.io/rpc',
  8453: 'https://mainnet.base.org',
  42: 'https://rpc.mainnet.lukso.network',
};

// wagmi 2 has no provider chain — `configureChains` is gone and each chain gets
// its own transport. This table reproduces what wagmi 1's `alchemyProvider()`
// resolved to: it only handled chains whose viem-1 definition carried an
// `rpcUrls.alchemy` entry (exactly these five), and every other chain fell
// through to `publicProvider()`. viem 2 dropped those per-chain alchemy URLs,
// so they are spelled out here.
const ALCHEMY_API_KEY = '_sIiYKLDy9V9dQChacf2G5Nz7mxxghqZ';
const alchemyRpcByChainId: Record<number, string> = {
  [mainnet.id]: 'https://eth-mainnet.g.alchemy.com/v2',
  [polygon.id]: 'https://polygon-mainnet.g.alchemy.com/v2',
  [optimism.id]: 'https://opt-mainnet.g.alchemy.com/v2',
  [arbitrum.id]: 'https://arb-mainnet.g.alchemy.com/v2',
  [base.id]: 'https://base-mainnet.g.alchemy.com/v2',
};

// `fallback([preferred, http()])` is wagmi 1's provider-list semantics: try the
// configured endpoint, fall back to the chain's default public RPC.
const transports = Object.fromEntries(activeChains.map((chain) => {
  const preferred = isSelfHosted
    ? selfhostRpcByChainId[chain.id]
    : (alchemyRpcByChainId[chain.id] && `${alchemyRpcByChainId[chain.id]}/${ALCHEMY_API_KEY}`);
  return [chain.id, preferred ? fallback([http(preferred), http()]) : http()];
}));

const wagmiConfig = getDefaultConfig({
  appName: 'Common Ground',
  // WalletConnect Cloud project ids are origin-allowlisted upstream, so
  // self-hosted instances configure their own (CG_WALLETCONNECT_PROJECT_ID)
  projectId: config.WALLETCONNECT_PROJECT_ID,
  chains: activeChains,
  transports,
  // Spelled out rather than left to RainbowKit 2's default set, which differs
  // from RainbowKit 1's: it drops Coinbase Wallet (replacing it with Base
  // Account) and the generic injected/Brave entries. This list is the wallets
  // RainbowKit 1's `getDefaultWallets` offered. Brave and other extensions
  // still surface through wagmi's EIP-6963 discovery.
  wallets: [{
    groupName: 'Recommended',
    wallets: [
      injectedWallet,
      safeWallet,
      rainbowWallet,
      coinbaseWallet,
      metaMaskWallet,
      walletConnectWallet,
    ],
  }],
});

const queryClient = new QueryClient();

export function removeInitialSlash(value: string) {
  if (value[0] === "/") {
    return value.slice(1);
  }
  return value;
}

const farcasterConfig = {
  // For a production app, replace this with an Optimism Mainnet
  // RPC URL from a provider like Alchemy or Infura.
  rpcUrl: "https://mainnet.optimism.io",
  domain: window.location.hostname,
  siweUri: window.location.href,
  relay: 'https://relay.farcaster.xyz',
};

const RoutedContent = () => {
  const { isMobile, isTablet } = useWindowSizeContext();

  const routesWithLayout = useMemo(() => {
    const routes = <Routes>
      <Route path={'/token-sale'} element={<TokenSaleRedirect />} />
      <Route path={removeInitialSlash(getUrl({ type: 'token' }))} element={<TokenSale />} />
      {/* Legacy ecosystem URLs (removed 2026-08-01) — send them home. Reachable one
          segment deep only: nginx's SPA fallback matches `e/[^/]+`. */}
      <Route path="e/*" element={<Navigate to="/" replace />} />
      <Route path={removeInitialSlash(getUrl({ type: 'feed' }))} element={<ContentBrowser />} />
      <Route path={`${config.URL_COMMUNITY}/:communityUrl/*`} element={
        <CommunityRouter />
      } />
      <Route path={`${config.URL_USER}/:idOrUrl/*`} element={
        <ProfileProvider>
          <ProfileRouter />
        </ProfileProvider>
      } />
      <Route path={removeInitialSlash(getUrl({ type: 'chats' }))} element={<ConversationsBrowser />} />
      <Route path={removeInitialSlash(getUrl({ type: 'notifications' }))} element={<NotificationsBrowser />} />
      <Route path={`${removeInitialSlash(getUrl({ type: 'notifications' }))}:notificationShortUuid/`} element={<NotificationsBrowser />} />
      <Route path="learn-more" element={<LearnMore />} />
      <Route path={`${config.URL_CHATS}/:chatShortUuid/`} element={<ChatView />} />
      <Route path={removeInitialSlash(getUrl({ type: 'profile-settings' }))} element={<ProfileManagementView />} />
      <Route path={removeInitialSlash(getUrl({ type: 'profile-settings-account-and-wallets' }))} element={<WalletManagementView />} />
      <Route path={removeInitialSlash(getUrl({ type: 'profile-settings-calls' }))} element={<AudioDevicesManagementView />} />
      <Route path="create-user-post" element={<CreateUserPostView />} />
      <Route path="enable-cross-origin-security" element={<IsolationModeToggle mode="enable" />} />
      <Route path="disable-cross-origin-security" element={<IsolationModeToggle mode="disable" />} />
      <Route path="*" element={<Home />} />
      {/* <Route path="*" element={<div>Not found</div>} /> */}
    </Routes>;

    if (isMobile) {
      return <MobileLayout>
        {routes}
      </MobileLayout>
    } else if (isTablet) {
      return <TabletLayout>
        {routes}
      </TabletLayout>
    } else {
      return <DesktopLayout>
        {routes}
      </DesktopLayout>
    }
  }, [isMobile, isTablet]);

return <Routes>
  <Route path={'twitter-login'} element={<TwitterCallbackView />} />
  <Route path={'verify-email'} element={<VerifyEmailView />} />
  <Route path="*" element={routesWithLayout} />
</Routes>
}

function Inner() {
  const mode = useDarkModeContext();

  return (
    <>
      <IsolationModeProvider>
      <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
      <RainbowKitProvider
        theme={mode.isDarkMode ? darkTheme() : lightTheme()}
        modalSize='compact'
        // appInfo={{learnMoreUrl: 'https://app.cg'}} // define our own learn more url
      >
      <AuthKitProvider config={farcasterConfig}>
      <WindowSizeProvider>
      <SnackbarContextProvider>
      <OwnDataProvider>
      <PasskeyProvider>
      <MobileLayoutProvider>
      <NotificationProvider>
      <CommunitySidebarProvider>
      <ExternalModalProvider>
      <UserOnboardingProvider>
      <CreateCommunityModalProvider>
      <LoginWithKeyphraseProvider>
      <CopiedToClipboardDialogProvider>
      <CallDevicesProvider>
      <CallProvider>
      <CommunityProvider>
      <CommunityListViewProvider>
      <UserSettingsProvider>
      <CommunityModerationProvider>
      <ReportModalProvider>
      <SidebarDataDisplayProvider>
      <PluginDetailsModalProvider>
      <UniversalProfileProvider>
      <TwitterLoginProvider>
      <RoleClaimedProvider>
      <EmailConfirmationProvider>
      <CommunityJoinedProvider>
      <CommunityOnboardingProvider>
      <CaptchaContextProvider>
      <UserOnchainProvider>
      <PluginIframeProvider>
        <UserInfoManager />
        <ConnectionStatusIndicator />
        <RoutedContent />
      </PluginIframeProvider>
      </UserOnchainProvider>
      </CaptchaContextProvider>
      </CommunityOnboardingProvider>
      </CommunityJoinedProvider>
      </EmailConfirmationProvider>
      </RoleClaimedProvider>
      </TwitterLoginProvider>
      </UniversalProfileProvider>
      </PluginDetailsModalProvider>
      </SidebarDataDisplayProvider>
      </ReportModalProvider>
      </CommunityModerationProvider>
      </UserSettingsProvider>
      </CommunityListViewProvider>
      </CommunityProvider>
      </CallProvider>
      </CallDevicesProvider>
      </CopiedToClipboardDialogProvider>
      </LoginWithKeyphraseProvider>
      </CreateCommunityModalProvider>
      </UserOnboardingProvider>
      </ExternalModalProvider>
      </CommunitySidebarProvider>
      </NotificationProvider>
      </MobileLayoutProvider>
      </PasskeyProvider>
      </OwnDataProvider>
      </SnackbarContextProvider>
      </WindowSizeProvider>
      </AuthKitProvider>
      </RainbowKitProvider>
      </QueryClientProvider>
      </WagmiProvider>
      </IsolationModeProvider>
    </>
  );
}

function App() {
  const { showReleaseNotes } = useConnectionContext();

  let content: JSX.Element;
  if (showReleaseNotes === true) {
    content = (
      <CgUpdate view="releaseNotes" />
    );
  } else {
    content = (
      <DarkModeProvider>
        <Inner />
      </DarkModeProvider>
    );
  }

  return content;
}

export default App;
