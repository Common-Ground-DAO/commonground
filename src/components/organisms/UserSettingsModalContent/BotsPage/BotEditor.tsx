// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy as CopyIcon, Trash as TrashIcon } from '@phosphor-icons/react';
import Button from 'components/atoms/Button/Button';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import TextAreaField from 'components/molecules/inputs/TextAreaField/TextAreaField';
import ImageUploadField from 'components/molecules/inputs/ImageUploadField/ImageUploadField';
import ToggleInputField from 'components/molecules/inputs/ToggleInputField/ToggleInputField';
import SkeletonLine from 'components/atoms/SkeletonLine/SkeletonLine';
import { useSnackbarContext } from 'context/SnackbarContext';
import { useSignedUrl } from 'hooks/useSignedUrl';
import botApi from 'data/api/bot';
import fileApi from 'data/api/file';
import { PageType } from '../UserSettingsModalContent';

const MAX_NAME = 255;
const MAX_DESCRIPTION = 2000;

type Props = {
  bot: API.Bot.BotView | null;
  owner: API.Bot.Owner;
  onSaved: (bot: API.Bot.BotView) => void;
  setPage: (pageType: PageType) => void;
};

const TokenSection: React.FC<{ botUserId: string }> = ({ botUserId }) => {
  const { showSnackbar } = useSnackbarContext();
  const [tokens, setTokens] = useState<API.Bot.TokenView[] | undefined>(undefined);
  const [newName, setNewName] = useState('');
  const [issuing, setIssuing] = useState(false);
  const [issuedToken, setIssuedToken] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setTokens(await botApi.listTokens({ botUserId }));
    } catch (e) {
      showSnackbar({ type: 'warning', text: 'Could not load tokens' });
      setTokens([]);
    }
  }, [botUserId, showSnackbar]);

  useEffect(() => {
    load();
  }, [load]);

  const issue = useCallback(async () => {
    setIssuing(true);
    try {
      const result = await botApi.issueToken({ botUserId, name: newName.trim() || null });
      setIssuedToken(result.token);
      setNewName('');
      await load();
    } catch (e) {
      showSnackbar({ type: 'warning', text: (e as Error).message || 'Could not issue token' });
    } finally {
      setIssuing(false);
    }
  }, [botUserId, newName, load, showSnackbar]);

  const revoke = useCallback(async (tokenId: string) => {
    if (!window.confirm('Revoke this token? Any script using it will immediately lose access.')) return;
    try {
      await botApi.revokeToken({ botUserId, tokenId });
      await load();
    } catch (e) {
      showSnackbar({ type: 'warning', text: (e as Error).message || 'Could not revoke token' });
    }
  }, [botUserId, load, showSnackbar]);

  const copyIssued = useCallback(() => {
    if (!issuedToken) return;
    navigator.clipboard.writeText(issuedToken);
    showSnackbar({ type: 'info', text: 'Token copied to clipboard' });
  }, [issuedToken, showSnackbar]);

  const activeTokens = useMemo(() => tokens?.filter(t => !t.revokedAt) ?? [], [tokens]);

  return <div className='flex flex-col gap-3'>
    <span className='cg-text-lg-500 cg-text-main'>API tokens</span>

    {issuedToken && <div className='flex flex-col gap-2 p-3 cg-border-m cg-bg-subtle'>
      <span className='cg-text-sm-500 cg-text-brand'>New token — copy it now, it won't be shown again.</span>
      <div className='flex items-center gap-2'>
        <span className='cg-text-sm-400 cg-text-main break-all font-mono'>{issuedToken}</span>
        <Button role='secondary' iconLeft={<CopyIcon className='w-4 h-4' />} onClick={copyIssued} />
      </div>
      <Button role='textual' text='Dismiss' onClick={() => setIssuedToken(undefined)} />
    </div>}

    {tokens === undefined
      ? <SkeletonLine minWidth={180} maxWidth={280} />
      : activeTokens.length === 0
        ? <span className='cg-text-md-400 cg-text-secondary'>No active tokens.</span>
        : <div className='flex flex-col gap-1'>
          {activeTokens.map(token => <div key={token.id} className='flex items-center justify-between gap-2 py-1'>
            <div className='flex flex-col overflow-hidden'>
              <span className='cg-text-md-500 cg-text-main overflow-hidden text-ellipsis'>{token.name || 'Unnamed token'}</span>
              <span className='cg-text-sm-400 cg-text-secondary'>
                {token.lastUsedAt ? `Last used ${new Date(token.lastUsedAt).toLocaleDateString()}` : 'Never used'}
              </span>
            </div>
            <Button role='destructive' iconLeft={<TrashIcon className='w-4 h-4' />} onClick={() => revoke(token.id)} />
          </div>)}
        </div>}

    <div className='flex items-end gap-2'>
      <TextInputField
        value={newName}
        onChange={setNewName}
        label='New token'
        placeholder='Token name (optional)'
        maxLetters={100}
      />
      <Button role='primary' text='Issue' loading={issuing} disabled={issuing} onClick={issue} />
    </div>
  </div>;
};

