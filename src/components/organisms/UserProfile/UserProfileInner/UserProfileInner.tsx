// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./UserProfileInner.css";
import { createRef, useCallback, useEffect, useMemo, useState } from "react";
import { useWindowSizeContext } from "../../../../context/WindowSizeProvider";
import userApi from "data/api/user";
import { useMultipleCommunityListViews } from "context/CommunityListViewProvider";
import UserProfileV2 from "components/molecules/UserProfileV2/UserProfileV2";
import LargeCommunityCard from "components/molecules/CommunityCard/LargeCommunityCard";
import { Props } from "components/organisms/UserProfileModal/UserProfileModal";
import { useMultipleUserData, useUserData } from "context/UserDataProvider";
import Button from "components/atoms/Button/Button";
import { ArrowLeftIcon } from "@heroicons/react/20/solid";
import { ArrowsOutSimple } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { getUrl } from "common/util";
import Jdenticon from "components/atoms/Jdenticon/Jdenticon";
import { getDisplayName } from "../../../../util";
import UserTooltip from "components/organisms/UserTooltip/UserTooltip";
import { useOwnUser } from "context/OwnDataProvider";
import config from "common/config";
import { useSnackbarContext } from "context/SnackbarContext";
import errors from "common/errors";
import fileApi from "data/api/file";
import { checkImageBeforeUpload } from "moderation/checkImageBeforeUpload";
import { isUploadTemporarilyRefused, notifyIfImageRejected } from "moderation/imageUploadError";
import { useSignedUrl } from "hooks/useSignedUrl";
import UserPosts from "./UserPosts";

export default function UserProfileInner(props: Props & {
  trayMode?: boolean;
  closeTray?: () => void;
  goBack?: () => void;
  lockTray?: (lock: boolean) => void;
}) {
  const {
    userId,
    trayMode,
    closeTray,
    goBack
  } = props;
  const { isMobile } = useWindowSizeContext();
  const { showSnackbar } = useSnackbarContext();
  const ownUser = useOwnUser();
  const navigate = useNavigate();
  const [userCommunityIds, setUserCommunityIds] = useState<string[]>([]);
  const user = useUserData(userId);
  const isSelf = userId === ownUser?.id;
  const bannerImageUrl = useSignedUrl(isSelf ? ownUser?.bannerImageId : user?.bannerImageId);
  const inputRef = createRef<HTMLInputElement>();

  const communitiesById = useMultipleCommunityListViews(userCommunityIds);
  const communities = useMemo(() => {
    return userCommunityIds.map(id => communitiesById[id]).filter(c => !!c);
  }, [communitiesById, userCommunityIds]);

  useEffect(() => {
    if (!!userId) {
      userApi.getUserCommunityIds({ userId }).then(ids => { setUserCommunityIds(ids) });
    }
  }, [userId]);

  const goToProfile = useCallback(() => {
    if (user) navigate(getUrl({ type: 'user', user }));
    closeTray?.();
  }, [closeTray, navigate, user]);

  const handleImageChange = useCallback(async (ev: React.ChangeEvent<HTMLInputElement>) => {
    // Read the file and clear the input *before* any await: `ev.target` is not
    // safe to touch afterwards, and leaving the value set would make re-picking
    // the same file after a "Cancel" in the pre-check dialog fire no change
    // event at all.
    const input = ev.target;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > config.IMAGE_UPLOAD_SIZE_LIMIT) {
      showSnackbar({ type: 'warning', text: errors.client.UPLOAD_SIZE_LIMIT });
      return;
    }

    if (!await checkImageBeforeUpload(file)) return;

    try {
      await fileApi.uploadImage({ type: 'userBannerImage' }, file);
    } catch (e: any) {
      if (!notifyIfImageRejected(e)) {
        showSnackbar({
          type: 'warning',
          // a rate-limited or shed upload is a plain "try again", not a code
          // error the user should be shown
          text: isUploadTemporarilyRefused(e)
            ? errors.client.UPLOAD_BUSY
            : `Something went wrong, code error: ${e.message}`,
        });
      }
    }
  }, [showSnackbar]);

  const onBannerClick = useCallback(() => {
    if (!isSelf) return;
    inputRef.current?.click();
  }, [inputRef, isSelf]);

  return (<>
    {trayMode && <div className={`flex justify-between absolute top-4 z-10 ${isMobile ? 'left-4 right-4' : 'left-8 right-8'}`}>
      <Button
        role="secondary"
        iconLeft={<ArrowLeftIcon className="w-5 h-5" />}
        onClick={goBack}
        className="cg-circular tray-btn"
      />
      <Button
        role="secondary"
        iconLeft={<ArrowsOutSimple weight="duotone" className="w-5 h-5" />}
        text='Full Profile'
        onClick={goToProfile}
        className="cg-circular tray-btn"
      />
    </div>}
    <div className={`user-profile-inner cg-text-main ${isMobile ? 'mobile' : 'desktop-tray'}${trayMode ? ' tray-mode' : ''}`}>
      <div className={`user-profile-banner flex flex-col items-center justify-center${!trayMode ? ' cg-border-l' : ''} ${isSelf ? ' cursor-pointer' : ''}${!!bannerImageUrl ? ' has-image' : ' no-image'}`} style={{ backgroundImage: `url(${bannerImageUrl})` }} onClick={onBannerClick}>
        {isSelf && !trayMode && <div className={`flex flex-col items-center justify-center gap-4 user-profile-banner-actions cg-border-l p-4${!!bannerImageUrl ? ' cg-content-stack' : ''}`}>
          <input type="file" ref={inputRef} onChange={handleImageChange} style={{ display: "none" }} accept={config.ACCEPTED_IMAGE_FORMATS} />
          <Button
            role="chip"
            text={!!bannerImageUrl ? 'Change profile banner' : 'Add profile banner'}
          />
          <span className="cg-text-md-400 cg-text-secondary">Optional (800 x 320px)</span>
        </div>}
      </div>
      <div className="user-profile-empty-space" />
      <div className="user-profile-content flex flex-col gap-6">
        <div className="cg-content-stack p-4 cg-border-xxl">
          {user && <UserProfileV2
            user={user}
            isFollowed={user.isFollowed}
            isFollower={user.isFollower}
            channelId={props.channelId}
            showDeleteMsgButton={props.showDeleteButton}
            hoveredMessageId={props.hoveredMessageId}
            otherSettingsOpen={props.defaultView === 'admin'}
            lockModal={props.lockTray}
            linksToProfile
            enableAdminOptions
          />}
        </div>

        {isSelf && <div className='community-input flex gap-4 p-2 items-center cursor-pointer cg-border-xl self-center' onClick={() => navigate(getUrl({ type: 'create-user-post' }))}>
          {ownUser?.id && <Jdenticon
            userId={ownUser?.id}
            predefinedSize='40'
            hideStatus
          />}
          <div className='flex-1'>
            <span className='cg-text-lg-400 cg-text-main'>Write something...</span>
          </div>
        </div>}

        <UserPosts userId={userId} />

        <ProfileFriends userId={userId} />

        {/* <div className="flex flex-col gap-4">
        <div>
          <span>Friends</span>
          <span>312</span>
        </div>

        <div>
          friends
        </div>

        <div>
          <Button
            role="secondary"
            text='More'
          />
        </div>
      </div> */}

        <div className="flex flex-col gap-4">
          <div className="flex gap-1">
            <h3>Communities</h3>
            <h3 className="cg-text-secondary">{communities.length}</h3>
          </div>

          <div className={`grid ${isMobile ? 'grid-cols-1 gap-4' : 'grid-cols-2 gap-2'}`}>
            {communities.map(community => <LargeCommunityCard
              key={community.id}
              community={community}
            />)}
          </div>
        </div>
      </div>
    </div>
  </>);
}

