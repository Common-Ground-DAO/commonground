// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import './TokenManagement.css';
import { useContractData, useLoadedCommunityContext } from 'context/CommunityProvider';
import contractApi from 'data/api/contract';
import config from 'common/config';
import { ChevronDownIcon } from '@heroicons/react/20/solid';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import communityApi from 'data/api/community';
import { useManagementContentModalContext } from 'components/organisms/ManagementContentModal/ManagementContentModalContext';
import { createSearchParams, useNavigate } from 'react-router';
import Button from 'components/atoms/Button/Button';
import SettingsListItem from 'components/atoms/SettingsListItem/SettingsListItem';
import { getTruncatedId } from '../../../../util';
import { ArrowSquareOut, Info, Spinner, WarningCircle, WarningDiamond } from '@phosphor-icons/react';
import ScreenAwareDropdown from 'components/atoms/ScreenAwareDropdown/ScreenAwareDropdown';
import ExternalIcon, { ExternalIconType } from 'components/atoms/ExternalIcon/ExternalIcon';
import ListItem from 'components/atoms/ListItem/ListItem';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import ManagementHeader2 from 'components/molecules/ManagementHeader2/ManagementHeader2';
import { addressRegex, getUrl } from 'common/util';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import { useCommunityPremiumTier } from 'hooks/usePremiumTier';
import { Tooltip } from 'components/atoms/Tooltip/Tooltip';

const TokenManagement: React.FC = () => {
  const { community } = useLoadedCommunityContext();
  const { isMobile } = useWindowSizeContext();
  const [contractIds, setContractIds] = React.useState<string[]>([]);
  const contractData = useContractData(contractIds);
  const [nextOrder, setNextOrder] = React.useState<number>(0);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [isCreatingToken, setIsCreatingToken] = useState(false);

  const selectedContract = useMemo(() => {
    if (selectedTokenId) return contractData[selectedTokenId];
    return null;
  }, [contractData, selectedTokenId]);

  const { tier, tierData, canUpgradeTier } = useCommunityPremiumTier(community.premium);

  useEffect(() => {
    if (community?.tokens) {
      const maxOrder = community.tokens.reduce((max, token) => Math.max(max, token.order), 0);
      setNextOrder(maxOrder + 1000);
      setContractIds(community.tokens.map(t => t.contractId));
    }
  }, [community?.tokens]);

  if (isMobile) {
    return <TokenManagementMobile
      contractData={contractData}
      isCreatingToken={isCreatingToken}
      nextOrder={nextOrder}
      selectedContract={selectedContract}
      selectedTokenId={selectedTokenId}
      setIsCreatingToken={setIsCreatingToken}
      setSelectedTokenId={setSelectedTokenId}
      tokenLimit={tierData.TOKEN_LIMIT}
      canUpgradeTier={canUpgradeTier}
    />;
  } else {
    return <TokenManagementDesktop
      contractData={contractData}
      isCreatingToken={isCreatingToken}
      nextOrder={nextOrder}
      selectedContract={selectedContract}
      selectedTokenId={selectedTokenId}
      setIsCreatingToken={setIsCreatingToken}
      setSelectedTokenId={setSelectedTokenId}
      tokenLimit={tierData.TOKEN_LIMIT}
      canUpgradeTier={canUpgradeTier}
    />;
  }
}