const BotEditor: React.FC<Props> = ({ bot, owner, onSaved, setPage }) => {
  const { showSnackbar } = useSnackbarContext();
  const isEdit = !!bot;

  const [displayName, setDisplayName] = useState(bot?.displayName ?? '');
  const [description, setDescription] = useState(bot?.description ?? '');
  const [imageId, setImageId] = useState<string | null>(bot?.imageId ?? null);
  const [imageFile, setImageFile] = useState<File | undefined>(undefined);
  const [platformMode, setPlatformMode] = useState<Models.User.BotPlatformPresenceMode>(
    bot?.platformPresence?.mode ?? 'selected',
  );
  const [saving, setSaving] = useState(false);

  // Reset local state whenever the selected bot changes (create <-> edit, or switching bots).
  useEffect(() => {
    setDisplayName(bot?.displayName ?? '');
    setDescription(bot?.description ?? '');
    setImageId(bot?.imageId ?? null);
    setImageFile(undefined);
    setPlatformMode(bot?.platformPresence?.mode ?? 'selected');
  }, [bot]);

  const existingImageUrl = useSignedUrl(imageId);
  const previewUrl = useMemo(
    () => (imageFile ? URL.createObjectURL(imageFile) : existingImageUrl),
    [imageFile, existingImageUrl],
  );
  useEffect(() => () => {
    if (imageFile && previewUrl) URL.revokeObjectURL(previewUrl);
  }, [imageFile, previewUrl]);

  const isPlatform = owner.ownerType === 'platform';
  const nameError = displayName.trim().length === 0 && displayName.length > 0 ? 'Name cannot be blank' : undefined;
  const canSave = displayName.trim().length > 0 && !saving;

  const save = useCallback(async () => {
    setSaving(true);
    try {
      let uploadedImageId = imageId;
      if (imageFile) {
        const { imageId: newId } = await fileApi.uploadImage({ type: 'userProfileImage' }, imageFile);
        uploadedImageId = newId;
        setImageId(newId);
        setImageFile(undefined);
      }
      let saved: API.Bot.BotView;
      if (isEdit && bot) {
        saved = await botApi.updateBot({
          botUserId: bot.userId,
          displayName: displayName.trim(),
          description: description.trim() || null,
          imageId: uploadedImageId,
          ...(isPlatform && bot.platformPresence
            ? { platformPresence: { mode: platformMode, communityIds: bot.platformPresence.communityIds } }
            : {}),
        });
      } else {
        saved = await botApi.createBot({
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          displayName: displayName.trim(),
          description: description.trim() || null,
          imageId: uploadedImageId,
          ...(isPlatform ? { platformPresence: { mode: platformMode, communityIds: [] } } : {}),
        });
      }
      showSnackbar({ type: 'info', text: isEdit ? 'Bot updated' : 'Bot created' });
      onSaved(saved);
    } catch (e) {
      showSnackbar({ type: 'warning', text: (e as Error).message || 'Could not save bot' });
    } finally {
      setSaving(false);
    }
  }, [imageId, imageFile, isEdit, bot, displayName, description, isPlatform, platformMode, owner, onSaved, showSnackbar]);

  const disable = useCallback(async () => {
    if (!bot) return;
    if (!window.confirm(
      'Disable this bot? Its tokens are revoked and it is removed from all communities. '
      + 'Its identity and past messages are preserved. This cannot be undone.',
    )) return;
    try {
      await botApi.disableBot({ botUserId: bot.userId });
      showSnackbar({ type: 'info', text: 'Bot disabled' });
      setPage('bots');
    } catch (e) {
      showSnackbar({ type: 'warning', text: (e as Error).message || 'Could not disable bot' });
    }
  }, [bot, showSnackbar, setPage]);

  return <div className='flex flex-col px-4 gap-4 cg-text-main'>
    <ImageUploadField
      label='Bot avatar'
      subLabels={['PNG or JPEG, square works best']}
      imageURL={previewUrl}
      onChange={file => setImageFile(file)}
    />

    <TextInputField
      value={displayName}
      onChange={setDisplayName}
      label='Display name'
      placeholder='My helpful bot'
      maxLetters={MAX_NAME}
      error={nameError}
    />

    <TextAreaField
      value={description}
      onChange={setDescription}
      label='Description'
      placeholder='What does this bot do?'
      maxLetters={MAX_DESCRIPTION}
      autoGrow
    />

    {isPlatform && <div className='flex flex-col gap-2'>
      <span className='cg-text-lg-500 cg-text-main'>Presence</span>
      <ToggleInputField
        toggled={platformMode === 'all'}
        onChange={on => setPlatformMode(on ? 'all' : 'selected')}
        label='Present in all communities'
      />
      {platformMode === 'selected' && <span className='cg-text-sm-400 cg-text-secondary'>
        Add this bot to specific communities from each community's Bots settings.
      </span>}
    </div>}

    <Button
      role='primary'
      text={isEdit ? 'Save changes' : 'Create bot'}
      loading={saving}
      disabled={!canSave}
      onClick={save}
    />

    {isEdit && bot && <>
      <div className='cg-separator' />
      <TokenSection botUserId={bot.userId} />
      <div className='cg-separator' />
      <Button role='destructive' text='Disable bot' onClick={disable} />
    </>}
  </div>;
};

export default React.memo(BotEditor);