const INITIAL_FRIEND_LIMIT = 6;
const FRIEND_LIMIT = 15;

const ProfileFriends: React.FC<{ userId: string }> = (props) => {
  const { userId } = props;
  const [displayType, setDisplayType] = useState<'Friends' | 'Followers' | 'Following'>('Friends');
  const [users, setUsers] = useState<{
    userId: string;
    createdAt: string;
  }[]>([]);
  const [isDone, setDone] = useState(false);
  const userData = useMultipleUserData(users.map(f => f.userId));

  useEffect(() => {
    if (!userId) return;
    let usersPromise: Promise<{ userId: string, createdAt: string }[]>;
    if (displayType === 'Friends') {
      usersPromise = userApi.getFriends({ userId, limit: INITIAL_FRIEND_LIMIT, offset: 0 });
    }
    else if (displayType === 'Followers') {
      usersPromise = userApi.getFollowers({ userId, limit: INITIAL_FRIEND_LIMIT, offset: 0 });
    }
    else if (displayType === 'Following') {
      usersPromise = userApi.getFollowing({ userId, limit: INITIAL_FRIEND_LIMIT, offset: 0 });
    }
    usersPromise!.then((newUsers) => {
      if (newUsers.length !== INITIAL_FRIEND_LIMIT) setDone(true);
      setUsers(newUsers);
    });
  }, [userId, displayType]);

  const onClickMore = useCallback(() => {
    let usersPromise: Promise<{ userId: string, createdAt: string }[]>;
    if (displayType === 'Friends') {
      usersPromise = userApi.getFriends({ userId, limit: FRIEND_LIMIT, offset: users.length });
    }
    else if (displayType === 'Followers') {
      usersPromise = userApi.getFollowers({ userId, limit: FRIEND_LIMIT, offset: users.length });
    }
    else if (displayType === 'Following') {
      usersPromise = userApi.getFollowing({ userId, limit: FRIEND_LIMIT, offset: users.length });
    }
    usersPromise!.then((newUsers) => {
      if (newUsers.length !== FRIEND_LIMIT) setDone(true);
      setUsers(users => [...users, ...newUsers]);
    });
  }, [users, userId, displayType]);

  return <div className="flex flex-col gap-8">
    <div className="flex gap-4">
      <div className={`${displayType === 'Friends' ? 'cg-text-main' : 'cg-text-secondary cursor-pointer'}`} onClick={() => setDisplayType('Friends')}><h3>Friends</h3></div>
      <div className={`${displayType === 'Followers' ? 'cg-text-main' : 'cg-text-secondary cursor-pointer'}`} onClick={() => setDisplayType('Followers')}><h3>Followers</h3></div>
      <div className={`${displayType === 'Following' ? 'cg-text-main' : 'cg-text-secondary cursor-pointer'}`} onClick={() => setDisplayType('Following')}><h3>Following</h3></div>
    </div>
    <div className="grid grid-cols-3 gap-x-2 gap-y-4">
      {users.map(friend => <UserTooltip
        key={friend.userId}
        userId={friend.userId}
        isMessageTooltip={false}
        triggerClassName="cursor-pointer"
      >
        <div className="flex flex-col gap-2 items-center justify-center cg-text-lg-500">
          <Jdenticon
            userId={friend.userId}
            hideStatus
            predefinedSize="80"
            floatingBorder
          />
          {userData[friend.userId] && getDisplayName(userData[friend.userId])}
        </div>
      </UserTooltip>)}
    </div>
    {!isDone && <div>
      <Button
        role="secondary"
        text='More'
        onClick={onClickMore}
      />
    </div>}
  </div>
}