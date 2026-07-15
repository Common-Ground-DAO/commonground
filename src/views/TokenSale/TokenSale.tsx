// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import './TokenSale.css';
import { CheckCircle, Coins, HandCoins, Spinner, TipJar } from "@phosphor-icons/react";
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import { useOwnUser } from 'context/OwnDataProvider';
import Button from 'components/atoms/Button/Button';
import userApi from 'data/api/user';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import cgTokensale_v1_abi from '../../common/tokensale/cgTokensale_v1_abi';
import { useContractWrite, usePrepareContractWrite } from 'wagmi';
import { ethers, providers } from 'ethers';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { useAccount, useNetwork, useSwitchNetwork } from 'wagmi';
import { chainIds } from 'common/chainIds';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import errors from 'common/errors';
import SaleGraph from './Charts/SaleGraph';
import UserTooltip from 'components/organisms/UserTooltip/UserTooltip';
import Jdenticon from 'components/atoms/Jdenticon/Jdenticon';
import { useMultipleUserData } from 'context/UserDataProvider';
import { getDisplayName } from '../../util';
import dayjs from 'dayjs';
import { useSnackbarContext } from 'context/SnackbarContext';
import TokenSaleInfo from './Info/TokenSaleInfo';
import { useUserOnboardingContext } from 'context/UserOnboarding';
import { useSidebarDataDisplayContext } from 'context/SidebarDataDisplayProvider';
import CoinsIcon from './icons/coins.png';
import TokenNetIcon from './icons/token-net.png';
import { ReactComponent as USFlag } from './icons/us-flag.svg';

import urlConfig from '../../data/util/urls';
import shortUUID from 'short-uuid';
import useLocalStorage from 'hooks/useLocalStorage';
import { useSearchParams, useLocation } from 'react-router-dom';
import { Decimal, formatNumberRemoveTrailingZeros, getExactTokenAmount, priceFn, shortenMillBillNumber } from '../../common/tokensale/helper';
import { useWindowSizeContext } from 'context/WindowSizeProvider';

import { ReactComponent as EthereumIcon } from 'components/atoms/icons/24/Ethereum.svg';
import { useDarkModeContext } from 'context/DarkModeProvider';
import { ArrowRightIcon } from '@heroicons/react/20/solid';
import config from 'common/config';
import { validateAddress } from 'common/validators';
import CommunityPhoto from 'components/atoms/CommunityPhoto/CommunityPhoto';
import { useMultipleCommunityListViews } from 'context/CommunityListViewProvider';
import OngoingAirdrops from './TokenAirdrops/OngoingAirdrops';
import FinishedAirdrops from './TokenAirdrops/FinishedAirdrops';
import communityApi from 'data/api/community';
import BuyTokenHeader from 'components/molecules/BuyTokenHeader/BuyTokenHeader';
import SparkFireBg from 'components/organisms/UserSettingsModalContent/HowSparkWorks/SparkFireBg';
import StakeTab from './StakeTab/StakeTab';
import { ReactComponent as SparkIcon } from 'components/atoms/icons/misc/spark.svg';
import ExternalIcon from 'components/atoms/ExternalIcon/ExternalIcon';
import SimpleLink from 'components/atoms/SimpleLink/SimpleLink';

const t = shortUUID();

export const tokenSaleId = '5457dbed-9ba4-4ad0-8be5-bc974fd20215';
const learnMoreLink = 'https://app.cg/c/commonground/article/introducing-spark---upgrade-your-community-%26-support-common-ground-svnJ15teLA9JxAxCC8yafT';

export function calculateAgeString(date: Date) {
    let _date = dayjs(date);
    const now = dayjs();
    const sameYear = now.year() === _date.year();

    if (_date.isAfter(now)) {
        _date = now;
    }

    if (now.diff(_date, 'days') >= 7) {
        const sameYear = now.year() === _date.year();
        return _date.format(sameYear ? 'MMM DD' : 'MMM DD, YYYY');
    }
    const diffDays = now.diff(_date, 'days');
    const diffHours = now.diff(_date, 'hours');
    const diffMinutes = now.diff(_date, 'minutes');

    if (diffDays > 0) return `${diffDays}d ago`;
    if (diffHours > 0) return `${diffHours}h ago`;
    if (diffMinutes > 0) return `${diffMinutes}m ago`;

    return `<1m ago`;
}

export function calculateTimeUntil(date: dayjs.Dayjs) {
    const now = dayjs();
    if (date.isBefore(now)) {
        return 'Now';
    }

    const fullDiffSeconds = date.diff(now, 'seconds');
    const diffSeconds = fullDiffSeconds % 60;
    const diffMinutes = Math.floor(fullDiffSeconds / 60) % 60;
    const diffHours = Math.floor(fullDiffSeconds / 60 / 60) % 24;
    const diffDays = Math.floor(fullDiffSeconds / 60 / 60 / 24);

    return `${diffDays}d ${diffHours.toString().padStart(2, '0')}h ${diffMinutes.toString().padStart(2, '0')}m ${diffSeconds.toString().padStart(2, '0')}s`;
}

export const SALE_START_DATE = '2024-12-11T18:00:00+01:00';
export const SALE_END_DATE = '2024-12-30T18:00:00+01:00';