const TokenManagementTokens: React.FC<{
  contractData: Record<string, Models.Contract.Data>;
  setIsCreatingToken: (isCreating: boolean) => void;
  selectedTokenId: string | null;
  setSelectedTokenId: (tokenId: string | null) => void;
  isCreatingToken: boolean;
  tokenLimit: number;
  canUpgradeTier: boolean;
}> = (props) => {
  const {
    contractData,
    setIsCreatingToken,
    selectedTokenId,
    setSelectedTokenId,
    isCreatingToken,
    tokenLimit,
    canUpgradeTier
  } = props;

  const navigate = useNavigate();
  const { community } = useLoadedCommunityContext();
  const { modalSearchParameter } = useManagementContentModalContext();
  const { isMobile } = useWindowSizeContext();
  const activeChains = React.useMemo(() => new Set(config.ACTIVE_CHAINS), []);

  const navigatePremium = useCallback(() => {
    if (isMobile) {
      navigate(getUrl({ type: 'community-settings-upgrades', community }));
    } else {
      navigate({
        search: createSearchParams({
          [modalSearchParameter]: 'premium-management'
        }).toString()
      });
    }
  }, [community, isMobile, modalSearchParameter, navigate]);

  return <div className={`flex flex-col gap-4${isMobile ? '' : ' token-management-tokens-desktop'}`}>
    <span className='cg-text-secondary cg-caption-md-600 uppercase'>Community Tokens</span>
    <span className='cg-text-md-400 cg-text-secondary'>{community.tokens.length} out of {tokenLimit} community tokens.</span>
    {!contractData && community.tokens.length > 0 && <div className='flex w-full items-center justify-center'>
      <Spinner className="spinner" />
    </div>}
    {community.tokens.length > 0 && <div className='flex flex-col gap-2'>
      {community.tokens.map(token => {
        const tokenData = contractData[token.contractId];
        if (!tokenData) return null;
        return <SettingsListItem
          key={tokenData.id}
          text={tokenData?.data?.name || 'Loading...'}
          iconLeft={tokenData?.chain && !activeChains.has(tokenData.chain) ? <span className='cg-text-error'><WarningCircle className='w-5 h-5' weight='duotone' /></span> : undefined}
          onClick={() => {
            setIsCreatingToken(false);
            setSelectedTokenId(token.contractId)
          }}
          selected={selectedTokenId === token.contractId}
        />
      })}
      {isCreatingToken && <SettingsListItem
        text='New Token'
        onClick={() => { }}
        selected
      />}
    </div>}
    {tokenLimit > community.tokens.length && <Button
      className='w-fit'
      text='New Token'
      role='secondary'
      onClick={() => {
        setIsCreatingToken(true)
        setSelectedTokenId(null);
      }}
    />}
    {tokenLimit <= community.tokens.length && <div className='token-management-limit-tip'>
      <div className='flex gap-1'>
        <Info className='w-5 h-5' weight='duotone' />
        {canUpgradeTier && <span className='flex-1'>You’ve used up {community.tokens.length}/{tokenLimit} community tokens. Please upgrade for more.</span>}
        {!canUpgradeTier && <span className='flex-1'>You’ve reached the maximum amount of community tokens! Please reach out to the CG team if you really need more 😊</span>}
      </div>
      {canUpgradeTier && <Button
        role='chip'
        className='max-w-full w-full'
        text='Upgrade'
        onClick={navigatePremium}
      />}
    </div>}
  </div>;
}

const TokenManagementEditor: React.FC<{
  contractData: Record<string, Models.Contract.Data>;
  setIsCreatingToken: (isCreating: boolean) => void;
  selectedTokenId: string | null;
  setSelectedTokenId: (tokenId: string | null) => void;
  isCreatingToken: boolean;
  tokenLimit: number;
  selectedContract: Models.Contract.Data | null;
  nextOrder: number;
}> = (props) => {
  const {
    isCreatingToken,
    tokenLimit,
    setIsCreatingToken,
    setSelectedTokenId,
    selectedContract,
    nextOrder
  } = props;

  const { community, roles } = useLoadedCommunityContext();
  const [loadingRemove, setLoadingRemove] = useState(false);
  const activeChains = React.useMemo(() => new Set(config.ACTIVE_CHAINS), []);

  const roleUserCount = useAsyncMemo(async () => {
    const result = await communityApi.getMemberList({ communityId: community.id, limit: 1, offset: 0 });
    return result.roles;
  }, []);

  const rolesUsingContract = useMemo(() => roles.filter(r =>
    r.assignmentRules?.type === 'token' &&
    (r.assignmentRules.rules.rule1.contractId === selectedContract?.id ||
      ('rule2' in r.assignmentRules.rules && r.assignmentRules.rules.rule2.contractId === selectedContract?.id)
    )
  ), [roles, selectedContract?.id]);

  const removeToken = useCallback(async () => {
    let confirmed = true;
    const roleTitles = rolesUsingContract.map(role => role.title);
    if (roleTitles.length > 0) {
      confirmed = await window.confirm(`This will turn role(s) ${roleTitles.map(rt => `"${rt}"`).join(', ')} into manually claimed roles. Users who already have the role will keep it. Continue?`);
    }
    if (selectedContract && confirmed) {
      try {
        setLoadingRemove(true);
        await communityApi.removeCommunityToken({ contractId: selectedContract.id, communityId: community.id });
      }
      finally {
        setLoadingRemove(false);
      }
    }
  }, [rolesUsingContract, selectedContract, community.id]);

  return <div className='flex-1'>
    {isCreatingToken && <div className='flex flex-col cg-bg-subtle cg-border-l p-4 gap-4 flex-1 h-fit'>
      <FindToken
        communityId={community?.id}
        order={nextOrder}
        tokenLimitReached={(community.tokens?.length || 0) >= tokenLimit}
        onDiscard={() => setIsCreatingToken(false)}
        onSuccess={(tokenId) => {
          setIsCreatingToken(false);
          setSelectedTokenId(tokenId);
        }}
      />
    </div>}
    {selectedContract && <div className='flex flex-col cg-bg-subtle cg-border-l p-4 gap-4 flex-1'>
      <h3>{selectedContract.data.name}</h3>
      <div className='flex flex-wrap gap-2'>
        <div className='cg-bg-subtle flex gap-2 items-center p-2 cg-border-l'>
          {!activeChains.has(selectedContract.chain) && <Tooltip
            placement="top"
            offset={6}
            triggerContent={
              <span className='cg-text-error'><WarningCircle className='w-5 h-5' weight='duotone' /></span>
            }
            tooltipContent={<span>This chain is inactive. Roles with this token are not claimable anymore.</span>}
          />}
          <span className='cg-text-secondary'>Chain</span>
          <span className='cg-text-lg-500'>{config.AVAILABLE_CHAINS[selectedContract.chain].title}</span>
        </div>
        <div className='cg-bg-subtle flex gap-2 items-center p-2 cg-border-l'>
          <span className='cg-text-secondary'>Identifier</span>
          <span className='cg-text-lg-500'>{selectedContract.data.symbol}</span>
        </div>
        <div className='cg-bg-subtle flex gap-2 items-center p-2 cg-border-l'>
          <span className='cg-text-secondary'>Type</span>
          <span className='cg-text-lg-500'>{selectedContract.data.type}</span>
        </div>
        <div className='cg-bg-subtle flex gap-2 items-center p-2 cg-border-l'>
          <span className='cg-text-secondary'>Address</span>
          <span className='cg-text-lg-500'>{getTruncatedId(selectedContract.address)}</span>
          <a href={config.AVAILABLE_CHAINS[selectedContract.chain].link(selectedContract.address)} target="_blank" rel="noreferrer"><ArrowSquareOut className='w-5 h-5' weight='duotone' /></a>
        </div>
      </div>
      <div className='cg-separator w-full' />
      {rolesUsingContract.length > 0 && <>
        <span className='cg-text-secondary'>Connected Roles</span>
        <div className='flex flex-wrap gap-2'>
          {rolesUsingContract.map(r => <div className='cg-bg-subtle flex gap-2 items-center p-2 cg-border-l' key={r.id}>
            <span className='cg-text-secondary'>{roleUserCount?.find(([roleId,]) => r.id === roleId)?.[1] ?? '...'}</span>
            <span className='cg-text-lg-500'>{r.title}</span>
          </div>)}
        </div>
      </>}
      <Button
        className='w-fit'
        role='destructive'
        text='Remove token'
        onClick={removeToken}
        loading={loadingRemove}
      />
    </div>}
  </div>;
}

