// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import "./CommunityHome.css";
import { useNavigate } from 'react-router-dom';

import useLocalStorage, { VisitedCommunitiesState } from '../../../../hooks/useLocalStorage';
import { useSignedUrl } from '../../../../hooks/useSignedUrl';

import Button from '../../../atoms/Button/Button';
import SimpleLink from '../../../../components/atoms/SimpleLink/SimpleLink';
import ArticleExplorer from 'components/organisms/ArticleExplorer/ArticleExplorer';

import { useLoadedCommunityContext } from 'context/CommunityProvider';
import { getUrl } from 'common/util';
import { CommunityPermission } from 'common/enums';
import LoginBanner from 'components/molecules/LoginBanner/LoginBanner';
import { useOwnUser } from 'context/OwnDataProvider';
import LiveCallExplorer from 'components/organisms/LiveCallExplorer/LiveCallExplorer';
import CommunityInput from 'components/molecules/CommunityInput/CommunityInput';
import SparkIcon from 'components/atoms/icons/misc/spark.svg?react';
import { useUserSettingsContext } from 'context/UserSettingsProvider';
import JoinNewsletterBanner from 'components/molecules/JoinNewsletterBanner/JoinNewsletterBanner';
import { useCommunityPremiumTier } from 'hooks/usePremiumTier';
import { getTierElementTitle, getTierElementIcon, getDisplayName } from 'util/index';
import dayjs from 'dayjs';
import { Tooltip } from 'components/atoms/Tooltip/Tooltip';
import config from 'common/config';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import AirdropGraph from './Widgets/AirdropGraph';
import communityApi from 'data/api/community';
import { configurableReciprokePriceFn, Decimal } from 'common/tokensale/helper';
import type DecimalType from 'decimal.js';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import Jdenticon from 'components/atoms/Jdenticon/Jdenticon';
import { useMultipleUserData } from 'context/UserDataProvider';
import UserTooltip from 'components/organisms/UserTooltip/UserTooltip';
import { calculateAgeString, calculateTimeUntil } from 'views/TokenSale/TokenSale';
import urls from 'data/util/urls';
import { CheckCircle, Spinner } from '@phosphor-icons/react';
import { tagStringToPredefinedTag } from 'components/molecules/inputs/TagInputField/TagInputField';
import Tag, { TagIcon } from 'components/atoms/Tag/Tag';

type Props = {
}