const TokenSale: React.FC = () => {
    const ownUser = useOwnUser();
    // Get (buy) and Earn (claim) are hidden for now — staking is the current
    // focus. Flip this to bring them back; their code paths stay intact.
    const SHOW_GET_EARN_TABS = false;
    const [currentTab, setCurrentTab] = useState<'buy' | 'claim' | 'stake'>(SHOW_GET_EARN_TABS ? 'buy' : 'stake');
    const [error, setError] = useState<string>('');
    const [amount, _setAmount] = useState<string>('1');
    const { address: walletAddress } = useAccount();
    const { isMobile } = useWindowSizeContext();
    const { chain } = useNetwork();
    const { switchNetworkAsync } = useSwitchNetwork();
    const { showSnackbar } = useSnackbarContext();
    const { openConnectModal } = useConnectModal();
    const { setUserOnboardingVisibility, isUserOnboardingVisible } = useUserOnboardingContext();
    const { showTooltip } = useSidebarDataDisplayContext();
    const [tokenSaleReferralData, setTokenSaleReferralData] = useLocalStorage<{ [tokenSaleId: string]: string }>({}, 'tokenSaleReferralData');
    const [searchParams, setSearchParams] = useSearchParams();
    const [tokenSaleData, setTokenSaleData] = useState<Models.TokenSale.SaleData | null>(null);
    const [userSaleData, setUserSaleData] = useState<Models.TokenSale.UserSaleData | null>(null);
    const [walletAddressToClaim, setWalletAddressToClaim] = useState<string | null>(null);
    const [walletAddressSaved, setWalletAddressSaved] = useState<boolean>(false);
    const [email, setEmail] = useState<string>(ownUser?.email || '');
    const { isDarkMode } = useDarkModeContext();

    const saleStartDate = useMemo(() => dayjs(tokenSaleData?.startDate || SALE_START_DATE), [tokenSaleData?.startDate]);
    const saleEndDate = useMemo(() => dayjs(tokenSaleData?.endDate || SALE_END_DATE), [tokenSaleData?.endDate]);
    const [saleHasStarted, setSaleHasStarted] = useState<boolean>(saleStartDate.isBefore(dayjs()));
    const [saleHasEnded, setSaleHasEnded] = useState<boolean>(saleEndDate.isBefore(dayjs()));
    const [timeForSaleStart, setTimeForSaleStart] = useState<string>('');
    const location = useLocation();
    const whatIsThisRef = useRef<HTMLDivElement>(null);
    const [whatIsThisState, setWhatIsThisState] = useState<'collapsed' | 'collapsed desc-grad' | 'expanded'>('collapsed desc-grad');
    const [showContractError, setShowContractError] = useState<boolean>(false);
    const [ongoingAirdrops, setOngoingAirdrops] = useState<API.Community.getAirdropCommunities.Response>([]);
    const [finishedAirdrops, setFinishedAirdrops] = useState<API.Community.getAirdropCommunities.Response>([]);

    useEffect(() => {
        const fetchData = async () => {
            const ongoingResult = await communityApi.getAirdropCommunities({ status: 'ongoing' });
            const finishedResult = await communityApi.getAirdropCommunities({ status: 'finished' });
            setOngoingAirdrops(ongoingResult);
            setFinishedAirdrops(finishedResult);
        };
        fetchData();
    }, []);

    const communityIds = useMemo(() => {
        return userSaleData?.rewardProgram?.communityAirdropRewards?.map(reward => reward.communityId) || [];
    }, [userSaleData?.rewardProgram?.communityAirdropRewards]);
    const communityListViews = useMultipleCommunityListViews(communityIds);

    const saleIsOngoing = saleHasStarted && !saleHasEnded;

    useEffect(() => {
        let interval: NodeJS.Timeout;
        const refreshTimeUntil = () => {
            const timeUntil = calculateTimeUntil(dayjs(saleStartDate));
            setTimeForSaleStart(old => {
                if (timeUntil === 'Now') {
                    setSaleHasStarted(true);
                }
                return timeUntil;
            });

            const hasEnded = saleEndDate.isBefore(dayjs());
            if (hasEnded) {
                setSaleHasEnded(hasEnded);
            }

            if (timeUntil === 'Now' && hasEnded) {
                clearInterval(interval);
            }
        }

        refreshTimeUntil();
        interval = setInterval(refreshTimeUntil, 1_000);
        return () => clearInterval(interval);
    }, [saleStartDate, saleEndDate]);

    useEffect(() => {
        if (location.hash.includes('#feature-previews')) {
            const el = document.getElementById('feature-previews');
            if (el) {
                el.scrollIntoView({ behavior: 'instant' as any });
            }
        }
        else if (location.hash.includes('#token-distribution')) {
            const el = document.getElementById('token-distribution');
            if (el) {
                el.scrollIntoView({ behavior: 'instant' as any });
            }
        }
        else if (location.hash.includes('#our-investors')) {
            const el = document.getElementById('our-investors');
            if (el) {
                el.scrollIntoView({ behavior: 'instant' as any });
            }
        }
        else if (location.hash.includes('#token-offer')) {
            const el = document.getElementById('token-offer');
            if (el) {
                el.scrollIntoView({ behavior: 'instant' as any });
            }
        }
    }, [location.hash]);

    useEffect(() => {
        setEmail(ownUser?.email || '');
    }, [ownUser?.email]);

    const chainId = useMemo(() => {
        if (!tokenSaleData?.saleContractChain) {
            return undefined;
        }
        return chainIds[tokenSaleData?.saleContractChain];
    }, [tokenSaleData?.saleContractChain]);

    const isAllowedNetwork = useMemo(() => chain?.id === chainId && chainId !== undefined, [chain, chainId]);

    const [events, setEvents] = useState<Models.Contract.SaleInvestmentEvent[]>([]);
    const [saleProgress, setSaleProgress] = useState<bigint>(BigInt("0"));
    const [timedUpdateCounter, setTimedUpdateCounter] = useState<number>(0);
    const [investIntentStatus, setInvestIntentStatus] = useState<{
        connectWalletTriggered?: boolean;
        switchNetworkTriggered?: boolean;
    } | null>(null);
    const setReferredBySuccess = useRef(false);

    const saleAddress = useMemo(() => {
        return tokenSaleData?.saleContractAddress;
    }, [tokenSaleData?.saleContractAddress]);

    const tokenDecimalDivisor = useMemo(() => {
        if (!tokenSaleData) {
            return undefined;
        }
        return new Decimal(10).pow(tokenSaleData.targetTokenDecimals);
    }, [tokenSaleData?.targetTokenDecimals]);

    const setReferredByFinished = useCallback(() => {
        setReferredBySuccess.current = true;
        const newTokenSaleReferralData = { ...tokenSaleReferralData };
        delete newTokenSaleReferralData[tokenSaleId];
        setTokenSaleReferralData(newTokenSaleReferralData);
        searchParams.delete('ref');
        setSearchParams(searchParams);
    }, [searchParams, setSearchParams, tokenSaleReferralData, setTokenSaleReferralData]);

    const setReferralErrorHandler = useCallback((e: unknown) => {
        if (e instanceof Error && e.message === errors.server.CANNOT_CHANGE_REFERRER) {
            showSnackbar({ type: 'warning', text: 'You cannot change your referrer.' });
            setReferredByFinished();
        }
        else if (e instanceof Error && e.message === errors.server.CANNOT_REFER_SELF) {
            showSnackbar({ type: 'warning', text: 'You cannot refer yourself.' });
            setReferredByFinished();
        }
        else if (e instanceof Error && e.message === errors.server.CANNOT_SET_CIRCULAR_REFERRER) {
            showSnackbar({ type: 'warning', text: 'You cannot be referred by someone who was referred by you directly or indirectly.' });
            setReferredByFinished();
        }
        else if (e instanceof Error && e.message === errors.server.CANNOT_REFER_USER_WHO_BOUGHT_TOKENS) {
            showSnackbar({ type: 'warning', text: 'You cannot be referred after you have bought tokens.' });
            setReferredByFinished();
        }
        else {
            console.error("Error setting referral", e);
        }
    }, [setReferredByFinished, showSnackbar]);

    useEffect(() => {
        let extraTimeoutSet = false;
        const update = () => {
            userApi.getOwnTokenSaleData({ tokenSaleId }).then(data => {
                if (config.DEPLOYMENT === 'prod') {
                    if (
                        data.tokenSaleData.saleContractAddress !== '0xAf8734576AC37F45aE2DCce82582456968CD11A2' ||
                        data.tokenSaleData.saleContractChain !== 'eth'
                    ) {
                        console.error("Token sale data is not valid for prod");
                        return;
                    }
                }
                else if (config.DEPLOYMENT === 'staging') {
                    if (
                        data.tokenSaleData.saleContractAddress !== '0x10AC99C1B2A824fdd1198A24533a911B0Dc3e2Fb' ||
                        data.tokenSaleData.saleContractChain !== 'xdai'
                    ) {
                        console.error("Token sale data is not valid for staging");
                        return;
                    }
                }
                else {
                    if (
                        data.tokenSaleData.saleContractAddress !== '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9' ||
                        (data.tokenSaleData.saleContractChain as any) !== 'hardhat'
                    ) {
                        console.warn("Token sale data is not valid for dev, proceeding anyway");
                    }
                }
                setSaleProgress(BigInt(data.tokenSaleData.totalInvested));
                setTokenSaleData(data.tokenSaleData);
                setUserSaleData(data.userSaleData || null);
                setWalletAddressToClaim(data.userSaleData?.targetAddress || null);
                if (!!ownUser?.id && !data.userSaleData && !extraTimeoutSet) {
                    extraTimeoutSet = true;
                    setTimeout(update, 5_000);
                }
            }).catch(e => {
                console.error("Error getting own token sale data", e);
            });
            userApi.getTokenSaleEvents({ tokenSaleId }).then(events => {
                const _events = events.map(event => ({
                    type: event.type,
                    userId: event.userId,
                    investedAmount: BigInt(event.bigint_investedAmount),
                    saleProgressBefore: BigInt(event.bigint_saleProgressBefore),
                    investmentId: event.investmentId,
                    blockNumber: event.blockNumber,
                    timestamp: new Date(event.dateIsoString_timestamp),
                    txHash: event.txHash,
                }));
                setEvents(_events.reverse());
            }).catch(e => {
                console.error("Error getting token sale events", e);
            });
        }
        update();
        const interval = setInterval(update, 15_000);
        return () => clearInterval(interval);
    }, [ownUser?.id]);

    useEffect(() => {
        if (setReferredBySuccess.current) {
            return;
        }
        const referredByParam = searchParams.get('ref');
        if (!!referredByParam) {
            try {
                const referrerId = t.toUUID(referredByParam);
                if (!!userSaleData) {
                    if (!userSaleData.referredByUserId) {
                        userApi.setReferredBy({ referredBy: referrerId, tokenSaleId }).then(() => {
                            setReferredByFinished();
                        }).catch(e => {
                            setReferralErrorHandler(e);
                        });
                    }
                    else {
                        setReferredByFinished();
                    }
                }
                else {
                    const newTokenSaleReferralData = { ...tokenSaleReferralData };
                    newTokenSaleReferralData[tokenSaleId] = referrerId;
                    setTokenSaleReferralData(newTokenSaleReferralData);
                    searchParams.delete('ref');
                    setSearchParams(searchParams);
                }
            }
            catch (e) {
                console.error("Invalid referredBy param", e);
            }
        }
        else if (!!userSaleData && !userSaleData.referredByUserId && !!tokenSaleReferralData[tokenSaleId]) {
            userApi.setReferredBy({ referredBy: tokenSaleReferralData[tokenSaleId], tokenSaleId }).then(() => {
                setReferredByFinished();
            }).catch(e => {
                setReferralErrorHandler(e);
            });
        }
    }, [!!userSaleData, userSaleData?.referredByUserId, tokenSaleReferralData]);

    useEffect(() => {
        const interval = setInterval(() => {
            setTimedUpdateCounter(old => old + 1);
        }, 15_000);
        return () => clearInterval(interval);
    }, []);

    const setAmount = useCallback((value: string) => {
        if (value === '' || value.match(/^\d+(\.)?(\d{1,6})?$/)) {
            if (!!value) {
                const availableSpace = new Decimal(3000).minus(new Decimal(ethers.utils.formatEther(saleProgress.toString())));
                if (new Decimal(value.replace(/\.$/, '')).gt(availableSpace)) {
                    value = availableSpace.mul(new Decimal(10).pow(6)).floor().div(new Decimal(10).pow(6)).toString();
                }
            }
            _setAmount(value.replace(/^0+(?=[1-9])/, ''));
        }
    }, [saleProgress]);

    const countryInfo = useAsyncMemo(async () => {
        return await userApi.getConnectionCountry();
    }, []);

    const ownTokenAmount = useMemo(() => {
        let tokens = new Decimal(0);
        let investedAmount = new Decimal(0);
        if (!!tokenDecimalDivisor) {
            const ownEvents = events.filter(event => event.userId === ownUser?.id);
            for (const event of ownEvents) {
                const saleProgressBefore = new Decimal(ethers.utils.formatEther(event.saleProgressBefore.toString()));
                const investedAmountEther = new Decimal(ethers.utils.formatEther(event.investedAmount.toString()));
                const tokenAmount = getExactTokenAmount(saleProgressBefore, investedAmountEther).mul(tokenDecimalDivisor).floor();
                tokens = tokens.plus(tokenAmount);
                investedAmount = investedAmount.plus(investedAmountEther);
            }
        }
        const averagePriceInMicroEth = tokens.gt(0) && !!tokenDecimalDivisor ? investedAmount.div(tokens.div(tokenDecimalDivisor)).mul(new Decimal(10).pow(6)) : new Decimal(0);
        return { tokens, averagePriceInMicroEth };
    }, [events, ownUser?.id, tokenDecimalDivisor]);

    const canInvestStatus: 'yes' | 'no' | 'unknown' = !!countryInfo ? (countryInfo.country === 'US' || countryInfo.country === 'USA' ? 'no' : 'yes') : 'unknown';

    const userIds = useMemo(() => {
        const idSet = events.reduce((acc, event) => {
            acc.add(event.userId);
            return acc;
        }, new Set<string>());
        if (!!userSaleData?.referredByUserId) {
            idSet.add(userSaleData.referredByUserId);
        }
        return Array.from(idSet);
    }, [events, userSaleData?.referredByUserId]);

    const userData = useMultipleUserData(userIds);

    const walletConnected = useMemo(() => {
        return !!walletAddress && !!chain;
    }, [walletAddress, chain]);

    const userIdBytes = useMemo(() => {
        return !!ownUser?.id ? `0x${ownUser.id.toLowerCase().replace(/-/g, '')}` as `0x${string}` : undefined;
    }, [ownUser?.id]);

    const allowanceSignature = useAsyncMemo(async () => {
        if (!userIdBytes || !ownUser?.extraData?.kycCgTokensaleSuccess || !ownUser?.extraData?.agreedToTokenSaleTermsTimestamp) {
            return undefined;
        }
        try {
            const { allowance } = await userApi.getTokenSaleAllowance();
            return allowance;
        }
        catch (e) {
            if (e instanceof Error && e.message === errors.server.KYC_MISSING) {
                setError('Please complete your KYC to participate in the token sale.');
            }
            else if (e instanceof Error && e.message === errors.server.AGREEMENT_TO_TERMS_MISSING) {
                setError('Please agree to the terms of the token sale to participate.');
            }
            else {
                throw e;
            }
        }
        return undefined;
    }, [userIdBytes, ownUser?.extraData?.kycCgTokensaleSuccess, ownUser?.extraData?.agreedToTokenSaleTermsTimestamp]);

    const payFunctionEnabled = useMemo(() => {
        return !!ownUser?.id && !!amount && !amount.endsWith('.') && parseFloat(amount) > 0 && !!allowanceSignature && !!isAllowedNetwork && chainId !== undefined;
    }, [ownUser?.id, amount, allowanceSignature, isAllowedNetwork, chainId]);

    const { config: prepareContractConfig, error: prepareContractError, isFetching } = usePrepareContractWrite({
        address: saleAddress,
        abi: cgTokensale_v1_abi,
        functionName: 'invest',
        args: !!userIdBytes && !!allowanceSignature ? [userIdBytes, allowanceSignature] as any : [] as any,
        enabled: payFunctionEnabled,
        value: BigInt(ethers.utils.parseEther(amount || '0').toString()),
        chainId,
    });

    const { data: contractWriteData, isLoading: isContractWriteLoading, write: contractWrite, error: contractWriteError } = useContractWrite(prepareContractConfig);

    if (prepareContractError || contractWriteError) {
        console.log("An error occurred while preparing or writing to the contract");
        console.log("Additional error info", {
            prepareContractError: prepareContractError,
            contractWriteError: contractWriteError,
            payFunctionEnabled: payFunctionEnabled,
            isAllowedNetwork: isAllowedNetwork,
            chainId: chainId,
            userIdBytes: userIdBytes,
            allowanceSignature: allowanceSignature,
            amount: amount,
            isContractWriteLoading: isContractWriteLoading,
            isFetching: isFetching,
            walletConnected: walletConnected,
        });
    }

    const investNowCallback = useCallback(() => {
        let hideContractError = false;
        if (!ownUser?.id && !isUserOnboardingVisible) {
            hideContractError = true;
            setUserOnboardingVisibility(true);
            return;
        }
        else if (!!ownUser?.id && (!ownUser?.extraData?.kycCgTokensaleSuccess || !ownUser?.extraData?.agreedToTokenSaleTermsTimestamp)) {
            hideContractError = true;
            showTooltip({ type: 'tokenSaleProcess' });
            return;
        }
        else if (!amount) {
            hideContractError = true;
            showSnackbar({ type: 'warning', text: 'Please enter an amount to invest.' });
        }
        else if (!allowanceSignature) {
            hideContractError = true;
            showSnackbar({ type: 'warning', text: 'Something went wrong, please reload this page.' });
        }
        else if (!!ownUser?.id) {
            if (!walletConnected) {
                openConnectModal?.();
                setInvestIntentStatus({ connectWalletTriggered: true });
            }
            else if (!isAllowedNetwork) {
                setInvestIntentStatus({ switchNetworkTriggered: true });
                switchNetworkAsync?.(chainId);
            }
            else if (!!contractWrite && !prepareContractError && !!payFunctionEnabled) {
                setInvestIntentStatus(null);
                contractWrite();
            }
        }
        setShowContractError(!hideContractError);
    }, [ownUser?.id, !ownUser?.extraData?.kycCgTokensaleSuccess, !ownUser?.extraData?.agreedToTokenSaleTermsTimestamp, walletConnected, isAllowedNetwork, switchNetworkAsync, chainId, isUserOnboardingVisible, setUserOnboardingVisibility, contractWrite, amount, openConnectModal, payFunctionEnabled, allowanceSignature, prepareContractError]);

    useEffect(() => {
        if (investIntentStatus?.connectWalletTriggered && !!walletConnected) {
            if (!isAllowedNetwork) {
                setInvestIntentStatus({ switchNetworkTriggered: true });
                switchNetworkAsync?.(chainId);
            }
            else if (!!contractWrite && !prepareContractError && !!payFunctionEnabled) {
                setInvestIntentStatus(null);
                contractWrite?.();
            }
        }
        else if (investIntentStatus?.switchNetworkTriggered && !!isAllowedNetwork) {
            if (!!contractWrite && !prepareContractError && !!payFunctionEnabled) {
                setInvestIntentStatus(null);
                contractWrite();
            }
        }
    }, [investIntentStatus, walletConnected, isAllowedNetwork, switchNetworkAsync, chainId, contractWrite, payFunctionEnabled, prepareContractError]);

    const currentPriceInMicroEth = useMemo(() => {
        return priceFn(new Decimal(saleProgress.toString()).div(new Decimal(10).pow(18))).mul(new Decimal(10).pow(6));
    }, [saleProgress]);

    const priceChangePercentage = useMemo(() => {
        if (ownTokenAmount.averagePriceInMicroEth.eq(0)) {
            return new Decimal(0);
        }
        return currentPriceInMicroEth.div(ownTokenAmount.averagePriceInMicroEth).sub(new Decimal(1)).mul(new Decimal(100));
    }, [currentPriceInMicroEth, ownTokenAmount.averagePriceInMicroEth]);

    const dummyInvestElement = true;
    const investElement = <div className="flex w-full justify-between flex-wrap items-start gap-8">
        <div className='flex flex-col gap-6 flex-1'>
            <div className='flex gap-6'>
                <img
                    src={CoinsIcon}
                    width={64}
                    height={64}
                    alt="Coins Icon"
                    className='w-16 h-16'
                />

                <div className='flex flex-col gap-1'>
                    {dummyInvestElement && <h2>0</h2>}
                    {!dummyInvestElement && <h2>{!!tokenDecimalDivisor ? shortenMillBillNumber(ownTokenAmount.tokens.div(tokenDecimalDivisor)) : '0'}</h2>}
                    <h3>Your Purchased Tokens</h3>
                </div>
            </div>
            <div className='flex gap-4 flex-wrap'>
                <div className='flex-1 flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4'>
                    <p className='cg-text-md-400 cg-text-secondary'>Your Average Token Price</p>
                    <h3>{!!ownTokenAmount.averagePriceInMicroEth ? formatNumberRemoveTrailingZeros(ownTokenAmount.averagePriceInMicroEth) : '0'} µETH</h3>
                </div>
                <div className='flex-1 flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4'>
                    <p className='cg-text-md-400 cg-text-secondary'>Current Token Price</p>
                    <h3>{formatNumberRemoveTrailingZeros(currentPriceInMicroEth)} µETH</h3>
                </div>
            </div>
            <div className='flex items-center gap-2'>
                <div className='cg-bg-success cg-text-success cg-circular flex gap-1 items-center cg-caption-md-600 p-1'>
                    <ArrowRightIcon className='w-4 h-4' />+{dummyInvestElement ? '0' : formatNumberRemoveTrailingZeros(priceChangePercentage, 2)}%
                </div>
                <p>compared to your average price</p>
            </div>
        </div>

        <div className='flex flex-col p-4 cg-border-xl gap-6 cg-content-stack-subtle flex-1'>
            {!dummyInvestElement && canInvestStatus === 'unknown' && (
                <div className='flex flex-col gap-2'>
                    <p>We are checking if you can invest. This might take a moment.</p>
                    <Spinner className='w-6 h-6 spinner' />
                </div>
            )}
            {!dummyInvestElement && canInvestStatus === 'no' && (
                <div className='flex flex-col gap-2'>
                    As an american, unfortunately you cannot invest in this sale. You can still refer others to earn tokens.
                </div>
            )}
            {(dummyInvestElement || canInvestStatus === 'yes') && (<>
                <div className='flex flex-col gap-2'>
                    <h2>Amount to buy in ETH</h2>
                    <TextInputField
                        value={amount}
                        onChange={setAmount}
                        placeholder='1 ETH'
                        type='text'
                        inputClassName='tokensale-input'
                        subLabel='minimum amount is 0.001 ETH'
                        iconRight={<>
                            <div className='flex items-center gap-0 absolute right-4' style={{ backgroundColor: isDarkMode ? '#333' : '#555', padding: '4px 8px 4px 4px', borderRadius: '999px' }}>
                                <EthereumIcon className='w-4 h-4' />
                                <span className='text-xs text-white'>ETH</span>
                            </div>
                            <div className='flex items-center gap-0 absolute px-1 py-0' style={{ backgroundColor: isDarkMode ? '#333' : '#555', borderRadius: '4px', top: '90%', left: 'calc(50% - 14px)', zIndex: 1 }}>
                                <span className='text-white'>↓</span>
                            </div>
                        </>}
                    />
                    <div className='input-container select-text'>
                        <div className='input-container-inner'>
                            <div className='input tokensale-input'>
                                {!!tokenDecimalDivisor && !!amount ? parseFloat(getExactTokenAmount(new Decimal(ethers.utils.formatEther(saleProgress)), new Decimal(amount.replace(/\.$/, ''))).toFixed(5)).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '0'}
                                <div className='cg-caption-md-400-no-transform cg-text-secondary italic max-w-[200px] mt-2'>amount can be lower, if someone's faster than you</div>
                            </div>
                            <div className='flex items-center gap-1 absolute right-4' style={{ backgroundColor: isDarkMode ? '#333' : '#555', padding: '4px 8px 4px 8px', borderRadius: '999px' }}>
                                <img src="/logo.svg" width={16} height={16} alt="CG Icon" />
                                <span className='text-xs text-white'>CG</span>
                            </div>
                        </div>
                    </div>
                    {!!userSaleData?.referredByUserId && !!userData[userSaleData.referredByUserId] && (
                        <UserTooltip
                            userId={userSaleData.referredByUserId}
                            isMessageTooltip={false}
                            triggerClassName='flex items-center gap-2 mt-1'
                        >
                            <Jdenticon
                                userId={userSaleData.referredByUserId}
                                predefinedSize='24'
                            />
                            <div className='flex justify-center cg-text-main cg-text-md-500'>{userData[userSaleData.referredByUserId] ? getDisplayName(userData[userSaleData.referredByUserId]) : ''}<span className='cg-text-secondary cg-text-md-500'>&nbsp;invited you</span></div>
                        </UserTooltip>
                    )}
                </div>

                <div className='grid grid-cols-3 gap-2'>
                    <Button
                        role='secondary'
                        text={<div className='px-4 py-2 text-center'>
                            <span>🐟</span><br />
                            <span className='cg-text-secondary'>0.1 Ξ</span>
                        </div>}
                        style={amount === '0.1' ? {
                            boxShadow: '0 0 5px 3px dodgerblue'
                        } : undefined}
                        onClick={() => {
                            setAmount('0.1');
                        }}
                    />
                    <Button
                        role='secondary'
                        text={<div className='px-4 py-2 text-center'>
                            <span>🐳</span><br />
                            <span className='cg-text-secondary'>1 Ξ</span>
                        </div>}
                        style={amount === '1' ? {
                            boxShadow: '0 0 5px 3px dodgerblue'
                        } : undefined}
                        onClick={() => {
                            setAmount('1');
                        }}
                    />
                    <Button
                        role='secondary'
                        text={<div className='px-4 py-2 text-center'>
                            <span>🦄</span><br />
                            <span className='cg-text-secondary'>10 Ξ</span>
                        </div>}
                        style={amount === '10' ? {
                            boxShadow: '0 0 5px 3px dodgerblue'
                        } : undefined}
                        onClick={() => {
                            setAmount('10');
                        }}
                    />
                </div>

                <div className='flex flex-col gap-1'>
                    <Button
                        role='primary'
                        text={isContractWriteLoading ? 'Processing...' : 'Buy $CG Tokens'}
                        onClick={investNowCallback}
                        disabled={isContractWriteLoading}
                    />
                    {(!isFetching && payFunctionEnabled && showContractError && (prepareContractError || contractWriteError)) && (
                        <div className='text-red-500 mt-2' style={{ overflowWrap: 'anywhere' }}>
                            {(prepareContractError as any)?.cause?.details || prepareContractError?.message || (contractWriteError as any)?.cause?.details || contractWriteError?.message}
                        </div>
                    )}
                </div>
            </>)}
        </div>
    </div>;

    const shareElement = <div className="flex p-4 cg-bg-subtle cg-border-xl gap-6 flex-wrap">
        <div className='flex justify-between gap-4 w-full'>
            <img
                src={TokenNetIcon}
                alt="Token Net Icon"
                className='w-12 h-12'
            />
            <Button
                role='secondary'
                text={'Share invite link'}
                onClick={() => {
                    if (!!ownUser) {
                        navigator.clipboard.writeText(urlConfig.APP_URL + '/token/?ref=' + t.fromUUID(ownUser.id));
                        showSnackbar({
                            text: 'Personal referral link copied to clipboard',
                            type: 'success',
                        });
                    }
                    else {
                        setUserOnboardingVisibility(true);
                    }
                }}
            />
        </div>
        <div className='flex flex-col gap-6'>
            <div className='flex gap-10 items-center justify-between'>
                <div className='flex flex-wrap gap-6'>
                    <div className='flex flex-col items-start gap-2'>
                        <h2 className='cg-text-secondary'>{userSaleData?.referredUsersDirectCount || 0}</h2>
                        <p className='cg-text-lg-500'>People invited</p>
                    </div>
                    <div className='flex flex-col items-start gap-2'>
                        <h2 className='cg-text-secondary'>{userSaleData?.referredUsersIndirectCount || 0}</h2>
                        <p className='cg-text-lg-500'>People they invited</p>
                    </div>
                    <div className='flex flex-col items-start gap-2'>
                        <h2 className='cg-text-secondary'>{!!userSaleData && !!tokenSaleData ? shortenMillBillNumber(parseFloat(ethers.utils.formatUnits(userSaleData.referralBonus, tokenSaleData.targetTokenDecimals))) : 0}</h2>
                        <p className='cg-text-lg-500'>Tokens Earned</p>
                    </div>
                </div>

            </div>
            <div className='flex flex-col gap-2'>
                <div className='flex gap-2'>
                    <div className='py-1 px-1.5 flex cg-text-brand cg-border-l cg-bg-brand-subtle h-fit cg-caption-md-600'>EARN</div>
                    <p className='cg-text-lg-500 cg-text-secondary'>Refer someone to the token sale, and you earn <span className='cg-text-brand'>10%</span> of the tokens they buy; you also earn smaller percentages from their referrals: <span className='cg-text-brand'>1%</span> from the next level down, <span className='cg-text-brand'>0.1%</span> from the following level, and so on. This means you keep getting small bonuses as the chain grows!</p>
                </div>
            </div>
        </div>
    </div>;

    const rewardProgram = userSaleData?.rewardProgram;

    const ownBoughtTokens = useMemo(() => {
        return ownTokenAmount.tokens.div(new Decimal(10).pow(tokenSaleData?.targetTokenDecimals || 1));
    }, [ownTokenAmount.tokens, tokenSaleData?.targetTokenDecimals]);

    const getCommunityAirdropTokens = () => {
        const ongoingAirdropTokens = ongoingAirdrops.reduce((acc, community) => acc + Number(community.userAirdropData?.amount || 0), 0);
        const finishedAirdropTokens = finishedAirdrops.reduce((acc, community) => acc + Number(community.userAirdropData?.amount || 0), 0);

        return ongoingAirdropTokens + finishedAirdropTokens;
    }

    const getEndOfSaleTotal = () => {
        return ownBoughtTokens.toNumber() + parseFloat(rewardProgram?.totalReward || '0') + getCommunityAirdropTokens();
    }

    const getEndOfSaleTotalString = () => {
        const totalTokens = ownBoughtTokens.toNumber() + parseFloat(rewardProgram?.totalReward || '0') + getCommunityAirdropTokens();
        return <>In total, you have acquired <span className='cg-text-brand'>{totalTokens.toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</span></>;
    }

    const renderBuyTab = () => {
        return <>
            {!saleHasStarted && !dummyInvestElement && <>
                <div className="flex flex-col items-center gap-2 py-4">
                    <h2 className={`text-center`}>The $CG Sale starts soon</h2>
                    <h3 className='cg-text-secondary text-center'>The earlier you buy tokens, the more you get</h3>
                </div>

                <p className='tokensale-timer'>{timeForSaleStart}</p>
            </>}
            {(saleIsOngoing || dummyInvestElement) && <>
                <div className="flex flex-col items-center gap-2 py-4">
                    <h2 className={`text-center ${isMobile ? 'max-w-[250px]' : ''}`}>{dummyInvestElement ? 'Coming soon: $CG Token Sale' : 'Buy $CG Tokens'}</h2>
                    {/* <h3 className='cg-text-secondary text-center'>The earlier you buy tokens, the more you get</h3> */}
                    {dummyInvestElement && <div className="w-full text-center px-6 py-4 cg-text-secondary cg-border-xl">
                        We are currently distributing $CG Tokens to our community members and early investors.
                        We will raise additional funds to support the ongoing development and hosting, with
                        a limited amount of $CG Tokens available at a fixed price. Join the Common Ground community
                        to learn about our governance and how you can participate.
                    </div>}
                </div>

                {canInvestStatus === 'no' && !dummyInvestElement && (<div className='flex flex-col gap-8 cg-bg-subtle w-full cg-border-xl p-8'>
                    <div className='flex flex-col gap-2 w-full py-4'>
                        <h2 className='flex items-center justify-center gap-2 text-center'>⛔ We see you’re based in the US <USFlag className='w-6 h-6' /></h2>
                        <h3 className='text-center cg-text-secondary'>Sorry, US citizens can’t buy CG tokens in the sale. However, you can still earn CG Tokens by referring other non-US buyers!</h3>
                    </div>
                    {shareElement}
                </div>)}

                {(canInvestStatus !== 'no' || dummyInvestElement) && (<>
                    {/* <div className='relative '>
                        <div ref={whatIsThisRef} className={`tokensale-what-is-this flex flex-col gap-4 cg-bg-subtle w-full cg-border-xl p-4 cg-text-lg-400 ${whatIsThisState}`} onClick={() => setWhatIsThisState('expanded')}>
                            <h2 className='w-full text-center'>What is this?</h2>
                            <ul className='flex flex-col gap-2 px-4 list-disc list-inside'>
                                <li>You’re on the token sale page for the $CG Token.</li>
                                <li className='cg-text-lg-500'>All $CG Tokens, free and paid, are delivered at a later point in time (we aim for mid Q1 2025 but reserve the right to deliver as late as 12 months after the official end of the sale).</li>
                                <li>On this page you can claim free $CG Tokens in case you’ve been with us for a while. You can also buy additional $CG Tokens, which you pay for in ETH.</li>
                                <li>The price per Token is defined by a function that you can see visualized as a curve below.</li>
                                <li>The more Tokens people buy, the higher the price per Token gets on that curve.</li>
                                <li>In total up to 9.44B $CG Tokens are offered for sale, with a hard cap of 3000 ETH.</li>
                                <li>You can only pay with ETH on mainnet.</li>
                            </ul>
                        </div>
                        {whatIsThisState.includes('collapsed') && <div className='absolute bottom-2 flex justify-center w-full z-10'>
                            <Button
                                role='secondary'
                                text='Click to read more'
                                onClick={() => setWhatIsThisState('expanded')}
                            />
                        </div>}
                    </div> */}
                    <div className={`flex flex-col gap-8 cg-bg-subtle w-full cg-border-xl ${isMobile ? 'p-4' : 'p-8'}${dummyInvestElement ? ' blur-[2px] pointer-events-none' : ''}`}>
                        {investElement}
                        {/* <div className='flex flex-col gap-5 w-full'>
                            <h3>All investors unlock:</h3>
                            <div className='flex flex-col gap-1'>
                                <div className='flex gap-2'>
                                    <CheckCircle weight='fill' className='cg-text-success w-5 h-5' />
                                    <p className='cg-text-md-500 flex-1'>Access to Investor-only Role in the Common Ground Community</p>
                                </div>
                                <div className='flex gap-2'>
                                    <CheckCircle weight='fill' className='cg-text-success w-5 h-5' />
                                    <p className='cg-text-md-500 flex-1'>Regular investor video updates by the founders</p>
                                </div>
                                <div className='flex gap-2'>
                                    <CheckCircle weight='fill' className='cg-text-success w-5 h-5' />
                                    <p className='cg-text-md-500 flex-1'>Invited to vote on decisions that affect our roadmap</p>
                                </div>
                            </div>
                            <h3>Major investors (100M+ $CG Tokens) unlock:</h3>

                            <div className='flex flex-col gap-1'>
                                <p className='cg-text-lg-500'>Everything above plus:</p>
                                <div className='flex gap-2'>
                                    <CheckCircle weight='fill' className='cg-text-success w-5 h-5' />
                                    <p className='cg-text-md-500 flex-1'>Whale Investor Role in the Common Ground Community with deep-dives and insights</p>
                                </div>
                                <div className='flex gap-2'>
                                    <CheckCircle weight='fill' className='cg-text-success w-5 h-5' />
                                    <p className='cg-text-md-500 flex-1'>Access to Investor-only Telegram</p>
                                </div>
                                <div className='flex gap-2'>
                                    <CheckCircle weight='fill' className='cg-text-success w-5 h-5' />
                                    <p className='cg-text-md-500 flex-1'>Invited to roundtable to brainstorm major features during development</p>
                                </div>
                            </div>
                        </div> */}
                    </div>
                </>)}
            </>}

            {/* {saleIsOngoing && (<>
                <div className='flex flex-col items-center gap-2 py-4'>
                    <h2>Earn tokens by inviting others</h2>
                    <h3 className='cg-text-secondary'>The more people you invite, the more tokens you get</h3>
                </div>

                {shareElement}
            </>)} */}

            <TokenSaleInfo investmentEvents={events} />

            <h2 className='max-w-[800px] text-center justify-self-center p-6'>Will you join us on this journey, and decide what Common Ground will become?</h2>

            {saleIsOngoing && canInvestStatus === 'yes' && (<div className='max-w-[800px] flex flex-col items-center cg-content-stack cg-border-xl justify-self-center p-8'>
                {investElement}
            </div>)}
        </>
    }

    const renderClaimTab = () => {
        const infoElement = <div className="flex flex-col items-center gap-2 py-4 w-full">
            <h2 className={`text-center ${isMobile ? 'max-w-[250px]' : ''}`}>Earn $CG Tokens</h2>
            <div className="w-full text-center px-6 py-4 cg-text-secondary cg-border-xl">
                We are planning a contributor program which is closely aligned with our Open Source strategy.
                It will allow a wide range of contributors to earn $CG Tokens. There have also been
                airdrops to reward our active community in the past. If you're eligible, you will
                find your rewards here.
            </div>
        </div>;

        return <>
            {infoElement}
            <div className={`tokensale-content-row cg-bg-subtle cg-border-xl gap-2 ${isMobile ? 'p-4' : 'p-8'}`}>
                {!!ownUser && <h1 className='w-full text-center pb-2'>Your $CG Tokens</h1>}

                {!!ownUser && <div className='grid tokensale-grid-2 gap-2 cg-bg-subtle cg-border-xl p-4 cg-text-lg-500'>
                    <div className='text-end'>From the token sale:</div>
                    <div className='text-start'>
                        <span className='cg-text-brand'>{ownBoughtTokens.toNumber().toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</span>
                    </div>
                    <div className='text-end'>From the platform airdrops:</div>
                    <div className='text-start'>
                        <span className='cg-text-brand'>{parseFloat(rewardProgram?.totalReward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</span>
                    </div>
                    <div className='text-end'>From the community airdrops:</div>
                    <div className='text-start'>
                        <span className='cg-text-brand'>{getCommunityAirdropTokens().toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</span>
                    </div>
                </div>}

                {!!ownUser && <h3 className='w-full text-center cg-text-secondary'>{getEndOfSaleTotalString()}</h3>}

                {getEndOfSaleTotal() === 0 ? <>
                    {!ownUser && <div className={`flex justify-center items-center w-full h-full ${isMobile ? 'col-span-1' : 'col-span-2'}`}>
                        <Button
                            role='primary'
                            text='Log in or create an account'
                            onClick={() => {
                                setUserOnboardingVisibility(true);
                            }}
                        />
                    </div>}
                    {ownUser && <h3 className='w-full text-center pt-2'>
                        You don't have any tokens yet, check this page regularly for updates and new opportunities!
                    </h3>}
                </> : <>
                    <p className='w-full text-center pt-2'><span className='cg-text-success'>Token distribution is active!</span> Check the Common Ground community for details.</p>
                    <div className='flex items-end flex-col gap-2 pt-2 w-full'>
                        <TextInputField
                            label='Wallet Address'
                            value={walletAddressToClaim || ''}
                            onChange={(value) => setWalletAddressToClaim(value)}
                            placeholder='0x...'
                        />
                        {(!!userSaleData?.targetAddress || walletAddressSaved) && (<h3 className=' pt-2 w-full text-center cg-text-success'>Wallet address saved. You will be able to claim your tokens soon!</h3>)}
                        <Button
                            role='primary'
                            text='Save Wallet Address'
                            onClick={async () => {
                                const lowerCaseWalletAddress = walletAddressToClaim?.toLocaleLowerCase();
                                try {
                                    validateAddress(lowerCaseWalletAddress as `0x${string}`);
                                } catch (e) {
                                    showSnackbar({ type: 'warning', text: 'The inserted address is not valid' });
                                    return;
                                }

                                try {
                                    await userApi.saveTokenSaleTargetAddress({ tokenSaleId: tokenSaleId, targetAddress: lowerCaseWalletAddress as `0x${string}` });
                                    showSnackbar({ type: 'success', text: 'Wallet address saved' });
                                } catch (e) {
                                    showSnackbar({ type: 'warning', text: 'Failed to save wallet address, please try again later' });
                                    console.error(e);
                                }
                            }}
                        />
                    </div>
                </>}

                {!!ownUser && !ownUser.email && (<div className='flex flex-col gap-4 cg-bg-subtle cg-border-xl p-4'>
                    <h3 className='w-full'>Want to keep track of announcements? Subscribe to our newsletter.</h3>
                    <TextInputField
                        value={email}
                        onChange={(value) => setEmail(value)}
                        placeholder='you@mail.com'
                    />
                    <Button
                        role='primary'
                        text='Subscribe to Newsletter'
                        onClick={async () => {
                            try {
                                if (email !== ownUser.email) {
                                    const isAvailable = await userApi.isEmailAvailable({ email });
                                    if (!isAvailable) {
                                        showSnackbar({ type: 'warning', text: 'The inserted email address is already in use' });
                                        return;
                                    }
                                }

                                await userApi.updateOwnData({ email: email, newsletter: true });
                                await userApi.requestEmailVerification({ email });
                                showSnackbar({ type: 'info', text: `We've sent you an email with a verification link, please check your inbox` });
                            }
                            catch (e) {
                                showSnackbar({ type: 'warning', text: 'Failed to save email address, please try again later' });
                            }
                        }}
                    />
                </div>)}

                {!!ownUser && !!ownUser.email && !ownUser.emailVerified && (<div className='flex flex-col gap-4 cg-bg-subtle cg-border-xl p-4'>
                    <h3 className='w-full'>Want to receive news about the Common Ground Project? Verify your email address.</h3>
                    <Button
                        role='primary'
                        text='Verify Email'
                        onClick={async () => {
                            try {
                                await userApi.requestEmailVerification({ email });
                                showSnackbar({ type: 'info', text: `We've sent you an email with a verification link, please check your inbox` });
                            }
                            catch (e) {
                                showSnackbar({ type: 'warning', text: 'Failed to send verification email, please try again later' });
                            }
                        }}
                    />
                </div>)}

                {!!ownUser && !!ownUser.email && !!ownUser.emailVerified && !ownUser.newsletter && (<div className='flex flex-col gap-4 cg-bg-subtle cg-border-xl p-4'>
                    <h3 className='w-full'>Want to keep track of announcements? Subscribe to our newsletter.</h3>
                    <Button
                        role='primary'
                        text='Subscribe to Newsletter'
                        onClick={async () => {
                            try {
                                await userApi.updateOwnData({ newsletter: true });
                                showSnackbar({ type: 'info', text: `You've successfully subscribed to our newsletter` });
                            }
                            catch (e) {
                                showSnackbar({ type: 'warning', text: 'Failed to save email address, please try again later' });
                            }
                        }}
                    />
                </div>)}
            </div>

            <OngoingAirdrops communities={ongoingAirdrops} />
            <FinishedAirdrops communities={finishedAirdrops} />

            {!!ownUser && (<>
                <div className='flex flex-col gap-2 items-center justify-center p-4 w-full'>
                    <h2 className='text-center'>Platform Airdrop Rewards</h2>
                    <h3 className='cg-text-secondary text-center'>For sticking with us since the beginning</h3>
                </div>

                <div className={`tokensale-content-row cg-bg-subtle cg-border-xl gap-4 p-4 grid ${isMobile ? 'grid-cols-1' : 'grid-cols-2'}`}>
                    {!userSaleData && <div className={`flex justify-center items-center w-full h-full ${isMobile ? 'col-span-1' : 'col-span-2'}`}><Spinner className='w-6 h-6 spinner' /></div>}
                    {!!userSaleData && <>
                        {(() => {
                            // if (userSaleData.rewardClaimedTimestamp) {
                            //     return <h3 className='w-full text-center cg-text-success'>You've successfully claimed your {parseFloat(rewardProgram?.totalReward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG!</h3>;
                            // }

                            // if (saleHasEnded) {
                            //     return <h3 className='w-full text-center'>The sale has ended, you may no longer claim any rewards.</h3>;
                            // }

                            if (rewardProgram && Object.keys(rewardProgram).length === 0) {
                                return <div className={`flex justify-between gap-2 cg-bg-subtle cg-border-xl p-4 w-full ${isMobile ? 'col-span-1 flex-col' : 'col-span-2'}`}>
                                    <h3 className='w-full text-center'>At this time you're not eligible for any rewards.</h3>
                                </div>;
                            }

                            // return <>
                            //     <h3>Thanks to your patronage, you're eligible for the following rewards totalling <span className='cg-text-brand'>{parseFloat(rewardProgram?.totalReward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</span></h3>
                            //     <Button
                            //         role='primary'
                            //         text={saleHasStarted ? 'Claim Rewards' : 'Claimable when sale starts'}
                            //         onClick={claimRewardsCallback}
                            //         disabled={!saleHasStarted}
                            //     />
                            // </>;

                            return null;
                        })()}

                        {rewardProgram?.messagesWrittenReward && (<div className='flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4 w-full h-full justify-between'>
                            <div className='flex flex-col gap-1 flex-1'>
                                <h3>Messages Written Reward</h3>
                                <p className='cg-text-md-400 cg-text-secondary'>For writing messages anywhere on Common Ground.</p>
                            </div>
                            <div className='flex items-center justify-between gap-2'>
                                <p className='cg-text-lg-500 flex-1'>You're at <span className='cg-text-brand'>{rewardProgram.messagesWrittenReward.yourPosition}</span> out of {rewardProgram.messagesWrittenReward.totalUsersRewarded} users.</p>
                                <div className='cg-text-lg-500 cg-bg-success cg-text-success p-1 cg-border-xl'>+{parseFloat(rewardProgram.messagesWrittenReward.reward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</div>
                            </div>
                        </div>)}

                        {rewardProgram?.callsJoinedReward && (<div className='flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4 w-full h-full justify-between'>
                            <div className='flex flex-col gap-1 flex-1'>
                                <h3>Calls Joined Reward</h3>
                                <p className='cg-text-md-400 cg-text-secondary'>For joining calls and broadcasts on Common Ground.</p>
                            </div>
                            <div className='flex items-center justify-between gap-2'>
                                <p className='cg-text-lg-500 flex-1'>You're at <span className='cg-text-brand'>{rewardProgram.callsJoinedReward.yourPosition}</span> out of {rewardProgram.callsJoinedReward.totalUsersRewarded} users.</p>
                                <div className='cg-text-lg-500 cg-bg-success cg-text-success p-1 cg-border-xl'>+{parseFloat(rewardProgram.callsJoinedReward.reward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</div>
                            </div>
                        </div>)}

                        {rewardProgram?.luksoReward && (<div className='flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4 w-full h-full justify-between'>
                            <div className='flex flex-col gap-1'>
                                <h3>Lukso Reward</h3>
                                <p className='cg-text-md-400 cg-text-secondary'>For joining Common Ground through Lukso.</p>
                            </div>
                            <div className='flex items-center justify-between gap-2'>
                                <p className='cg-text-lg-500 flex-1'>You're one of our {rewardProgram.luksoReward.totalUsersRewarded} rewarded users.</p>
                                <div className='cg-text-lg-500 cg-bg-success cg-text-success p-1 cg-border-xl'>+{parseFloat(rewardProgram.luksoReward.reward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</div>
                            </div>
                        </div>)}

                        {rewardProgram?.fuelReward && (<div className='flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4 w-full h-full justify-between'>
                            <div className='flex flex-col gap-1'>
                                <h3>Fuel Reward</h3>
                                <p className='cg-text-md-400 cg-text-secondary'>For joining Common Ground through Fuel.</p>
                            </div>
                            <div className='flex items-center justify-between gap-2'>
                                <p className='cg-text-lg-500 flex-1'>You're one of our {rewardProgram.fuelReward.totalUsersRewarded} rewarded users.</p>
                                <div className='cg-text-lg-500 cg-bg-success cg-text-success p-1 cg-border-xl'>+{parseFloat(rewardProgram.fuelReward.reward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</div>
                            </div>
                        </div>)}

                        {rewardProgram?.sparkBoughtReward && (<div className='flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4 w-full h-full justify-between'>
                            <div className='flex flex-col gap-1'>
                                <h3>Spark Bought Reward</h3>
                                <p className='cg-text-md-400 cg-text-secondary'>For purchasing Spark.</p>
                            </div>
                            <div className='flex items-center justify-between gap-2'>
                                <p className='cg-text-lg-500 flex-1'>You're one of our {rewardProgram.sparkBoughtReward.totalUsersRewarded} rewarded users.</p>
                                <div className='cg-text-lg-500 cg-bg-success cg-text-success p-1 cg-border-xl'>+{parseFloat(rewardProgram.sparkBoughtReward.reward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</div>
                            </div>
                        </div>)}

                        {rewardProgram?.recentLoginReward && (<div className='flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4 w-full h-full justify-between'>
                            <div className='flex flex-col gap-1'>
                                <h3>Recent Login Reward</h3>
                                <p className='cg-text-md-400 cg-text-secondary'>For being an active user on Common Ground.</p>
                            </div>
                            <div className='flex items-center justify-between gap-2'>
                                <p className='cg-text-lg-500 flex-1'>You're at <span className='cg-text-brand'>{rewardProgram.recentLoginReward.yourPosition}</span> out of {rewardProgram.recentLoginReward.totalUsersRewarded} users.</p>
                                <div className='cg-text-lg-500 cg-bg-success cg-text-success p-1 cg-border-xl'>+{parseFloat(rewardProgram.recentLoginReward.reward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</div>
                            </div>
                        </div>)}

                        {rewardProgram?.communitiesJoinedReward && (<div className='flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4 w-full h-full justify-between'>
                            <div className='flex flex-col gap-1'>
                                <h3>Communities Joined Reward</h3>
                                <p className='cg-text-md-400 cg-text-secondary'>For being part of many communities on Common Ground.</p>
                            </div>
                            <div className='flex items-center justify-between gap-2'>
                                <p className='cg-text-lg-500 flex-1'>You're at <span className='cg-text-brand'>{rewardProgram.communitiesJoinedReward.yourPosition}</span> out of {rewardProgram.communitiesJoinedReward.totalUsersRewarded} users.</p>
                                <div className='cg-text-lg-500 cg-bg-success cg-text-success p-1 cg-border-xl'>+{parseFloat(rewardProgram.communitiesJoinedReward.reward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</div>
                            </div>
                        </div>)}

                        {rewardProgram?.articlesWrittenReward && (<div className='flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4 w-full h-full justify-between'>
                            <div className='flex flex-col gap-1'>
                                <h3>Articles Written Reward</h3>
                                <p className='cg-text-md-400 cg-text-secondary'>For writing articles on Common Ground.</p>
                            </div>
                            <div className='flex items-center justify-between gap-2'>
                                <p className='cg-text-lg-500 flex-1'>You're at <span className='cg-text-brand'>{rewardProgram.articlesWrittenReward.yourPosition}</span> out of {rewardProgram.articlesWrittenReward.totalUsersRewarded} users.</p>
                                <div className='cg-text-lg-500 cg-bg-success cg-text-success p-1 cg-border-xl'>+{parseFloat(rewardProgram.articlesWrittenReward.reward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</div>
                            </div>
                        </div>)}

                        {rewardProgram?.registrationReward && (<div className='flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4 w-full h-full justify-between'>
                            <div className='flex flex-col gap-1'>
                                <h3>Registration Reward</h3>
                                <p className='cg-text-md-400 cg-text-secondary'>For registering your email for the Token Sale.</p>
                            </div>
                            <div className='flex items-center justify-between gap-2'>
                                <p className='cg-text-lg-500 flex-1'>You're one of our {rewardProgram.registrationReward.totalUsersRewarded} rewarded users.</p>
                                <div className='cg-text-lg-500 cg-bg-success cg-text-success p-1 cg-border-xl'>+{parseFloat(rewardProgram.registrationReward.reward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</div>
                            </div>
                        </div>)}

                        {rewardProgram?.oldAccountWithMessageReward && (<div className='flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4 w-full h-full justify-between'>
                            <div className='flex flex-col gap-1'>
                                <h3>Old Active Account Reward</h3>
                                <p className='cg-text-md-400 cg-text-secondary'>For being an OG user that posted messages on Common Ground.</p>
                            </div>
                            <div className='flex items-center justify-between gap-2'>
                                <p className='cg-text-lg-500 flex-1'>You're at <span className='cg-text-brand'>{rewardProgram.oldAccountWithMessageReward.yourPosition}</span> out of {rewardProgram.oldAccountWithMessageReward.totalUsersRewarded} users.</p>
                                <div className='cg-text-lg-500 cg-bg-success cg-text-success p-1 cg-border-xl'>+{parseFloat(rewardProgram.oldAccountWithMessageReward.reward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</div>
                            </div>
                        </div>)}

                        {rewardProgram?.oldAccountWithoutMessageReward && (<div className='flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4 w-full h-full justify-between'>
                            <div className='flex flex-col gap-1'>
                                <h3>Old Account Reward</h3>
                                <p className='cg-text-md-400 cg-text-secondary'>For being an OG user Common Ground user.</p>
                            </div>
                            <div className='flex items-center justify-between gap-2'>
                                <p className='cg-text-lg-500 flex-1'>You're at <span className='cg-text-brand'>{rewardProgram.oldAccountWithoutMessageReward.yourPosition}</span> out of {rewardProgram.oldAccountWithoutMessageReward.totalUsersRewarded} users.</p>
                                <div className='cg-text-lg-500 cg-bg-success cg-text-success p-1 cg-border-xl'>+{parseFloat(rewardProgram.oldAccountWithoutMessageReward.reward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</div>
                            </div>
                        </div>)}

                        {rewardProgram?.giveawayWinnersReward && (<div className='flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4 w-full h-full justify-between'>
                            <div className='flex flex-col gap-1'>
                                <h3>Giveaway Rewards 🍀</h3>
                                <p className='cg-text-md-400 cg-text-secondary'>For winning in our giveaways.</p>
                            </div>
                            <div className='flex items-center justify-between gap-2'>
                                <p className='cg-text-lg-500 flex-1'>Thanks for participating!</p>
                                <div className='cg-text-lg-500 cg-bg-success cg-text-success p-1 cg-border-xl'>+{parseFloat(rewardProgram.giveawayWinnersReward.reward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</div>
                            </div>
                        </div>)}

                        {rewardProgram?.communityAirdropRewards?.map(communityAirdrop => (<div className='flex flex-col gap-2 cg-bg-subtle cg-border-xl p-4 w-full h-full justify-between'>
                            <div className='flex flex-col gap-1'>
                                <div className='flex items-center gap-2'>
                                    {communityAirdrop.communityId && <>
                                        <CommunityPhoto community={communityListViews[communityAirdrop.communityId]} size='small' noHover />
                                        <h3>{communityListViews[communityAirdrop.communityId]?.title} Airdrop</h3>
                                    </>}
                                </div>
                                <p className='cg-text-md-400 cg-text-secondary'>For joining this community airdrop.</p>
                            </div>
                            <div className='flex items-center justify-between gap-2'>
                                <p className='cg-text-lg-500 flex-1'>You're at <span className='cg-text-brand'>{communityAirdrop.yourPosition}</span> out of {communityAirdrop.totalUsersRewarded} users.</p>
                                <div className='cg-text-lg-500 cg-bg-success cg-text-success p-1 cg-border-xl'>+{parseFloat(communityAirdrop.reward || '0').toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</div>
                            </div>
                        </div>))}
                    </>}
                </div>
            </>)}
        </>
    }

    const renderStakeTab = () => {
        return <div className='flex flex-col items-center cg-content-stack cg-border-xl'>
            <div className='flex flex-col justify-between items-center cg-text-main cg-text-lg-400 p-4 gap-10 relative'>
                <SparkFireBg />
            
                <div className='flex flex-col gap-6 z-10'>
                  <div className='flex gap-1 items-center justify-center'>
                    <SparkIcon className='w-8 h-8' />
                    <span className='spark-title'>Spark</span>
                  </div>
                  <div className='flex flex-col items-center justify-center gap-1'>
                    <h3 className='cg-heading-3'>What is it?</h3>
                    <span className='text-center'>Spark is an offchain currency, use it to upgrade communities and keep Common Ground alive. <SimpleLink className='underline cursor-pointer' href={learnMoreLink}>Learn more</SimpleLink></span>
                  </div>
                  <div className='flex flex-col items-center justify-center gap-1'>
                    <h3 className='cg-heading-3'>How do I get it?</h3>
                    <span className='text-center'>
                        We're working hard to enable staking so you can earn Spark. This feature will be available soon — please check back for updates!
                    </span>
                  </div>
                </div>
                <div className='flex flex-col gap-2 self-stretch z-10'>
                  <Button
                    className='max-w-full w-full'
                    disabled
                    text='Stake for Spark'
                    role='primary'
                    iconLeft={<SparkIcon className='w-5 h-5' />}
                  />
                </div>
              </div>
        </div>
    }

    return (
        <Scrollable>
            <div className="tokensale-root cg-text-main">
                <div className="tokensale-header relative">
                    <img
                        className={`absolute ${isMobile ? 'top-3' : 'top-12'} left-1/2 -translate-x-1/2`}
                        src="/logo.svg"
                        width={70}
                        height={70}
                        alt="Common Ground Logo"
                    />
                    <div className="tokensale-header-image flex justify-center">
                        <img
                            src="/images/tokensale_header.webp"
                            alt="Token Sale Header"
                        />
                    </div>
                    <div className="tokensale-header-text">
                        <span className="tokensale-header-text-bottom z-10">
                            play. build. own.<br />
                            On Common Ground
                        </span>
                    </div>
                </div>

                <div className="tokensale-content tokensale-content-card tokensale-content-card-top cg-content-stack z-10">
                    <div className={`flex cg-text-brand items-center flex-wrap sticky top-4 z-20 cg-border-xl cg-bg-2nd py-4 px-6 ${isMobile ? 'gap-4' : 'gap-8'}`}>
                        {SHOW_GET_EARN_TABS && <Button
                            role='textual'
                            className='token-section-btn'
                            iconLeft={<TipJar weight='duotone' className='w-6 h-6' />}
                            text='Get'
                            active={currentTab === 'buy'}
                            onClick={() => setCurrentTab('buy')}
                        />}

                        {SHOW_GET_EARN_TABS && <Button
                            role='textual'
                            className='token-section-btn'
                            iconLeft={<HandCoins weight='duotone' className='w-6 h-6' />}
                            text='Earn'
                            active={currentTab === 'claim'}
                            onClick={() => setCurrentTab('claim')}
                        />}

                        <Button
                            role='textual'
                            className='token-section-btn'
                            iconLeft={<Coins weight='duotone' className='w-6 h-6' />}
                            text='Stake'
                            active={currentTab === 'stake'}
                            onClick={() => setCurrentTab('stake')}
                        />
                    </div>

                    {/* <BuyTokenHeader /> */}

                    {currentTab === 'buy' && renderBuyTab()}
                    {currentTab === 'claim' && renderClaimTab()}
                    {currentTab === 'stake' && <StakeTab comingSoon={renderStakeTab()} />}
                </div>
                <div />
            </div>
        </Scrollable>
    );
}

export default TokenSale;