type TokenManagementProps = {
  contractData: Record<string, Models.Contract.Data>;
  setIsCreatingToken: (isCreating: boolean) => void;
  selectedTokenId: string | null;
  setSelectedTokenId: (tokenId: string | null) => void;
  isCreatingToken: boolean;
  tokenLimit: number;
  selectedContract: Models.Contract.Data | null;
  nextOrder: number;
  canUpgradeTier: boolean;
};

const TokenManagementMobile: React.FC<TokenManagementProps> = (props) => {
  const { setIsCreatingToken, setSelectedTokenId } = props;
  const navigate = useNavigate();
  const { community } = useLoadedCommunityContext();

  const isPickerScreen = !props.isCreatingToken && !props.selectedContract;

  const goBack = useCallback(() => {
    if (!isPickerScreen) {
      setIsCreatingToken(false);
      setSelectedTokenId(null);
    } else {
      navigate(getUrl({ type: 'community-settings', community }));
    }
  }, [community, isPickerScreen, navigate, setIsCreatingToken, setSelectedTokenId]);

  return <div className='flex flex-col cg-text-main cg-text-lg-400'>
    <ManagementHeader2
      title={props.isCreatingToken ? 'New Token' : props.selectedContract?.data?.name || 'Token'}
      help='The easiest way to create and distribute Tokens to your community. Create one token for free, upgrade for more. Use Tokens for access control: set it as a requirement to claim a Role, then give access to chats, content and permissions for that Role. Learn more about using community tokens.'
      goBack={goBack}
    />
    <Scrollable>
      <div className='p-4'>
        {isPickerScreen ? <TokenManagementTokens
          {...props}
        /> : <TokenManagementEditor
          {...props}
        />}
      </div>
    </Scrollable>
  </div>;
};

const TokenManagementDesktop: React.FC<TokenManagementProps> = (props) => {
  return (<div className='cg-text-main cg-text-lg-400'>
    <div className='flex flex-col gap-4'>
      <ManagementHeader2
        title='Token'
        help='The easiest way to create and distribute Tokens to your community. Create one token for free, upgrade for more. Use Tokens for access control: set it as a requirement to claim a Role, then give access to chats, content and permissions for that Role. Learn more about using community tokens.'
      />

      <div className='flex gap-4'>
        <TokenManagementTokens
          {...props}
        />
        <TokenManagementEditor
          {...props}
        />
      </div>
    </div>
  </div>);
};

