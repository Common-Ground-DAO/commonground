// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import './SetupProfile.css';
import Button from 'components/atoms/Button/Button';
import { validateTagTextInput } from 'common/validators';
import userApi from 'data/api/user';
import ProfilePhotoField from 'components/molecules/inputs/ProfilePhotoField/ProfilePhotoField';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import TextAreaField from 'components/molecules/inputs/TextAreaField/TextAreaField';
import XIcon from '../../../atoms/icons/24/X.svg?react';
import LuksoIcon from '../../../atoms/icons/24/Lukso.svg?react';
import { useTwitterAuth } from 'hooks/useTwitterAuth';
import ReCAPTCHA from 'react-google-recaptcha';
import AltchaWidget from 'components/molecules/AltchaWidget/AltchaWidget';
import config from 'common/config';
import { useDarkModeContext } from 'context/DarkModeProvider';
import errors from 'common/errors';
import data from 'data';
import fileApi from 'data/api/file';
import { isImageContentRejected } from 'moderation/imageUploadError';
import { UniversalProfileStatus, UniversalProfileSignButton } from '../UniversalProfileSign/UniversalProfileSign';
import { useUniversalProfile } from 'context/UniversalProfileProvider';
import { useUserOnboardingContext } from 'context/UserOnboarding';
import { useSnackbarContext } from 'context/SnackbarContext';
import { CAPTCHA_MISCONFIGURED_TEXT, useCaptchaProvider } from 'context/CaptchaContext';

type ButtonProps = {
  buttonState: { loading: boolean; disabled: boolean; clicked: boolean; };
  setButtonState: React.Dispatch<React.SetStateAction<{ loading: boolean; disabled: boolean; clicked: boolean; }>>;
};

type Props = ButtonProps & {
  createFinished: () => void;
  createUserData: Omit<API.User.createUser.Request, 'device' | 'recaptchaToken'>;
  setCreateUserData: React.Dispatch<React.SetStateAction<Omit<API.User.createUser.Request, 'device' | 'recaptchaToken'>>>;
  twitterData?: API.Twitter.finishLogin.Response;
  luksoData?: API.Lukso.PrepareLuksoAction.Response;
  attemptTwitterLogin: (data: API.Twitter.finishLogin.Response, noClearOrNavigate?: boolean) => Promise<void>;
  luksoSignatureFinished: (data: API.Lukso.PrepareLuksoAction.Request) => Promise<void>;
  luksoReadyForLoginOverride: () => void;
  luksoReadyForCreationOverride?: () => void;
};