function CommunityHome(props: Props) {
    const navigate = useNavigate();
    const ownUser = useOwnUser();
    const { community, communityPermissions, roles, ownRoles } = useLoadedCommunityContext();
    const headerUrl = useSignedUrl(community.headerImageId);
    const [descriptionState, setDescriptionState] = useState<'collapsed' | 'collapsed desc-grad' | 'expanded'>('collapsed desc-grad');
    const [, setVisitedState] = useLocalStorage<VisitedCommunitiesState>({}, 'communities-visited-state');
    const { setGiveSparkCommunityId, setCurrentPage, setIsOpen } = useUserSettingsContext();
    const descriptionRef = useRef<HTMLParagraphElement>(null);
    const { tier, tierData } = useCommunityPremiumTier(community.premium);
    const [timeForAirdropEnd, setTimeForAirdropEnd] = useState<string | null>(null);
    const [showHiddenAirdrop, setShowHiddenAirdrop] = useState<boolean>(false);
    const { isMobile } = useWindowSizeContext();

    const airdropRole = useMemo(() => {
        return roles.find(role => !!role.airdropConfig) as (Models.Community.Role & { airdropConfig: Models.Community.RoleAirdropConfig }) | undefined;
    }, [roles]);

    useEffect(() => {
        if (!airdropRole) return;

        let interval: NodeJS.Timeout;
        const refreshTimeUntil = () => {
            const timeUntil = calculateTimeUntil(dayjs(airdropRole.airdropConfig.endDate));
            setTimeForAirdropEnd(timeUntil);

            if (timeUntil === 'Now') {
                clearInterval(interval);
            }
        }

        refreshTimeUntil();
        interval = setInterval(refreshTimeUntil, 1_000);
        return () => clearInterval(interval);
    }, [airdropRole]);

    const [airdropUserData, setAirdropUserData] = useState<{
        userId: string;
        claimedAt: string;
    }[] | null>(null);

    const ownAirdropUserIndex = useMemo(() => {
        if (!airdropUserData) return undefined;
        const result = airdropUserData?.findIndex(user => user.userId === ownUser?.id);
        if (result >= 0) {
            return result;
        }
        return null;
    }, [airdropUserData, ownUser?.id]);

    const bonusPercent = useMemo(() => {
        if (!airdropRole) return 0;
        const reachedMilestones = airdropRole.airdropConfig.milestones.filter(milestone => (airdropUserData?.length || 0) >= milestone.users);
        return Math.max(0, ...reachedMilestones.map(milestone => milestone.bonusPercent || 0));
    }, [airdropRole, airdropUserData]);

    useEffect(() => {
        if (!airdropRole) return;
        let mounted = true;
        const updateFn = async () => {
            communityApi.getAirdropClaimHistory({
                communityId: community.id,
                roleId: airdropRole.id,
            }).then(({ claimData }) => {
                if (mounted) {
                    setAirdropUserData(claimData);
                }
            });
        }
        updateFn();
        const interval = setInterval(updateFn, 15_000);
        return () => {
            mounted = false;
            clearInterval(interval);
        };
    }, [airdropRole, community.id]);

    useEffect(() => {
        setVisitedState(oldVisitedState => {
            const visitedStateCopy = { ...oldVisitedState };
            visitedStateCopy[community.id] = true;
            return visitedStateCopy;
        });
    }, [community.id, setVisitedState]);

    const CommunityLink = (props: { link: Common.Link }): React.JSX.Element => {
        const { link } = props;
        const url = useMemo(() => {
            if (!link.url.match(/^http(s)?:\/\//i)) {
                return 'https://' + link.url;
            } else {
                return link.url;
            }
        }, [link]);
        return (
            <SimpleLink className='btnChip' href={url}>
                <div className="btnText">
                    {link.text}
                </div>
            </SimpleLink>
        );
    }

    const communityLinks = (community?.links || []).filter(link => !!link.text.trim() && !!link.url.trim());
    let memberCount: number = community.memberCount;

    const handleCreateContentClick = useCallback(() => {
        navigate({
            pathname: getUrl({ type: 'community-create-article', community })
        });
    }, [navigate, community]);

    const emptyState = useMemo(() => {
        if (communityPermissions.has(CommunityPermission.COMMUNITY_MANAGE_ARTICLES)) {
            return <Button
                role='secondary'
                key='Write first article'
                text='Write first article'
                onClick={() => handleCreateContentClick()}
            />;
        } else {
            return undefined;
        }
    }, [communityPermissions, handleCreateContentClick]);

    // Resize listener for description omiting
    useEffect(() => {
        const listener: ResizeObserverCallback = async ([entry]) => {
            if (entry) {
                const height = entry.contentRect.height;
                setDescriptionState(old => old === 'expanded'
                    ? 'expanded' : height >= 64 ? 'collapsed desc-grad' : 'collapsed');
            }
        }

        const observer = new ResizeObserver(listener);
        if (descriptionRef.current) {
            observer.observe(descriptionRef.current);
        }
        return () => observer.disconnect();
    }, [community.description]);

    const tierExpireWarning = useMemo(() => {
        const { premium } = community;
        if (premium) {
            const diffInDays = dayjs(premium.activeUntil).diff(dayjs(), 'day');
            if (diffInDays > 0 && diffInDays <= 7) {
                let showWarning = !premium.autoRenew;
                const diffInDaysFloored = Math.floor(diffInDays);
                let infoText = `Expires in ${diffInDaysFloored > 0 ? `${diffInDaysFloored} days` : 'less than a day'}. Auto-renew is disabled.`;

                if (premium.autoRenew === 'MONTH') {
                    showWarning = community.pointBalance < tierData.MONTHLY_PRICE;
                    infoText = `Expires in ${diffInDaysFloored > 0 ? `${diffInDaysFloored} days` : 'less than a day'}. Insufficient balance to auto-renew.`;
                }
                else if (premium.autoRenew === 'YEAR') {
                    showWarning = community.pointBalance < Math.round(tierData.MONTHLY_PRICE * 12 * ((100 - config.PREMIUM.YEARLY_DISCOUNT_PERCENT) / 100));
                    infoText = `Expires in ${diffInDaysFloored > 0 ? `${diffInDaysFloored} days` : 'less than a day'}. Insufficient balance to auto-renew.`;
                }

                if (showWarning) {
                    return <Tooltip
                        offset={8}
                        triggerContent={<div className="cg-heading-3 cg-text-warning pl-1">⚠️</div>}
                        tooltipContent={infoText}
                        placement="bottom"
                        allowPropagation
                    />;
                }
            }
        }
        return null;
    }, [community.premium, tierData, community.pointBalance]);

    const params = useMemo(() => {
        return airdropRole?.airdropConfig?.functionParameters;
    }, [airdropRole?.airdropConfig]);

    const airdropConfigObject = useMemo(() => {
        if (!params) return null;
        return {
            a: new Decimal(params.a),
            b: new Decimal(params.b),
            c: new Decimal(params.c),
            k: new Decimal(params.k),
        };
    }, [params?.a, params?.b, params?.c, params?.k]);

    const ownAirdropTokenAmount = useMemo(() => {
        if (!airdropConfigObject || typeof ownAirdropUserIndex !== 'number') return null;
        return configurableReciprokePriceFn(new Decimal(ownAirdropUserIndex), airdropConfigObject).mul(new Decimal(1 + (bonusPercent / 100)));
    }, [airdropConfigObject, ownAirdropUserIndex, bonusPercent]);

    const fullCommunityTags = useMemo(() => tagStringToPredefinedTag(community.tags), [community.tags]);

    const hideAirdrop = useMemo(() => {
        if (showHiddenAirdrop) return false;
        if (!airdropRole) return true;
        return dayjs(airdropRole.airdropConfig.endDate).isBefore(dayjs().subtract(7, 'day'));
    }, [airdropRole?.airdropConfig.endDate, showHiddenAirdrop]);

    return (
        <div className="community-home-page cg-text-main">
            {!ownUser && <LoginBanner stickyMode />}
            <div className='flex p-4 gap-2 justify-between items-center self-stretch flex-wrap cg-bg-subtle cg-border-xxl'>
                <div className='flex flex-1 gap-2 items-center justify-between'>
                    <div className='flex items-center gap-1 cg-text-main'>
                        {!!tier ? <>{getTierElementIcon(tier, "w-8 h-8")} <div className='cg-heading-3'>{getTierElementTitle(tier)}</div>{tierExpireWarning}</> : <>Free Tier</>}
                    </div>
                    <div className='flex items-center gap-1 cg-text-main'>
                        <SparkIcon className='w-8 h-8' />
                        <span className='cg-heading-3'>{community.pointBalance.toLocaleString()}</span>
                        <span className='cg-text-secondary whitespace-nowrap'>{isMobile ? '' : 'in Community Safe'}</span>
                    </div>
                    <Button
                        role='secondary'
                        iconLeft={<SparkIcon className='w-5 h-5' />}
                        text='Give Spark'
                        onClick={() => {
                            setGiveSparkCommunityId(community.id);
                            setCurrentPage('give-spark');
                            setIsOpen(true);
                        }}
                    />
                </div>
            </div>
            {!!headerUrl && <img className='header-image' src={headerUrl} alt='Header' />}
            <div className='p-4 flex flex-col gap-4 cg-text-main'>
                <div className='flex flex-col gap-2 select-text' onClick={() => setDescriptionState('expanded')}>
                    <div className='flex justify-between items-center'>
                        <h2 className='cg-heading-2 whitespace-pre-wrap'>{community.title}</h2>
                        <span className='cg-text-lg-400 cg-text-secondary'>{memberCount} Members</span>
                    </div>
                    <div className='flex flex-wrap items-center gap-2'>
                        {fullCommunityTags.map((tag) => {
                            return <Tag
                                key={tag.name}
                                variant='tag'
                                label={tag.name}
                                iconLeft={<TagIcon tag={tag} />}
                            />
                        })}
                    </div>
                    {!!community.description && <p ref={descriptionRef} className={`community-description ${descriptionState}`}>{community?.description}</p>}
                </div>
                {communityLinks.length > 0 && <div className='flex gap-2 flex-wrap'>
                    {communityLinks.map((link, index) => <CommunityLink link={link} key={index} />)}
                </div>}
            </div>

            {hideAirdrop && !!airdropRole && <div className={`flex flex-row items-center gap-2 cg-bg-subtle cg-border-xxl text-center justify-between ${isMobile ? 'p-2' : 'p-4'}`}>
                <p>Airdrop ended on {dayjs(airdropRole.airdropConfig.endDate).format("MMM Do YYYY")}</p>
                <Button
                    role='secondary'
                    text='Show Airdrop'
                    onClick={() => setShowHiddenAirdrop(true)}
                />
            </div>}

            {!hideAirdrop && !!airdropRole && <>
                <div className={`flex flex-col items-center gap-2 cg-bg-subtle cg-border-xxl text-center ${isMobile ? 'p-4' : 'p-8'}`}>
                    <h2>Airdrop for the first {airdropRole.airdropConfig.maximumUsers} <span className='cg-text-brand'>{airdropRole?.title}</span> Holders</h2>

                    {timeForAirdropEnd !== 'Now' && <div className='flex flex-col items-center py-3'>
                        <p className='cg-text-md-500'>Time until airdrop</p>
                        <h1 className='cg-text-monospace'>{timeForAirdropEnd}</h1>
                    </div>}

                    {timeForAirdropEnd === 'Now' && <div className='flex flex-col items-center py-3'>
                        <h3 className='cg-text-md-500'>Airdrop ended on {dayjs(airdropRole.airdropConfig.endDate).format("MMM Do YYYY")}</h3>
                    </div>}

                    {(() => {
                        if (ownAirdropUserIndex !== null && ownAirdropUserIndex !== undefined && !!airdropConfigObject && !!ownAirdropTokenAmount) {
                            return <div className='flex flex-col items-center'>
                                <h3>You will receive <span className='cg-text-brand'>{ownAirdropTokenAmount.toNumber().toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</span></h3>
                                <p className='cg-text-md-400 text-center'>(if you want more, buy in our <SimpleLink className='cg-text-lg-500 underline cg-text-brand' href={`${urls.APP_URL}/token/`}>Token Sale</SimpleLink>)</p>
                                <h3 className='flex items-center gap-1 mt-4'><CheckCircle weight='duotone' className='w-6 h-6 cg-text-success' /> You need to do nothing else.</h3>
                                {timeForAirdropEnd !== 'Now' && <p className='cg-text-lg-400 text-center mt-4'><span className='font-bold'>If you leave the community</span>, or <span className='font-bold'>move the assets from your connected wallet</span> (and thereby lose your role), <span className='font-bold'>you will lose</span> your spot on the list.</p>}
                            </div>;
                        }

                        if (ownAirdropUserIndex === undefined) {
                            return <div className='flex flex-col gap-1 justify-center w-full p-6 items-center'>
                                <Spinner className='w-12 h-12 spinner' />
                            </div>;
                        }

                        // At this point, ownAirdropUserIndex is null
                        if (!!ownRoles.find(role => role.id === airdropRole?.id) || airdropUserData?.length === airdropRole.airdropConfig.maximumUsers) {
                            return <div className='flex flex-col gap-1 items-center'>
                                <h3>The maximum number of users has been reached.</h3>
                                {timeForAirdropEnd !== 'Now' && <p>At this moment, you may not claim the airdrop.</p>}
                            </div>;
                        }

                        // At this point, user does not have the role and the maximum number of users has not been reached
                        if (timeForAirdropEnd !== 'Now') {
                            return <div className='flex flex-col gap-1 items-center'>
                                <h3>In order to claim the airdrop, you need to have the <span className='cg-text-brand'>{airdropRole?.title}</span> role.</h3>
                                <p>To do that, go to the <SimpleLink className='cg-text-lg-500 underline cg-text-brand' href={`${urls.APP_URL}${getUrl({ type: 'community-roles', community })}`}>Roles page</SimpleLink> and get the role.</p>
                            </div>;
                        }

                        return null;
                    })()}

                    <div className='py-4 w-full'>
                        <AirdropGraph
                            usersClaimed={airdropUserData?.length || 0}
                            style={{ width: "100%", height: "360px" }}
                            role={airdropRole}
                            bonusPercent={bonusPercent}
                        />
                    </div>
                </div>

                <div className={`grid gap-4 cg-bg-subtle cg-border-xxl p-4 ${!isMobile ? 'grid-cols-2' : ''}`}>
                    <h2 className={`py-2 ${!isMobile ? 'col-span-2' : ''}`}>Milestones</h2>
                    {airdropRole.airdropConfig.milestones.map((milestone, index) => <div key={index} className='flex flex-row gap-2 items-center'>
                        {(airdropUserData?.length || 0) >= milestone.users ? <CheckCircle className='w-12 h-12 cg-text-success' weight='duotone' /> : <CheckCircle className='w-12 h-12 cg-text-secondary' weight='duotone' />}
                        <div className='flex flex-col gap-1'>
                            <h3>Milestone {index + 1}: <span className='cg-text-brand'>{milestone.users} users</span></h3>
                            {(airdropUserData?.length || 0) < milestone.users && <p className='cg-text-secondary cg-text-sm-500'>Currently at {airdropUserData?.length || 0} of {milestone.users}</p>}
                            <p className='cg-text-lg-400'>{milestone.text}{(milestone.bonusPercent || 0) > 0 && <span className='cg-text-success font-bold'> +{milestone.bonusPercent}%</span>}</p>
                        </div>
                    </div>)}
                </div>
            </>}

            {!hideAirdrop && !!airdropUserData && !!airdropConfigObject && <div className='flex flex-col items-center gap-4'>
                {airdropUserData.length > 0 && <AirdropUserList
                    users={airdropUserData}
                    airdropConfigObject={airdropConfigObject}
                    bonusPercent={bonusPercent}
                />}
                {airdropUserData.length === 0 && <h3 className='cg-text-brand'>No one has claimed the airdrop yet. Be the first one!</h3>}
            </div>}

            <CommunityInput />

            <JoinNewsletterBanner />

            {/* <div className="community-description">
                <div className="community-description-title">
                    <Button onClick={() => setDescriptionState(!descriptionState)} role='textual' text={`About ${community?.title}`} iconRight={!descriptionState ? <ChevronUpIcon /> : <ChevronDownIcon />} />
                </div>
                {descriptionState && community?.description && <p>{community?.description}</p>}
                {descriptionState && <div className='community-additional-info'>
                    <span>Created {dayjs(community.createdAt).format("MMM Do YYYY")} • {memberCount} Members</span>
                </div>}
                {communityLinks.length > 0 && <div className='community-description-links'>
                    {communityLinks.map((link, index) => <CommunityLink link={link} key={index} />)}
                </div>}
            </div> */}
            <LiveCallExplorer mode="unlimited" communityId={community.id} />
            <div className='community-lobby-content-articles'>
                {/* {prepareContentCards('announcements', announcementsEmptyState)}
                {prepareContentCards('articles', articlesEmptyState)}
                {prepareContentCards('guides', guidesEmptyState)}
                {communityHomeState.content.drafts?.length > 0 && prepareContentCards('drafts')}
                {communityHomeState.states['all'] === 'DONE' && <SectionEnd text="You&apos;ve reached the end!" footer={EndStateFooter} />} */}
                <ArticleExplorer
                    mode='unlimited'
                    communityData={{
                        community,
                        communityPermissions,
                    }}
                    hideEndButton
                    emptyState={emptyState}
                    showCount
                    hideOnEmpty
                />
            </div>
        </div>
    );
}

const AIRDROP_USER_LIST_LOAD_STEP = 50;

const AirdropUserList = (props: { users: { userId: string; claimedAt: string; }[], airdropConfigObject: { a: DecimalType; b: DecimalType; c: DecimalType; k: DecimalType; }, bonusPercent: number }) => {
    const { isMobile } = useWindowSizeContext();
    const { users, airdropConfigObject, bonusPercent } = props;
    const lastElementRef = useRef<HTMLDivElement>(null);
    const [numberOfUsersLoaded, setNumberOfUsersLoaded] = useState(AIRDROP_USER_LIST_LOAD_STEP);
    const loadedUsersEntries = useMemo(() => {
        return users.slice(0, numberOfUsersLoaded);
    }, [numberOfUsersLoaded, users]);

    const loadedUserIds = useMemo(() => {
        return loadedUsersEntries.map(user => user.userId);
    }, [loadedUsersEntries]);

    const loadedUsers = useMultipleUserData(loadedUserIds);

    useEffect(() => {
        const lastElement = lastElementRef.current;
        if (!lastElement) return;

        const observer = new IntersectionObserver(entries => {
            const [entry] = entries;
            console.log('Is intersecting', entry.isIntersecting);
            if (entry.isIntersecting && numberOfUsersLoaded < users.length) {
                setNumberOfUsersLoaded(prev => Math.min(prev + AIRDROP_USER_LIST_LOAD_STEP, users.length));
            }
        });

        if (lastElement) {
            observer.observe(lastElement);
        }

        return () => {
            if (lastElement) {
                observer.disconnect();
            }
        };
    }, [loadedUsers, numberOfUsersLoaded, users.length]);

    return <div className='cg-bg-subtle cg-border-xxl p-4 flex flex-col gap-6 w-full'>
        <h2 className='px-4'>Airdrop Claim History</h2>
        <Scrollable className='max-h-[400px] cg-bg-subtle cg-border-xxl' innerClassName='px-4'>
            <div className='flex flex-col gap-4'>
                <div />
                {loadedUsersEntries.map((userEntry, i) => <div key={userEntry.userId} className='flex flex-row items-center justify-between gap-4'>
                    <UserTooltip
                        userId={userEntry.userId}
                        isMessageTooltip={false}
                        triggerClassName='flex flex-row items-center gap-2 cursor-pointer flex-1 overflow-hidden'
                    >
                        <Jdenticon
                            userId={userEntry.userId}
                            predefinedSize='40'
                        />
                        <div className={`flex ${isMobile ? 'flex-col items-start' : 'flex-row items-center gap-1'} overflow-hidden flex-1`}>
                            <div className='cg-text-lg-500 overflow-hidden max-w-full'>{loadedUsers[userEntry.userId] ? getDisplayName(loadedUsers[userEntry.userId]) : userEntry.userId}</div>
                            <p className='cg-text-secondary'>claimed {configurableReciprokePriceFn(new Decimal(i), airdropConfigObject).mul(new Decimal(1 + (bonusPercent / 100))).toNumber().toLocaleString('en-US', { maximumFractionDigits: 2 })} $CG</p>
                        </div>
                    </UserTooltip>
                    <div className='cg-text-secondary cg-text-md-400'>{calculateAgeString(new Date(userEntry.claimedAt))}</div>
                </div>)}
                <div ref={lastElementRef} style={{ height: '1px' }} />
            </div>
        </Scrollable>
    </div>;
}

export default React.memo(CommunityHome);