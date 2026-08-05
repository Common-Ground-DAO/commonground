// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './UserProfileV2.css';
import { Asterisk, ChatTeardrop, Handshake, HouseSimple, Link, PencilSimple, UserCircleMinus, UserCirclePlus, Users } from '@phosphor-icons/react';
import Button from 'components/atoms/Button/Button';
import ExternalIcon, { ExternalIconType } from 'components/atoms/ExternalIcon/ExternalIcon';
import Jdenticon from 'components/atoms/Jdenticon/Jdenticon';
import SupporterIcon from 'components/atoms/SupporterIcon/SupporterIcon';
import { useUserPremiumTier } from 'hooks/usePremiumTier';
import React, { createRef, useCallback, useMemo, useRef, useState } from 'react'
import { getDisplayName, getDisplayNameString, getUserExternalLink } from '../../../util';
import { useDetailledUserData } from 'context/UserDataProvider';
import { useChats, useOwnUser } from 'context/OwnDataProvider';
import TextInputField from '../inputs/TextInputField/TextInputField';
import TextAreaField from '../inputs/TextAreaField/TextAreaField';
import { CheckIcon, XMarkIcon } from '@heroicons/react/20/solid';
import userApi from 'data/api/user';
import MultiEntryField from '../inputs/MultiEntryField/MultiEntryField';
import { useSnackbarContext } from 'context/SnackbarContext';
import { validateTagTextInput } from 'common/validators';
import ScreenAwareDropdown from 'components/atoms/ScreenAwareDropdown/ScreenAwareDropdown';
import ListItem from 'components/atoms/ListItem/ListItem';
import { PopoverHandle, Tooltip } from 'components/atoms/Tooltip/Tooltip';
import data from 'data';
import UserProfileV2OtherOptions from './UserProfileV2OtherOptions';
import { useUserSettingsContext } from 'context/UserSettingsProvider';
import { useTwitterAuth } from 'hooks/useTwitterAuth';
import { useUniversalProfile } from 'context/UniversalProfileProvider';
import SimpleLink from 'components/atoms/SimpleLink/SimpleLink';
import config from 'common/config';
import errors from 'common/errors';
import fileApi from 'data/api/file';
import { checkImageBeforeUpload } from 'moderation/checkImageBeforeUpload';
import { imageUploadErrorText } from 'moderation/imageUploadError';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import { useNavigate } from 'react-router-dom';
import { getUrl } from 'common/util';
import { useSafeCommunityContext } from 'context/CommunityProvider';
import communityApi from 'data/api/community';
import { PredefinedRole } from 'common/enums';
import TagInputField, { tagStringToPredefinedTag } from '../inputs/TagInputField/TagInputField';
import Tag, { TagIcon } from 'components/atoms/Tag/Tag';
import BotBadge from 'components/atoms/BotBadge/BotBadge';

type Props = {
  user: Omit<Models.User.Data, 'isFollowed' | 'isFollower'>;
  isFollowed: boolean;
  isFollower: boolean;
  showEditControls?: boolean;
  channelId?: string;
  hoveredMessageId?: string;
  showDeleteMsgButton?: boolean;
  otherSettingsOpen?: boolean;
  lockModal: ((lock: boolean) => void) | undefined;
  linksToProfile?: boolean;
  enableAdminOptions?: boolean;
};

const accountOrder: Record<Models.User.ProfileItemType, number> = {
  bot: 0,
  cg: 1,
  farcaster: 2,
  twitter: 3,
  lukso: 4,
};

