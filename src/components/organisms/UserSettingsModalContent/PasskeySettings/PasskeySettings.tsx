// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useState } from 'react'
import { PageType } from '../UserSettingsModalContent';
import './PasskeySettings.css';
import Button from 'components/atoms/Button/Button';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import { usePasskeyContext } from 'context/PasskeyProvider';
import { useStepUp } from 'context/StepUpProvider';
import { useOwnUser } from 'context/OwnDataProvider';
import { useSnackbarContext } from 'context/SnackbarContext';
import passkeyApi from 'data/api/passkey';
import { getSignalRpId } from 'data/auth/authMode';
import { securityActionErrorMessage } from 'data/auth/authErrors';
import { signalAcceptedCredentials, signalUserDetails } from 'data/auth/passkeyCeremony';
import { Key as PasskeyIcon, CloudCheck, DeviceMobile } from '@phosphor-icons/react';
import dayjs from 'dayjs';

type Props = {
  setPage: (pageType: PageType) => void;
  lockModal: (lock: boolean) => void;
  closeModal: () => void;
};

function formatDate(value: string | null) {
  return value ? dayjs(value).format('D MMM YYYY') : null;
}

/**
 * The account's passkeys on this instance (Passkey/list): name, created, last
 * used, synced; rename, remove (step-up; never the last way to sign in) and
 * add (step-up first: the ceremony needs a click of its own afterwards).
 * The list is also reported to the browser's passkey manager (Signal API).
 */
