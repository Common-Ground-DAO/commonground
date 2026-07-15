// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Circle, Copy as CopyIcon, Trash as TrashIcon } from '@phosphor-icons/react';
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
import communityApi from 'data/api/community';
import { useMultipleCommunityListViews } from 'context/CommunityListViewProvider';
import type { PageType } from '../UserSettingsModalContent';
import errors from 'common/errors';

const MAX_USERNAME = 30;
const MAX_DESCRIPTION = 2000;
const USERNAME_PATTERN = /^[a-z0-9_-]+$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Props = {
  bot: API.Bot.BotView | null;
  owner: API.Bot.Owner;
  onSaved: (bot: API.Bot.BotView) => void;
  onDisabled?: () => void;
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

  const copyIssued = useCallback(async () => {
    if (!issuedToken) return;
    try {
      await navigator.clipboard.writeText(issuedToken);
      showSnackbar({ type: 'info', text: 'Token copied to clipboard' });
    } catch {
      showSnackbar({ type: 'warning', text: 'Could not copy token; select and copy it manually' });
    }
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

const BotEditor: React.FC<Props> = ({ bot, owner, onSaved, onDisabled, setPage }) => {
  const { showSnackbar } = useSnackbarContext();
  const isEdit = !!bot;
  const isPlatform = owner.ownerType === 'platform';

  const [username, setUsername] = useState(bot?.username ?? '');
  const [description, setDescription] = useState(bot?.description ?? '');
  const [imageId, setImageId] = useState<string | null>(bot?.imageId ?? null);
  const [imageFile, setImageFile] = useState<File | undefined>(undefined);
  const [platformMode, setPlatformMode] = useState<Models.User.BotPlatformPresenceMode>(
    bot?.platformPresence?.mode ?? 'selected',
  );
  const [platformCommunityIds, setPlatformCommunityIds] = useState<string[]>(
    bot?.platformPresence?.communityIds ?? [],
  );
  const [communityQuery, setCommunityQuery] = useState('');
  const [communityResults, setCommunityResults] = useState<Models.Community.ListView[]>([]);
  const [searchingCommunities, setSearchingCommunities] = useState(false);
  const [saving, setSaving] = useState(false);
  const selectedCommunities = useMultipleCommunityListViews(platformCommunityIds);

  // Reset local state whenever the selected bot changes (create <-> edit, or switching bots).
  useEffect(() => {
    setUsername(bot?.username ?? '');
    setDescription(bot?.description ?? '');
    setImageId(bot?.imageId ?? null);
    setImageFile(undefined);
    setPlatformMode(bot?.platformPresence?.mode ?? 'selected');
    setPlatformCommunityIds(bot?.platformPresence?.communityIds ?? []);
    setCommunityQuery('');
    setCommunityResults([]);
  }, [bot]);

  useEffect(() => {
    if (!isPlatform || platformMode !== 'selected' || !communityQuery.trim()) {
      setCommunityResults([]);
      setSearchingCommunities(false);
      return;
    }
    let cancelled = false;
    setSearchingCommunities(true);
    const handle = setTimeout(async () => {
      try {
        const query = communityQuery.trim();
        const communities = UUID_PATTERN.test(query)
          ? await communityApi.getCommunitiesById({ ids: [query] })
          : await communityApi.getCommunityList({
            offset: 0,
            limit: 20,
            sort: 'popular',
            tags: [],
            search: query,
          });
        if (!cancelled) setCommunityResults(communities);
      } catch {
        if (!cancelled) setCommunityResults([]);
      } finally {
        if (!cancelled) setSearchingCommunities(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [communityQuery, isPlatform, platformMode]);

  const existingImageUrl = useSignedUrl(imageId);
  const previewUrl = useMemo(
    () => (imageFile ? URL.createObjectURL(imageFile) : existingImageUrl),
    [imageFile, existingImageUrl],
  );
  useEffect(() => () => {
    if (imageFile && previewUrl) URL.revokeObjectURL(previewUrl);
  }, [imageFile, previewUrl]);

  const usernameError = username.length > 0
    ? username.length < 3
      ? 'Username must be at least 3 characters'
      : username.length > MAX_USERNAME
        ? `Username must be at most ${MAX_USERNAME} characters`
        : !USERNAME_PATTERN.test(username)
          ? 'Use only letters, numbers, hyphens, and underscores'
          : undefined
    : undefined;
  const canSave = username.length >= 3 && !usernameError && !saving;
  const connected = bot?.connectionStatus === 'connected';

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
          username,
          description: description.trim() || null,
          imageId: uploadedImageId,
          ...(isPlatform && bot.platformPresence
            ? { platformPresence: {
              mode: platformMode,
              communityIds: platformMode === 'all' ? [] : platformCommunityIds,
            } }
            : {}),
        });
      } else {
        saved = await botApi.createBot({
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          username,
          description: description.trim() || null,
          imageId: uploadedImageId,
          ...(isPlatform ? { platformPresence: {
            mode: platformMode,
            communityIds: platformMode === 'all' ? [] : platformCommunityIds,
          } } : {}),
        });
      }
      showSnackbar({ type: 'info', text: isEdit ? 'Bot updated' : 'Bot created' });
      onSaved(saved);
    } catch (e) {
      const message = (e as Error).message;
      showSnackbar({
        type: 'warning',
        text: message === errors.server.EXISTS_ALREADY ? 'Username is already taken' : message || 'Could not save bot',
      });
    } finally {
      setSaving(false);
    }
  }, [imageId, imageFile, isEdit, bot, username, description, isPlatform, platformMode, platformCommunityIds, owner, onSaved, showSnackbar]);

  const disable = useCallback(async () => {
    if (!bot) return;
    if (!window.confirm(
      'Disable this bot? Its tokens are revoked and it is removed from all communities. '
      + 'Its identity and past messages are preserved. This cannot be undone.',
    )) return;
    try {
      await botApi.disableBot({ botUserId: bot.userId });
      showSnackbar({ type: 'info', text: 'Bot disabled' });
      if (onDisabled) onDisabled();
      else setPage('bots');
    } catch (e) {
      showSnackbar({ type: 'warning', text: (e as Error).message || 'Could not disable bot' });
    }
  }, [bot, showSnackbar, setPage, onDisabled]);

  return <div className='flex flex-col px-4 gap-4 cg-text-main'>
    <ImageUploadField
      label='Bot avatar'
      subLabels={['PNG or JPEG, square works best']}
      imageURL={previewUrl}
      onChange={file => setImageFile(file)}
    />

    <TextInputField
      value={username}
      onChange={setUsername}
      label='Username'
      placeholder='my-helpful-bot'
      maxLetters={MAX_USERNAME}
      error={usernameError}
    />

    <TextAreaField
      value={description}
      onChange={setDescription}
      label='Description'
      placeholder='What does this bot do?'
      maxLetters={MAX_DESCRIPTION}
      autoGrow
    />

    {isEdit && bot && <div className='flex flex-col gap-1 p-3 cg-border-m cg-bg-subtle'>
      <span className='cg-text-lg-500 cg-text-main'>Runtime connection</span>
      <span className={`flex items-center gap-1 cg-text-md-500 ${connected ? 'cg-text-success' : 'cg-text-secondary'}`}>
        <Circle weight='fill' className='w-2 h-2' />
        {connected
          ? `Connected — ${bot.connectedSocketCount} authenticated connection${bot.connectedSocketCount === 1 ? '' : 's'}`
          : 'Offline'}
      </span>
      <span className='cg-text-sm-400 cg-text-secondary'>
        This confirms a live Bot API socket, not that the bot's application or model is healthy.
      </span>
      {bot.lastConnectedAt && <span className='cg-text-sm-400 cg-text-secondary'>
        Last connected {new Date(bot.lastConnectedAt).toLocaleString()}
      </span>}
    </div>}

    {isPlatform && <div className='flex flex-col gap-2'>
      <span className='cg-text-lg-500 cg-text-main'>Presence</span>
      <ToggleInputField
        toggled={platformMode === 'all'}
        onChange={on => setPlatformMode(on ? 'all' : 'selected')}
        label='Present in all communities'
      />
      {platformMode === 'all' && <span className='cg-text-sm-400 cg-text-secondary'>
        This automatically installs the bot in every current and future community. Use it only
        when instance policy permits universal presence.
      </span>}
      {platformMode === 'selected' && <span className='cg-text-sm-400 cg-text-secondary'>
        Choose the exact communities where this bot is present. Saving installs it in added
        communities and removes it from communities no longer selected.
      </span>}
      {platformMode === 'selected' && <div className='flex flex-col gap-2'>
        {platformCommunityIds.length > 0 && <div className='flex flex-col gap-1'>
          {platformCommunityIds.map(communityId => <div
            key={communityId}
            className='flex items-center justify-between gap-2 p-2 cg-border-m cg-bg-subtle'
          >
            <span className='cg-text-md-500 cg-text-main overflow-hidden text-ellipsis'>
              {selectedCommunities[communityId]?.title || communityId}
            </span>
            <Button
              role='secondary'
              text='Remove'
              onClick={() => setPlatformCommunityIds(ids => ids.filter(id => id !== communityId))}
            />
          </div>)}
        </div>}
        <TextInputField
          value={communityQuery}
          onChange={setCommunityQuery}
          label='Add a community'
          placeholder='Search communities'
        />
        {searchingCommunities && <SkeletonLine minWidth={180} maxWidth={280} />}
        {!searchingCommunities && communityQuery.trim() && communityResults.length === 0 &&
          <span className='cg-text-sm-400 cg-text-secondary'>No matching communities.</span>}
        {!searchingCommunities && communityResults
          .filter(community => !platformCommunityIds.includes(community.id))
          .map(community => <div key={community.id} className='flex items-center justify-between gap-2 py-1'>
            <span className='cg-text-md-500 cg-text-main overflow-hidden text-ellipsis'>{community.title}</span>
            <Button
              role='secondary'
              text='Add'
              onClick={() => {
                setPlatformCommunityIds(ids => [...ids, community.id]);
                setCommunityQuery('');
                setCommunityResults([]);
              }}
            />
          </div>)}
      </div>}
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