const UserProfileV2: React.FC<Props> = (props) => {
  const { user, showEditControls } = props;
  const ownUser = useOwnUser();
  const commContext = useSafeCommunityContext();
  const premiumTier = useUserPremiumTier(user);
  const detailedData = useDetailledUserData(user.id);
  const { showSnackbar } = useSnackbarContext();
  const navigate = useNavigate();
  const isSelf = user.id === ownUser?.id;
  const cgAccount = useMemo(() => detailedData?.detailledProfiles.find(acc => acc.type === 'cg'), [detailedData?.detailledProfiles]);
  const userName = useMemo(() => getDisplayNameString(user), [user]);
  const { setCurrentPage, setIsOpen } = useUserSettingsContext();
  const { connectToUniversalProfile, isConnected: isLuksoConnected, hasExtension: hasUniversalProfileExtension } = useUniversalProfile();
  const enableLuksoRedirect = useRef<boolean>(false);
  const imageUploadRef = createRef<HTMLInputElement>();
  if (enableLuksoRedirect.current && isLuksoConnected) {
    enableLuksoRedirect.current = false;
    setCurrentPage('sign-with-universal-profile');
  }
  const userCommunityIds = useAsyncMemo(async () => {
    if (!user.id) return [];
    return userApi.getUserCommunityIds({ userId: user.id });
  }, [user.id]);

  const [selectedAccount, setSelectedAccount] = useState(user.displayAccount);
  const [isCreateCGMode, setIsCreateCGMode] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [cgUsername, setCgUsername] = useState(cgAccount?.displayName || '');
  const [cgUsernameError, setCgUsernameError] = useState('');
  const [cgBio, setCgBio] = useState(cgAccount?.extraData?.type === 'cg' ? cgAccount.extraData.description : '');
  const [cgLinks, setCgLinks] = useState<string[]>(cgAccount?.extraData?.type === 'cg' ? [cgAccount.extraData.homepage, ...cgAccount.extraData.links.map(link => link.url)] : [''])
  const [tags, setTags] = useState<string[]>(user.tags || []);
  const addAccountsDropdownRef = useRef<PopoverHandle>(null);
  const communityId = commContext.state === 'loaded' ? commContext.community.id : undefined;

  const fullTags = useMemo(() => tagStringToPredefinedTag(tags), [tags])

  if ((isEditMode || isCreateCGMode) && selectedAccount !== 'cg') {
    setIsCreateCGMode(false);
    setIsEditMode(false);
  }

  const setUsernameAndValidate = useCallback((username: string) => {
    setCgUsername(username);
    setCgUsernameError(validateTagTextInput(username, 15) || '');
  }, []);

  const updateDisplayAccount = useCallback(async () => {
    return await userApi.updateOwnData({ displayAccount: selectedAccount });
  }, [selectedAccount]);

  const updateCgData = useCallback(async () => {
    const [homepage, ...links] = cgLinks;
    try {
      if (isCreateCGMode) {
        if (cgUsername.length === 0) {
          showSnackbar({ type: 'warning', text: 'Please pick an username' });
          return;
        }

        await userApi.addUserAccount({
          type: 'cg',
          description: cgBio,
          displayName: cgUsername,
          homepage: homepage || '',
          links: links.map(link => ({ text: link, url: link }))
        });
        await userApi.updateOwnData({ tags });
      } else {
        await userApi.updateUserAccount({
          type: 'cg',
          description: cgBio,
          displayName: cgUsername,
          homepage: homepage || '',
          links: links.map(link => ({ text: link, url: link }))
        });
        await userApi.updateOwnData({ tags });
      }

      setIsCreateCGMode(false);
      setIsEditMode(false);
    } catch (e: any) {
      showSnackbar({ type: 'warning', text: `Something went wrong, code error: ${e.message}` });
    }
  }, [cgBio, cgLinks, cgUsername, isCreateCGMode, showSnackbar, tags]);

  const openLoadImagePopup = useCallback((ev: React.MouseEvent) => {
    if (isEditMode && imageUploadRef && imageUploadRef.current) {
      ev.stopPropagation();
      imageUploadRef.current.click();
    }
  }, [imageUploadRef, isEditMode])

  const handleImageChange = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    ev.stopPropagation();
    if (ev.target.files && ev.target.files.length === 1) {
      if (ev.target.files[0].size > config.IMAGE_UPLOAD_SIZE_LIMIT) {
        showSnackbar({ type: 'warning', text: errors.client.UPLOAD_SIZE_LIMIT });
      } else {
        // Read before awaiting: the input is reset on the next open.
        const file = ev.target.files[0];
        if (!await checkImageBeforeUpload(file)) return;
        try {
          await fileApi.uploadImage({ type: 'userProfileImage' }, file);
        } catch (err) {
          console.error(err);
          showSnackbar({
            type: 'warning',
            text: imageUploadErrorText(err, 'Could not upload your profile picture'),
          });
        }
      }
    }
  }

  const checkUsernameUniqueness = useCallback(async () => {
    if (cgUsername === cgAccount?.displayName) {
      setCgUsernameError('');
    } else if (cgUsername !== null) {
      const errorMessage = await userApi.isCgProfileNameAvailable({ displayName: cgUsername });
      if (!errorMessage) {
        setCgUsernameError('Username already exists, try something else');
        return;
      }
    }
  }, [cgAccount?.displayName, cgUsername]);

  const toggleFollow = useCallback(async () => {
    if (props.isFollowed) {
      await data.user.unfollow(props.user.id);
      showSnackbar({ type: 'info', text: `Stopped following ${userName}` });
    } else {
      await data.user.follow(props.user.id);
      showSnackbar({ type: 'info', text: `Following ${userName}` });
    }
  }, [props.isFollowed, props.user.id, showSnackbar, userName]);

  const onTwitterLogin = useCallback(async () => {
    try {
      await userApi.addUserAccount({ type: 'twitter' });
      setCurrentPage('profile');
    } catch (e) {
      console.error(e);
      showSnackbar({ type: 'warning', text: 'Failed to add account, please try again later' });
    }
  }, [setCurrentPage, showSnackbar]);
  const { attemptConnectTwitter, buttonDisabled } = useTwitterAuth(onTwitterLogin);

  const onConnectUniversalProfileClick = useCallback(() => {
    if (!hasUniversalProfileExtension) {
      showSnackbar({
        type: "warning",
        text: "Please install Universal Profile extension first",
      });
      window.open(
        "https://chrome.google.com/webstore/detail/universal-profiles/abpickdkkbnbcoepogfhkhennhfhehfn",
        "_blank",
        "noreferrer",
      );
      return;
    } else {
      if (!isLuksoConnected) {
        enableLuksoRedirect.current = true;
        connectToUniversalProfile();
      } else {
        setCurrentPage("sign-with-universal-profile");
      }
    }
  }, [connectToUniversalProfile, hasUniversalProfileExtension, isLuksoConnected, setCurrentPage, showSnackbar]);

  const goToProfile = useCallback(() => {
    navigate(getUrl({ type: 'user', user }));
    setIsOpen(false);
  }, [navigate, setIsOpen, user]);

  const sortedUserAccounts = useMemo(() => {
    function accValue(type: Models.User.ProfileItemType) {
      if (user.displayAccount === type) return 0;
      return accountOrder[type];
    }
    const accs = user.accounts.sort((a, b) => accValue(a.type) - accValue(b.type));
    if (isCreateCGMode) {
      const modifiedAccs = [...accs];
      modifiedAccs.push({
        type: 'cg',
        displayName: '',
        imageId: null
      });
      return modifiedAccs;
    }
    return accs;
  }, [isCreateCGMode, user.accounts, user.displayAccount]);

  const bioText = useMemo(() => {
    const account = detailedData?.detailledProfiles.find(profile => profile.type === user.displayAccount);
    switch (account?.extraData?.type) {
      case 'farcaster': return account.extraData.bio;
      case 'cg': return account.extraData.description;
      case 'bot': return account.extraData.description || '';
      default: return '';
    }
  }, [detailedData?.detailledProfiles, user.displayAccount]);

  const links = useMemo(() => {
    if (selectedAccount !== 'cg') return {
      homepage: getUserExternalLink(detailedData?.detailledProfiles || [], selectedAccount)
    };
    if (cgAccount?.extraData?.type !== 'cg') return {};
    return {
      homepage: cgAccount.extraData.homepage,
      links: cgAccount.extraData.links.map(link => link.url)
    }
  }, [cgAccount, detailedData?.detailledProfiles, selectedAccount]);

  const chipActions = useMemo(() => {
    const result: React.JSX.Element[] = [];
    if (!user.isBot && !isEditMode && isSelf && showEditControls && selectedAccount !== user.displayAccount) {
      result.push(<Button
        key='setAsMain'
        role='chip'
        text='Set as main profile'
        onClick={updateDisplayAccount}
      />);
    }
    if (!user.isBot && !isEditMode && isSelf && showEditControls && selectedAccount === 'cg') {
      result.push(<Button
        key='edit'
        role='chip'
        text='Edit'
        iconLeft={<PencilSimple className='w-4 h-4' weight='duotone' />}
        onClick={() => setIsEditMode(true)}
      />);
    }
    if (isEditMode) {
      result.push(<Button
        key='save'
        role='chip'
        text='Save changes'
        iconLeft={<CheckIcon className='w-4 h-4' />}
        onClick={updateCgData}
      />,
        <Button
          key='discard'
          role='chip'
          text='Discard'
          iconLeft={<XMarkIcon className='w-4 h-4' />}
          onClick={() => setIsEditMode(false)}
        />);
    }

    return result;
  }, [isEditMode, isSelf, selectedAccount, showEditControls, updateCgData, updateDisplayAccount, user.displayAccount, user.isBot]);

  const addAccountOptions = useMemo(() => {
    const result: React.JSX.Element[] = [];

    if (!user.accounts.find(acc => acc.type === 'cg')) {
      result.push(<ListItem
        title='Add Common Ground'
        key='Add Common Ground'
        iconRight={<ExternalIcon type='cg' className='w-5 h-5 cg-text-brand' />}
        onClick={() => {
          setIsCreateCGMode(true);
          setIsEditMode(true);
          setSelectedAccount('cg');
        }}
      />);
    }
    if (!user.accounts.find(acc => acc.type === 'farcaster')) {
      result.push(<ListItem
        title='Add Farcaster'
        key='Add Farcaster'
        iconRight={<ExternalIcon type='farcaster' className='w-5 h-5' />}
        onClick={() => {
          setIsOpen(true);
          setCurrentPage('sign-with-farcaster');
        }}
      />);
    }
    if (!user.accounts.find(acc => acc.type === 'twitter')) {
      result.push(<ListItem
        title='Add X (Twitter)'
        key='Add X (Twitter)'
        iconRight={<ExternalIcon type='x' className='w-5 h-5' />}
        disabled={buttonDisabled}
        onClick={attemptConnectTwitter}
      />);
    }
    if (!user.accounts.find(acc => acc.type === 'lukso')) {
      result.push(<ListItem
        title='Add Universal Profile'
        key='Add Universal Profile'
        iconRight={<ExternalIcon type='universalProfile' className='w-5 h-5' />}
        onClick={onConnectUniversalProfileClick}
      />);
    }

    return result;
  }, [attemptConnectTwitter, buttonDisabled, onConnectUniversalProfileClick, setCurrentPage, setIsOpen, user.accounts]);

  const roleIds = useAsyncMemo(async () => {
    if (!communityId) return;

    try {
      return await communityApi.getUserCommunityRoleIds({
        userId: user.id,
        communityId: communityId
      });
    } catch (e) {
      showSnackbar({ type: 'warning', text: 'Could not load user roles' });
    }
  }, [user.id, communityId]);

  const { roles, isAdmin } = useMemo(() => {
    if (commContext.state !== 'loaded') return {
      roles: [],
      isAdmin: false
    };
    const { rolesById } = commContext;
    const roles = roleIds?.map(roleId => rolesById.get(roleId));
    return {
      roles: roles?.map(role => role?.title).filter(title => !!title && title !== PredefinedRole.Admin) || [],
      isAdmin: roles?.some(role => role?.title === PredefinedRole.Admin)
    }
  }, [commContext, roleIds]);

  return (<div className='grid grid-flow-row gap-4 cg-text-main'>
    <div className='flex gap-2 justify-between'>
      <div className='flex gap-2'>
        {sortedUserAccounts.map(acc => <div
          className={`user-profile-acc-btn cursor-pointer p-2 cg-border-xl flex items-center justify-center h-9 w-9 ${acc.type === selectedAccount ? ' active' : ''}`}
          role='button'
          key={acc.type}
          onClick={() => setSelectedAccount(acc.type)}
        >
          <ExternalIcon type={acc.type === 'lukso' ? 'universalProfile' : acc.type} className='w-4 h-4 cg-text-brand' />
        </div>)}
        {isSelf && !user.isBot && addAccountOptions.length > 0 && <ScreenAwareDropdown
          ref={addAccountsDropdownRef}
          triggerContent={<div
            className={`user-profile-acc-btn cursor-pointer p-2 cg-border-xl flex items-center justify-center h-9 w-9`}
            role='button'
          >
            <UserCirclePlus weight='duotone' className='w-4 h-4' />
          </div>}
          items={addAccountOptions}
        />}
      </div>
      <UserProfileV2OtherOptions
        {...props}
        addAccountsDropdownRef={addAccountsDropdownRef}
        isSelf={isSelf}
        toggleFollow={toggleFollow}
        lockModal={props.lockModal}
      />

    </div>
    {chipActions.length > 0 && <div className='flex flex-wrap gap-2'>
      {chipActions}
    </div>}
    <div className={`flex p-2 cg-border-xl gap-4 cursor-pointer max-w-full overflow-hidden ${props.linksToProfile && !isEditMode ? ' cg-simple-hoverable cursor-pointer' : ''}`} onClick={!!props.linksToProfile && !isEditMode ? goToProfile : undefined}>
      <div className='relative'>
        <Jdenticon
          userId={user.id}
          predefinedSize='80'
          hideStatus
          floatingBorder
          accountType={selectedAccount}
          onClick={openLoadImagePopup}
        />
        {isEditMode && <input type="file" ref={imageUploadRef} onChange={handleImageChange} style={{ display: "none" }} accept={config.ACCEPTED_IMAGE_FORMATS} />}
        {premiumTier.type !== 'free' && <div className="absolute bottom-0 right-0 w-fit h-fit">
          <SupporterIcon type={premiumTier.type} size={24} redirectToSupporterPurchase />
        </div>}
      </div>
      <div className='flex flex-col justify-center flex-1 overflow-hidden gap-2'>
        {isEditMode ?
          <TextInputField
            value={cgUsername}
            onChange={setUsernameAndValidate}
            placeholder='Add a username'
            error={cgUsernameError}
            name='username'
            autoComplete='username'
            onBlur={checkUsernameUniqueness}
          /> : <h3 className='cg-text-main flex items-center gap-1'>{getDisplayName(user, false, selectedAccount)}{user.isBot && <BotBadge />}</h3>
        }
        <div className='flex gap-4 cg-text-secondary'>
          <div className='flex items-center gap-1'>
            <Users weight='duotone' className='w-4 h-4' />
            <span className='cg-text-md-500'>{user.followerCount}</span>
          </div>
          {/* <div className='flex items-center gap-1'>
            <Slideshow weight='duotone' className='w-4 h-4' />
            <span className='cg-text-md-500'>312</span>
          </div> */}
          <div className='flex items-center gap-1'>
            <HouseSimple weight='duotone' className='w-4 h-4' />
            <span className='cg-text-md-500'>{userCommunityIds?.length || 0}</span>
          </div>
        </div>
      </div>
    </div>
    {!isSelf && !user.isBot && <FollowButtons {...props} toggleFollow={toggleFollow} />}
    {(isEditMode || !!bioText?.length) && <div className='cg-text-md-400 cg-text-secondary'>
      {isEditMode ? <TextAreaField
        value={cgBio}
        onChange={setCgBio}
        placeholder='A little bit about me...'
        rows={4}
      /> : bioText}
    </div>}

    {isEditMode && <TagInputField
      tags={tags}
      onTagsChange={setTags}
      placeholder='Add tags to your profile'
    />}
    {!isEditMode && fullTags.length > 0 && <div className='flex flex-wrap gap-2'>
      {fullTags.map(tag => <Tag
        variant='tag'
        iconLeft={<TagIcon tag={tag} />}
        key={tag.name}
        label={tag.name}
      />)}
    </div>}

    {(isEditMode || !!links.homepage || !!links.links?.length) && <div className='flex flex-wrap gap-2 w-full overflow-hidden'>
      {!isEditMode ? <>
        {!!links.homepage && <SimpleLink className='user-profile-link' href={links.homepage} skipInternalLinkProcessing>
          <div className='cg-bg-subtle cg-border-xl flex items-center py-1 px-1.5 gap-1 cg-text-secondary cg-text-sm-500 w-fit max-w-full'>
            <Link className='w-5 h-5' weight='duotone' />
            <span className='overflow-hidden text-ellipsis flex-1'>{links.homepage}</span>
          </div>
        </SimpleLink>}
        {links.links?.map(link => <SimpleLink className='user-profile-link' href={link} skipInternalLinkProcessing key={link}>
          <div className='cg-bg-subtle cg-border-xl flex items-center py-1 px-1.5 gap-1 cg-text-secondary cg-text-sm-500 w-fit max-w-full' key={link}>
            <Link className='w-5 h-5' weight='duotone' />
            <span className='overflow-hidden text-ellipsis flex-1'>{link}</span>
          </div>
        </SimpleLink>)}
      </> : <>
        <MultiEntryField
          limit={3}
          disallowEmpty={false}
          entries={cgLinks}
          setEntries={setCgLinks}
          newEntryBtnText='Link'
        />
      </>}
    </div>}
    {commContext.state === 'loaded' && roles.length > 0 && <>
      <div className="cg-separator w-full" />
      <div className="flex flex-col gap-2 cg-text-secondary">
        <span className="cg-text-lg-500">Roles in {commContext.community.title}</span>
        <div className="flex flex-wrap gap-2">
          {isAdmin && <div className="flex items-center gap-1 cg-text-brand py-1 px-1.5 cg-bg-subtle cg-border-xl cg-text-md-400"><Asterisk weight='duotone' className='w-5 h-5' /> Admin</div>}
          {roles.map(role => <div className="py-1 px-1.5 cg-bg-subtle cg-border-xl cg-text-md-400" key={role}>{role}</div>)}
        </div>
      </div>
    </>}
  </div>);
}