export const CreateUserStatus: React.FC<Props> = (props) => {
  const { createFinished, createUserData, setCreateUserData, twitterData, luksoData, buttonState, setButtonState, attemptTwitterLogin, luksoSignatureFinished, luksoReadyForLoginOverride, luksoReadyForCreationOverride } = props;
  const [usernameError, setUsernameError] = useState('');
  const [userPhoto, setUserPhoto] = useState<File | undefined>();
  const [genericError, setGenericError] = useState<string>('');
  const { showSnackbar } = useSnackbarContext();
  const { provider: captchaProvider, resolved: captchaResolved, misconfigured: captchaMisconfigured } = useCaptchaProvider();
  // dev skips captcha server-side, "off" is an explicit opt-out; both pre-fill
  // a placeholder token so the create button is not blocked.
  const [recaptchaToken, setRecaptchaToken] = useState<string>(config.DEPLOYMENT === 'dev' || config.CAPTCHA_PROVIDER === 'off' ? 'stub' : '');
  const [selectedProfile, setSelectedProfile] = useState<Models.User.ProfileItemType>(createUserData.displayAccount);
  const { connectToUniversalProfile, hasExtension: hasUniversalProfileExtension, isConnected: isUniversalProfileConnected } = useUniversalProfile();
  const mode = useDarkModeContext();
  const {
    profileLockedIn,
    setProfileLockedIn,
    farcasterData,
  } = useUserOnboardingContext();
  const { attemptConnectTwitter, buttonDisabled: twitterButtonDisabled } = useTwitterAuth(attemptTwitterLogin);
  const [farcasterImageUrl, setFarcasterImageUrl] = useState<string | undefined>();

  // the backend's provider may differ from the initial hint: adopt or drop the
  // placeholder token accordingly once it answered
  useEffect(() => {
    if (config.DEPLOYMENT === 'dev' || !captchaResolved) return;
    if (captchaProvider === 'off') setRecaptchaToken('stub');
    else setRecaptchaToken(token => token === 'stub' ? '' : token);
  }, [captchaProvider, captchaResolved]);

  useEffect(() => {
    if (!!farcasterData && !!farcasterData.imageId) {
      let mounted = true;
      fileApi.getSignedUrls({ objectIds: [farcasterData.imageId] }).then((urls) => {
        if (mounted) {
          setFarcasterImageUrl(urls[0]?.url || undefined);
        }
      });
      return () => {
        mounted = false;
      };
    }
    else {
      setFarcasterImageUrl(undefined);
    }
  }, [farcasterData, farcasterData?.imageId]);

  // because of step pre-loading, selectedProfile will be initialized with 'cg' no matter what.
  useEffect(() => {
    if (selectedProfile !== createUserData.displayAccount) setSelectedProfile(createUserData.displayAccount);
  // only set if createUserData changed externally
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createUserData.displayAccount]);

  useEffect(() => {
    if (!profileLockedIn && (
      (!!luksoData && luksoData.universalProfileValid) ||
      !!twitterData ||
      !!farcasterData
    )) {
      setProfileLockedIn(true);
    }
  }, [luksoData, profileLockedIn, setProfileLockedIn, twitterData, farcasterData]);

  const updateCgProfileData = useCallback((
    newData: Partial<Omit<Models.User.ProfileItemWithDetails & { type: 'cg' }, 'extraData'>> & { extraData?: Partial<Models.User.UserAccountExtraData_CG> },
  ) => {
    setCreateUserData(data => {
      const existing = data.useCgProfile;
      return ({
        ...data,
        displayAccount: 'cg',
        useCgProfile: {
          type: 'cg',
          displayName: newData.displayName !== undefined ? newData.displayName : existing?.displayName || '',
          imageId: newData.imageId || existing?.imageId || null,
          extraData: {
            type: 'cg',
            description: newData.extraData?.description !== undefined ? newData.extraData.description : existing?.extraData?.description || '',
            homepage: newData.extraData?.homepage !== undefined ? newData.extraData.homepage : existing?.extraData?.homepage || '',
            links: newData.extraData?.links || existing?.extraData?.links || [],
          },
        },
      });
    });
  }, [setCreateUserData]);

  const setUsernameAndValidate = useCallback((username: string) => {
    updateCgProfileData({ displayName: username });
    setUsernameError(validateTagTextInput(username, 15) || '');
  }, [updateCgProfileData]);

  const onSubmit = useCallback(async () => {
    let _usernameError: string | undefined;
    let _genericError: string | undefined;
    if (createUserData.useCgProfile) {
      const { displayName } = createUserData.useCgProfile;
      try {
        if (displayName === '') {
          _usernameError = 'Please pick a name.';
        }
        else {
          const isAvailable = await userApi.isCgProfileNameAvailable({ displayName });
          if (!isAvailable) {
            _usernameError = 'This name is already taken, please pick a different one.';
          }
        }
      } catch (e) {
        if (e instanceof Error) {
          if (e.message === errors.server.VALIDATION) {
            _usernameError = 'This name is not valid. Allowed are 3-30 characters, letters, numbers, - and _.';
          }
        }
        if (!_usernameError) {
          _usernameError = 'Cannot verify username, try again later.';
        }
      }
    }

    if (createUserData.useLuksoCredentials) {
      if (!luksoData) {
        _genericError = 'Please connect your Lukso profile.';
      }
      else if (!luksoData.universalProfileValid) {
        _genericError = 'This Lukso profile is already in use.';
      }
    }

    if (createUserData.useTwitterCredentials) {
      if (!twitterData) {
        _genericError = 'Please connect your Twitter profile.';
      }
    }

    if (createUserData.usePreparedFarcaster) {
      if (!farcasterData) {
        _genericError = 'Please connect your Farcaster profile.';
      }
    }

    if (!createUserData.useCgProfile && !createUserData.useLuksoCredentials && !createUserData.useTwitterCredentials && !createUserData.usePreparedFarcaster) {
      _genericError = 'Please select a profile to use.';
    }

    if (_usernameError || _genericError) {
      setUsernameError(_usernameError || '');
      setGenericError(_genericError || '');
      setButtonState(oldState => ({ ...oldState, loading: false }));
      return;
    }

    if (!profileLockedIn) {
      setProfileLockedIn(true);
    }
    else {
      try {
        await data.user.createUser({ ...createUserData, recaptchaToken });
        if (userPhoto && createUserData.useCgProfile) {
          await fileApi.uploadImage({ type: 'userProfileImage' }, userPhoto).catch(e => {
            // The account already exists at this point, so onboarding has to
            // continue: keeping the user on this panel would only offer them a
            // "create account" button that can no longer succeed. That rules
            // out `setGenericError` — `createFinished()` below slides this
            // panel off screen in the same render, so anything rendered inside
            // it is never seen. A snackbar outlives the step change.
            console.error("Error uploading user image", e);
            if (isImageContentRejected(e)) {
              showSnackbar({ type: 'warning', text: errors.client.IMAGE_CONTENT_REJECTED, durationSeconds: 10 });
            }
          });
        }
        createFinished();
      } catch (e: any) {
        if (e instanceof Error && e.message === errors.server.RATE_LIMIT_EXCEEDED) {
          setGenericError('You cannot create more accounts from this IP address right now.');
        } else {
          setGenericError('Something went wrong, please try again');
        }
      }
    }
    setButtonState(oldState => ({ ...oldState, loading: false }));
  }, [createUserData, profileLockedIn, setButtonState, luksoData, twitterData, farcasterData, setProfileLockedIn, recaptchaToken, userPhoto, createFinished, showSnackbar]);

  useEffect(() => {
    if (buttonState.clicked) {
      setButtonState(oldState => ({ ...oldState, clicked: false, loading: true }));
      onSubmit();
    }
  }, [buttonState.clicked, onSubmit, setButtonState]);

  const userPhotoFileUrl = useMemo(() => userPhoto ? URL.createObjectURL(userPhoto) : null, [userPhoto]);
  const profile = useMemo(() => {
    if (!profileLockedIn) return null;
    let profile: React.ReactNode | null = null;
    if (twitterData && createUserData.useTwitterCredentials) {
      if (selectedProfile === 'twitter') profile = (
        <div key="twitter-profile" className="splash-create-profile-profile">
          {twitterData.profileImageUrl && <div className='profile-photo-preview' style={{ backgroundImage: `url(${twitterData.profileImageUrl})` }} />}
          <div className='cg-heading-3'>@{twitterData.username}</div>
          <div className='cg-text-lg-400'>{twitterData.description}</div>
          <div className='cg-text-lg-400'>{twitterData.homepage}</div>
        </div>
      );
    }
    if (luksoData && createUserData.useLuksoCredentials) {
      if (selectedProfile === 'lukso') profile = (
        <div key="lukso-profile" className="splash-create-profile-profile">
          {luksoData.profileImageUrl && <div className='profile-photo-preview' style={{ backgroundImage: `url(${luksoData.profileImageUrl.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${luksoData.profileImageUrl.split('ipfs://').pop()}` : luksoData.profileImageUrl})` }} />}
          <div className='cg-heading-3'>{luksoData.username}</div>
          <div className='cg-text-lg-400'>{luksoData.description}</div>
        </div>
      );
    }
    if (farcasterData && createUserData.usePreparedFarcaster) {
      if (selectedProfile === 'farcaster') profile = (
        <div key="farcaster-profile" className="splash-create-profile-profile">
          {farcasterImageUrl && <div className='profile-photo-preview' style={{ backgroundImage: `url(${farcasterImageUrl})` }} />}
          <div className='cg-heading-3'>{farcasterData.displayName}</div>
          {!!farcasterData.bio && <div className='cg-text-lg-400'>{farcasterData.bio}</div>}
        </div>
      );
    }
    const { useCgProfile } = createUserData;
    if (useCgProfile) {
      if (selectedProfile === 'cg') profile = (
        <div key="cg-profile" className="splash-create-profile-profile">
          {userPhotoFileUrl && <div className='profile-photo-preview' style={{ backgroundImage: `url(${userPhotoFileUrl})` }} />}
          <div className='cg-heading-3'>{useCgProfile.displayName}</div>
          <div className='cg-text-lg-400'>{useCgProfile.extraData.description}</div>
          <div className='cg-text-lg-400'>{useCgProfile.extraData.homepage}</div>
        </div>
      );
    }
    return profile;
  }, [createUserData, luksoData, profileLockedIn, selectedProfile, twitterData, farcasterData, userPhotoFileUrl, farcasterImageUrl]);

  const cgProfileEditor = useMemo(() => {
    const useCgProfile = createUserData.useCgProfile;
    if (!useCgProfile) return null;
    return (
      <div key="cg-profile" className="grid grid-flow-row gap-2 w-full">
        <ProfilePhotoField
          currentFile={userPhoto}
          setFile={setUserPhoto}
        />
        <TextInputField
          value={useCgProfile.displayName}
          onChange={setUsernameAndValidate}
          placeholder='Add a username'
          error={usernameError}
          label='Username'
        />
        <TextAreaField
          label='About me'
          value={useCgProfile.extraData.description}
          onChange={description => updateCgProfileData({ extraData: { description } })}
          placeholder='Something about me'
          rows={4}
        />
        <TextInputField
          label='Homepage'
          value={useCgProfile.extraData.homepage}
          onChange={homepage => updateCgProfileData({ extraData: { homepage } })}
          placeholder='Homepage'
        />
      </div>
    );
  }, [createUserData.useCgProfile, setUsernameAndValidate, updateCgProfileData, userPhoto, usernameError]);

  if (profileLockedIn) {
    return (
      <div className='grid grid-flow-row px-8 gap-2 h-full min-h-full max-h-full items-center w-full cg-text-main overflow-y-auto' style={{ alignContent: 'start', justifyContent: 'stretch' }}>
        <span className='cg-heading-2 p-4 text-center'>Looks great!</span>
        <div className='grid grid-flow-row grid-cols-1 gap-4 justify-center items-center w-full'></div>
        {profile}
        {config.DEPLOYMENT !== 'dev' && captchaResolved && captchaProvider !== 'off' && <div className='grid justify-items-center items-center pt-4'>
          {captchaMisconfigured ? (
            <span className='cg-text-error text-center'>{CAPTCHA_MISCONFIGURED_TEXT}</span>
          ) : captchaProvider === 'altcha' ? (
            <AltchaWidget
              onVerified={(token) => setRecaptchaToken(token)}
              onReset={() => setRecaptchaToken('')}
            />
          ) : (
            <ReCAPTCHA
              sitekey={config.GOOGLE_RECAPTCHA_SITE_KEY || ''}
              theme={mode.isDarkMode ? 'dark' : 'light'}
              onChange={async (token) => {
                if (!!token) {
                  setRecaptchaToken(token);
                }
                else {
                  setRecaptchaToken('');
                }
              }}
            />
          )}
        </div>}
        {genericError && <span className='cg-text-error text-center'>{genericError}</span>}
      </div>
    );
  } else {
    return (<div className='grid grid-flow-row px-8 gap-2 h-full min-h-full max-h-full items-center w-full cg-text-main overflow-y-auto' style={{ alignContent: 'start', justifyContent: 'stretch' }}>
      <span className='cg-heading-2 p-4 text-center'>Set up your profile</span>
      <div className='grid grid-flow-row grid-cols-1 gap-4 justify-center items-center w-full'>
        <div className='grid grid-flow-row gap-2 w-full items-center' style={{ gridTemplateColumns: '1fr auto 1fr' }}>
          <div className='cg-separator' />
          <span>Connect an existing profile</span>
          <div className='cg-separator' />
        </div>
        <div className='grid grid-flow-row grid-cols-2 w-full gap-2'>
          <Button
            key='lukso'
            className='splash-login-button'
            role='chip'
            text={<>
              <LuksoIcon className='w-5 h-5' /><br />
              Universal Profile
            </>}
            onClick={() => {
              if (!hasUniversalProfileExtension) {
                window.open('https://chrome.google.com/webstore/detail/universal-profiles/abpickdkkbnbcoepogfhkhennhfhehfn', '_blank', 'noreferrer');
              } else {
                setSelectedProfile('lukso');
                setCreateUserData(oldData => ({ ...oldData, displayAccount: 'lukso', useCgProfile: undefined }))
                if (!isUniversalProfileConnected) connectToUniversalProfile();
              }
            }}
          />
          {config.TWITTER_AUTH_ENABLED && <Button
            key='x'
            className='splash-login-button'
            role='chip'
            text={<>
              <XIcon className='w-5 h-5' /><br />
              X
            </>}
            onClick={attemptConnectTwitter}
            disabled={twitterButtonDisabled}
          />}
          {selectedProfile === 'lukso' && (!luksoData || luksoData.universalProfileValid) && <div className='grid grid-flow-row' style={{ gridColumn: 'span 2' }}>
            <UniversalProfileStatus />
            <UniversalProfileSignButton
              readyForLoginOverride={luksoReadyForLoginOverride}
              readyForCreationOverride={luksoReadyForCreationOverride}
              step={"create-profile-setup"}
              luksoData={luksoData}
              signatureFinished={luksoSignatureFinished}
            />
          </div>}
        </div>
        <div className='grid grid-flow-row gap-2 w-full items-center' style={{ gridTemplateColumns: '1fr auto 1fr' }}>
          <div className='cg-separator' />
          <span>or</span>
          <div className='cg-separator' />
        </div>
        {!createUserData.useCgProfile && <div className='cg-content-stack p-4 cg-border-xxl w-full'>
          <Button
            role='chip'
            text='Create a new profile'
            className='w-full'
            onClick={() => {
              setSelectedProfile('cg');
              updateCgProfileData({});
            }}
          />
        </div>}
        {cgProfileEditor}
      </div>
      {genericError && <span className='cg-text-error'>{genericError}</span>}
    </div>);
  }
}

export const CreateUserButton: React.FC<ButtonProps> = (props) => {
  const { buttonState: btnState, setButtonState: setBtnState } = props;

  return <Button
    onClick={() => {
      let loginInstead = false;
      if (loginInstead) {
        // TODO: loginFinished({ account: 'lukso' });
      }
      else {
        setBtnState(oldState => ({ ...oldState, clicked: true, loading: true }))
      }
    }}
    role='primary'
    key='splash-primary-button'
    className='splash-button'
    text='Continue'
    disabled={btnState.disabled}
    loading={btnState.loading}
  />;
}