const PasskeySettings: React.FC<Props> = (props) => {
  const { lockModal } = props;
  const ownUser = useOwnUser();
  const passkey = usePasskeyContext();
  const { ensureRecentAuth } = useStepUp();
  const { showSnackbar } = useSnackbarContext();
  const [passkeys, setPasskeys] = useState<Models.Passkey.Info[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [confirmedForAdd, setConfirmedForAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<Models.Passkey.Info | null>(null);
  const [busy, setBusy] = useState(false);
  // own data carries this RP's passkeys and changes when one is added or removed
  const ownPasskeyCount = ownUser?.passkeys?.length;

  const load = useCallback(async () => {
    try {
      const list = await passkeyApi.list();
      setPasskeys(list);
      setLoadError(false);
      return list;
    }
    catch (e) {
      console.error("Could not load passkeys", e);
      setLoadError(true);
      return null;
    }
  }, []);

  useEffect(() => {
    if (passkey.legacy) {
      return;
    }
    load();
  }, [load, ownPasskeyCount, passkey.legacy]);

  // keep the browser's passkey manager in sync with the server's list
  const displayName = ownUser?.accounts.find(account => account.type === 'cg')?.displayName
    || ownUser?.accounts.find(account => account.type === ownUser.displayAccount)?.displayName
    || '';
  const accountName = ownUser?.email || displayName;
  useEffect(() => {
    if (!passkeys) {
      return;
    }
    const rpId = getSignalRpId();
    signalAcceptedCredentials(rpId, passkeys);
    if (accountName) {
      signalUserDetails(rpId, passkeys, { name: accountName, displayName: displayName || accountName });
    }
  }, [passkeys, accountName, displayName]);

  const createPasskey = useCallback(async () => {
    setAdding(true);
    lockModal(true);
    try {
      const outcome = await passkey.register();
      if (outcome.status === 'ok') {
        setConfirmedForAdd(false);
        const { result } = outcome.result;
        if (result.status === 'attached') {
          setPasskeys(result.passkeys);
        }
        showSnackbar({ type: 'info', text: 'Passkey added' });
      }
      else if (outcome.status === 'reauthenticated') {
        // the server wanted a confirmation after all; after that dialog the
        // browser may refuse the ceremony (Safari): ask for a new click
        setConfirmedForAdd(true);
      }
      else if (outcome.status === 'error') {
        const message = outcome.code ? securityActionErrorMessage(new Error(outcome.code), outcome.message) : outcome.message;
        if (message) {
          showSnackbar({ type: 'warning', text: message });
        }
      }
    }
    finally {
      setAdding(false);
      lockModal(false);
    }
  }, [passkey, lockModal, showSnackbar]);

  const addPasskey = useCallback(async () => {
    lockModal(true);
    let result: Awaited<ReturnType<typeof ensureRecentAuth>>;
    try {
      result = await ensureRecentAuth('add a passkey', { allowWallet: true });
    }
    finally {
      lockModal(false);
    }
    if (result === 'fresh') {
      await createPasskey();
    }
    else if (result === 'reauthenticated') {
      // the confirmation used up this click; the passkey dialog needs a new one
      setConfirmedForAdd(true);
    }
  }, [ensureRecentAuth, createPasskey, lockModal]);

  const saveName = useCallback(async () => {
    if (!renaming) {
      return;
    }
    const name = renaming.name.trim();
    if (!name) {
      return;
    }
    setBusy(true);
    try {
      await passkeyApi.rename({ id: renaming.id, name: name.slice(0, 64) });
      setPasskeys(list => list?.map(item => item.id === renaming.id ? { ...item, name: name.slice(0, 64) } : item) || null);
      setRenaming(null);
    }
    catch (e) {
      console.error(e);
      showSnackbar({ type: 'warning', text: 'The passkey could not be renamed' });
    }
    finally {
      setBusy(false);
    }
  }, [renaming, showSnackbar]);

  const setRemoveDialog = useCallback((item: Models.Passkey.Info | null) => {
    setRemoving(item);
    lockModal(!!item);
  }, [lockModal]);

  const removePasskey = useCallback(async () => {
    if (!removing) {
      return;
    }
    setBusy(true);
    try {
      // confirm first, then remove (no ceremony afterwards, so one go)
      const auth = await ensureRecentAuth('remove a passkey');
      if (auth === 'cancelled') {
        return;
      }
      await passkeyApi.remove({ id: removing.id });
      setPasskeys(list => list?.filter(item => item.id !== removing.id) || null);
      setRemoveDialog(null);
      showSnackbar({ type: 'info', text: 'Passkey removed. Your other devices were signed out. You can also delete the passkey from your password manager.' });
    }
    catch (e) {
      const message = securityActionErrorMessage(e, 'The passkey could not be removed');
      if (message) {
        showSnackbar({ type: 'warning', text: message });
      }
    }
    finally {
      setBusy(false);
    }
  }, [removing, ensureRecentAuth, setRemoveDialog, showSnackbar]);

  if (passkey.legacy) {
    return (
      <div className="passkey-settings-root cg-text-main">
        <div className='cg-text-md-400'>Passkeys on this site are managed in the CG ID app.</div>
      </div>
    );
  }

  return (
    <div className="passkey-settings-root cg-text-main">
      <div className='cg-text-md-400 cg-text-secondary'>
        Passkeys let you sign in with your fingerprint, face or screen lock. They can't be phished or leaked.
      </div>

      {loadError && <div className='cg-text-md-400 cg-text-error'>Your passkeys could not be loaded.</div>}

      {passkeys !== null && passkeys.length === 0 && <div className='cg-text-md-400'>
        No passkeys yet.
      </div>}

      {passkeys !== null && passkeys.length > 0 && <div className='passkey-settings-list'>
        {passkeys.map(item => (
          <div key={item.id} className='passkey-settings-item'>
            <div className='flex items-center gap-2'>
              <PasskeyIcon className='w-5 h-5 shrink-0' weight='duotone' />
              {renaming?.id === item.id
                ? <form className='flex flex-1 gap-2 items-center' onSubmit={ev => { ev.preventDefault(); saveName(); }}>
                  <TextInputField
                    value={renaming.name}
                    onChange={name => setRenaming({ id: item.id, name })}
                    maxLetters={64}
                    autoFocus
                  />
                  <Button role='primary' text='Save' loading={busy} disabled={busy || !renaming.name.trim()} />
                </form>
                : <span className='cg-text-lg-500 flex-1 overflow-hidden text-ellipsis'>{item.name || 'Passkey'}</span>}
            </div>
            <div className='cg-text-sm-400 cg-text-secondary passkey-settings-meta'>
              <span>Created {formatDate(item.createdAt)}</span>
              <span>{item.lastUsedAt ? `Last used ${formatDate(item.lastUsedAt)}` : 'Not used yet'}</span>
              <span className='flex items-center gap-1'>
                {item.credentialBackedUp
                  ? <><CloudCheck className='w-4 h-4' /> Synced across your devices</>
                  : <><DeviceMobile className='w-4 h-4' /> Only on one device</>}
              </span>
            </div>
            {renaming?.id !== item.id && <div className='flex gap-2'>
              <Button role='chip' text='Rename' onClick={() => setRenaming({ id: item.id, name: item.name || '' })} disabled={busy} />
              <Button role='chip' text='Remove' onClick={() => setRemoveDialog(item)} disabled={busy} />
            </div>}
            {renaming?.id === item.id && <Button role='textual' text='Cancel' onClick={() => setRenaming(null)} />}
          </div>
        ))}
      </div>}

      {!passkey.supported && <div className='cg-text-sm-400'>
        This browser doesn't support passkeys.
      </div>}
      {confirmedForAdd
        ? <Button
          text='Create the passkey now'
          onClick={createPasskey}
          role="primary"
          className="w-full"
          loading={adding}
          disabled={adding || !passkey.supported}
        />
        : <Button
          text='Add a passkey'
          onClick={addPasskey}
          role="primary"
          className="w-full"
          loading={adding}
          disabled={adding || !passkey.supported || passkey.status === 'busy'}
        />}

      <ScreenAwareModal
        isOpen={!!removing}
        onClose={() => setRemoveDialog(null)}
        hideHeader
      >
        <div className='flex flex-col p-4 gap-6'>
          <span className='cg-text-main'>
            Remove the passkey "{removing?.name || 'Passkey'}"? You won't be able to sign in with it any more.
          </span>
          <div className="btnList justify-end align-center">
            <Button role="secondary" text="Keep it" onClick={() => setRemoveDialog(null)} disabled={busy} />
            <Button role="destructive" text="Remove" onClick={removePasskey} loading={busy} disabled={busy} />
          </div>
        </div>
      </ScreenAwareModal>
    </div>
  );
}

export default React.memo(PasskeySettings);