const FollowButtons: React.FC<Props & {
  toggleFollow: () => void;
}> = (props) => {
  const { navigateToChatOrCreateNewChat } = useChats();

  const msgButton = <Button
    className='w-full py-2'
    iconLeft={<ChatTeardrop weight='duotone' className="w-5 h-5" />}
    text='Message'
    role="primary"
    disabled={!props.isFollowed || !props.isFollower}
    onClick={() => navigateToChatOrCreateNewChat(props.user.id)}
  />;

  const getFollowBtnText = () => {
    if (!props.isFollowed) return 'Follow';
    else if (props.isFollowed && props.isFollower) return <>Following <span className='cg-text-secondary'> Friend</span></>;
    else return 'Following';
  }

  const getFollowBtnIcon = () => {
    if (!props.isFollowed) return <UserCirclePlus className='w-5 h-5' weight='duotone' />;
    else if (props.isFollowed && props.isFollower) return <Handshake className='w-5 h-5' weight='duotone' />
    else return <UserCircleMinus className='w-5 h-5' weight='duotone' />;
  }

  return <div className='flex items-center w-full gap-2'>
    <div className='flex-1'>
      <Button
        text={getFollowBtnText()}
        iconLeft={getFollowBtnIcon()}
        role={!props.isFollowed ? 'primary' : 'secondary'}
        className='w-full py-2'
        onClick={props.toggleFollow}
      />
    </div>
    {props.isFollower && props.isFollowed ? <div className='flex-1'>{msgButton}</div> :
      <Tooltip
        placement="bottom"
        triggerClassName="flex-1"
        triggerContent={msgButton}
        tooltipContent="Only users who follow each other can send each other messages"
        offset={4}
      />
    }
  </div>;
}

export default React.memo(UserProfileV2);
