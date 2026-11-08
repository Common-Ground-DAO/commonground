// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useOwnUser } from 'context/OwnDataProvider';
import { useSignedUrl } from 'hooks/useSignedUrl';
import { validateTagTextInput } from 'common/validators';
import ProfilePhotoField from 'components/molecules/inputs/ProfilePhotoField/ProfilePhotoField';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import TextAreaField from 'components/molecules/inputs/TextAreaField/TextAreaField';
import userApi from 'data/api/user';
import { useSnackbarContext } from 'context/SnackbarContext';
import fileApi from 'data/api/file';
import { imageUploadErrorText, notifyIfImageRejected } from 'moderation/imageUploadError';
import Button from 'components/atoms/Button/Button';
import _ from 'lodash';
import ToggleText from 'components/molecules/ToggleText/ToggleText';
import { getAccountIcon } from '../AccountsPage/AccountsPage';
import CircleLogo from "components/atoms/icons/misc/Logo/logo.svg?react";
import { getDisplayName } from '../../../../util';

type Props = {
};

const ProfilePage: React.FC<Props> = (props) => {
  const ownUser = useOwnUser();
  const { showSnackbar } = useSnackbarContext();
  const account = ownUser?.accounts?.find(acc => acc.type === 'cg');
  const extraData = account?.extraData as Models.User.UserAccountExtraData_CG | null | undefined;
  const imageUrl = useSignedUrl(account?.imageId);

  const [username, setUsername] = useState(account?.displayName || null);
  const [usernameError, setUsernameError] = useState('');
  const [bio, setBio] = useState(extraData?.description || '');
  const [userPhoto, setUserPhoto] = useState<File | undefined>();
  const [homepage, setHomepage] = useState(extraData?.homepage || '');
  const [links, setLinks] = useState<Common.Link[]>(extraData?.links || []);
  const [displayAccount, setDisplayAccount] = useState<Models.User.ProfileItemType | undefined>(ownUser?.displayAccount);
  const hasMoreThanOneProfile = ((ownUser?.accounts?.length || 0) + (username !== null ? 1 : 0)) > 1;

  const setUsernameAndValidate = useCallback((username: string) => {
    setUsername(username);
    setUsernameError(validateTagTextInput(username, 15) || '');
  }, []);

  const checkUsernameUniqueness = useCallback(async () => {
    if (username === account?.displayName) {
      setUsernameError('');
    } else if (username !== null) {
      const errorMessage = await userApi.isCgProfileNameAvailable({ displayName: username });
      if (!errorMessage) {
        setUsernameError('Username already exists, try something else');
        return;
      }
    }
  }, [account?.displayName, username]);

  // Keep data up-to-date to save on-close
  const requestInfo = useRef<{
    username: string | null;
    bio: string;
    userPhoto: File | undefined;
    homepage: string;
    links: Common.Link[];
    displayAccount: Models.User.ProfileItemType | undefined;
  }>(undefined);

  useEffect(() => {
    requestInfo.current = {
      username,
      bio,
      userPhoto,
      homepage,
      links,
      displayAccount
    }
  }, [username, bio, userPhoto, homepage, links, displayAccount]);

  useEffect(() => {
    const onSubmit = async () => {
      if (!requestInfo.current) return;

      const { username, userPhoto, links, displayAccount, bio, homepage } = requestInfo.current;

      try {
        const profileRequest: API.User.updateUserAccount.Request = { type: 'cg' };
        const userDataRequest: API.User.updateOwnData.Request = {};
        if (username && username !== account?.displayName) profileRequest.displayName = username;
        if (bio !== extraData?.description) profileRequest.description = bio;
        if (homepage !== extraData?.homepage) profileRequest.homepage = homepage;
        if (displayAccount !== ownUser?.displayAccount) userDataRequest.displayAccount = displayAccount;
        if (!_.isEqual(links, extraData?.links)) {
          profileRequest.links = links.map(link => ({ url: link.url, text: link.url }));
        };

        let hasCgAccount = !!account;
        const hasOwnDataUpdate = Object.keys(userDataRequest).length > 0;
        const hasProfileUpdate = Object.keys(profileRequest).length > 1;

        if (hasProfileUpdate || !!userPhoto) {
          if (!hasCgAccount) {
            if (!profileRequest.displayName) {
              showSnackbar({ type: 'warning', text: 'Cannot create CG profile without a name' });
              return;
            }
            const request: API.User.addUserAccount.Request = {
              ...(profileRequest as typeof profileRequest & { displayName: string }),
              type: 'cg',
            };
            await userApi.addUserAccount(request);
            hasCgAccount = true;
          }
          else if (hasProfileUpdate) {
            await userApi.updateUserAccount(profileRequest);
          }
        }

        if (!hasCgAccount && userDataRequest.displayAccount === 'cg') {
          showSnackbar({ type: 'warning', text: 'Cannot set CG profile without a CG account' });
          return;
        }

        if (hasOwnDataUpdate) await userApi.updateOwnData(userDataRequest);

        let photoUpdateSuccess = true;
        let photoUpdateError: string | undefined;
        if (userPhoto) {
          try {
            await fileApi.uploadImage({ type: 'userProfileImage' }, userPhoto);
          }
          catch (e) {
            photoUpdateSuccess = false;
            // A rejected image already has the shared modal up; leaving
            // `photoUpdateError` unset suppresses the duplicate snackbar
            // without claiming the profile update fully succeeded.
            if (!notifyIfImageRejected(e)) photoUpdateError = imageUploadErrorText(e, 'Image update failed');
          }
        }

        if (hasOwnDataUpdate || hasProfileUpdate || userPhoto) {
          if (!photoUpdateSuccess) {
            if (photoUpdateError) showSnackbar({ type: 'warning', text: photoUpdateError });
          }
          else {
            showSnackbar({ type: 'info', text: 'Profile updated' });
          }
        }
      } catch (e) {
        console.error(e);
        showSnackbar({ type: 'warning', text: 'Failed to update user info' });
      }
    };

    return () => {
      onSubmit();
    };
  }, [account?.displayName, extraData?.description, ownUser?.displayAccount, extraData?.homepage, extraData?.links, showSnackbar]);

  // Enable autosave
  return (<div className='flex flex-col px-4 gap-4 cg-text-main'>
    <ProfilePhotoField
      currentFile={userPhoto}
      setFile={setUserPhoto}
      originalFileUrl={imageUrl}
    />
    <div className='flex flex-col gap-2'>
      <span className='cg-text-main cg-text-lg-500'>Account name</span>
      {ownUser?.accounts?.filter(acc => acc.type !== "cg").map(acc => <ToggleText
        key={acc.type}
        title=''
        description=''
        icon={getAccountIcon(acc.type)}
        active={hasMoreThanOneProfile && displayAccount === acc.type}
        onToggle={() => setDisplayAccount(acc.type)}
        customElement={getDisplayName(ownUser, true, acc.type)}
        hideToggle={!hasMoreThanOneProfile}
      />)}
      {username === null && <Button
        className='self-center'
        role='chip'
        text='Add a CG username'
        onClick={() => setUsername('')}
      />}
      {username !== null && <ToggleText
        title=''
        description=''
        icon={<CircleLogo className='self-center w-6 h-6' />}
        active={hasMoreThanOneProfile && displayAccount === 'cg'}
        onToggle={() => setDisplayAccount('cg')}
        customElement={<TextInputField
          value={username || ''}
          onChange={setUsernameAndValidate}
          placeholder='Add a username'
          error={usernameError}
          name='username'
          autoComplete='username'
          onBlur={checkUsernameUniqueness}
        />}
        hideToggle={!hasMoreThanOneProfile}
      />}
    </div>

    <TextAreaField
      label='Bio'
      value={bio}
      onChange={setBio}
      placeholder='A little bit about me...'
      rows={4}
    />

    <div className='flex flex-col gap-2'>
      <span className='cg-text-main cg-text-lg-500'>Links</span>
      <TextInputField
        value={homepage}
        onChange={setHomepage}
        placeholder='Homepage'
      />
      {links.map((link, index) => <div className='flex items-center gap-2' key={index}>
        <TextInputField
          value={link.url}
          placeholder='Link'
          onChange={url => {
            setLinks(oldLinks => {
              const newLinks = [...oldLinks];
              newLinks[index].url = url;
              return newLinks;
            });
          }}
        />
        <Button
          role='chip'
          text='X'
          onClick={() => {
            setLinks(oldLinks => {
              const newLinks = [...oldLinks];
              newLinks.splice(index, 1);
              return newLinks;
            });
          }}
        />
      </div>)}
    </div>

    <div>
      <Button
        role='chip'
        text='Add Link'
        className='cg-text-md-500'
        onClick={() => {
          setLinks(oldLinks => ([...oldLinks, { url: '', text: '' }]));
        }}
      />
    </div>
  </div>);
}

export default React.memo(ProfilePage);