const FindToken: React.FC<{
  communityId: string;
  order: number;
  tokenLimitReached: boolean;
  onDiscard: () => void;
  onSuccess: (tokenId: string) => void;
}> = ({
  communityId,
  order,
  tokenLimitReached,
  onDiscard,
  onSuccess
}) => {
    const [address, setAddress] = React.useState<Common.Address | undefined>(undefined);
    const [chain, setChain] = React.useState<Models.Contract.ChainIdentifier | undefined>();
    const [contractData, setContractData] = React.useState<Models.Contract.Data | undefined>(undefined);
    const [isLoading, setIsLoading] = React.useState<boolean>(false);
    const [error, setError] = React.useState<string | undefined>();
    const selectedChain = chain ? config.AVAILABLE_CHAINS[chain] : null;
    const activeChains = React.useMemo(() => new Set(config.ACTIVE_CHAINS), []);

    useEffect(() => {
      if (!!address && !!chain) {
        const cleanedAddress = address.trim();
        if (cleanedAddress.match(addressRegex) !== null) {
          if (cleanedAddress !== address) {
            setAddress(cleanedAddress as Common.Address);
          }
          else {
            setError(undefined);
            contractApi.getContractData({
              address: address.toLowerCase() as Common.Address,
              chain,
            })
            .then(setContractData)
            .catch(() => {
              setContractData(undefined);
              setError("Contract could not be found");
            });
          }
        }
        else {
          setError("Invalid address");
        }
      }
      else {
        setContractData(undefined);
      }
    }, [address, chain]);

    const addToken = useCallback(async () => {
      if (!!contractData?.id) {
        try {
          setIsLoading(true);
          await communityApi.addCommunityToken({ contractId: contractData.id, communityId, order });
          onSuccess(contractData.id);
          setAddress(undefined);
          setChain(undefined);
        }
        finally {
          setIsLoading(false);
        }
      }
    }, [contractData?.id, communityId, order, onSuccess]);

    return (<div className='flex flex-col gap-4'>
      <div className='flex flex-col gap-2 relative'>
        <label className='cg-text-lg-500'>Chain</label>
        <ScreenAwareDropdown
          triggerContent={<Button
            className='w-full max-w-full justify-between'
            style={{ maxWidth: '100%' }}
            role='secondary'
            text={<div className='flex items-center gap-4'>
              {!!selectedChain && <ExternalIcon type={(selectedChain?.title.toLocaleLowerCase() || '') as ExternalIconType} className='w-5 h-5' />}
              <span>{selectedChain?.title || 'Select'}</span>
            </div>}
            iconRight={<ChevronDownIcon className='cg-text-secondary w-5 h-5' />}
          />}
          triggerClassname='w-full'
          className='token-management-tooltip w-full'
          items={Object.entries(config.AVAILABLE_CHAINS).filter(([chain]) => activeChains.has(chain as Models.Contract.ChainIdentifier)).map(([chain, chainData]) => <ListItem
            propagateEventsOnClick
            key={chain}
            className='w-full'
            title={chainData.title}
            icon={<ExternalIcon type={(chainData.title.toLocaleLowerCase() || '') as ExternalIconType} className='w-5 h-5' />}
            onClick={() => {
              setChain(chain as Models.Contract.ChainIdentifier);
              setAddress(undefined);
            }}
          />)}
        />
      </div>
      <TextInputField
        value={address || ''}
        onChange={address => setAddress(address as Common.Address)}
        label="Token contract"
        placeholder="0x..."
        error={error}
      />

      {contractData && <div className='flex flex-wrap gap-2'>
        <div className='cg-bg-subtle flex gap-2 items-center p-2 cg-border-l'>
          <span className='cg-text-secondary'>Token Name</span>
          <span className='cg-text-lg-500'>{contractData.data.name}</span>
        </div>
        <div className='cg-bg-subtle flex gap-2 items-center p-2 cg-border-l'>
          <span className='cg-text-secondary'>Identifier</span>
          <span className='cg-text-lg-500'>{contractData.data.symbol}</span>
        </div>
        <div className='cg-bg-subtle flex gap-2 items-center p-2 cg-border-l'>
          <span className='cg-text-secondary'>Type</span>
          <span className='cg-text-lg-500'>{contractData.data.type}</span>
        </div>
      </div>}

      <div className='flex gap-4'>
        <Button
          role='secondary'
          className='flex-1'
          text='Discard'
          onClick={onDiscard}
        />
        <Button
          role='primary'
          className='flex-1'
          text='Save token'
          onClick={addToken}
          loading={isLoading}
          disabled={tokenLimitReached}
        />
      </div>
    </div>);
  }

export default React.memo(TokenManagement);