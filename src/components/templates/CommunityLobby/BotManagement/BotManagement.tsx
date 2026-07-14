// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './BotManagement.css';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Robot } from '@phosphor-icons/react';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import { useSnackbarContext } from 'context/SnackbarContext';
import { useSignedUrl } from 'hooks/useSignedUrl';
import { RoleType } from 'common/enums';
import Button from 'components/atoms/Button/Button';
import Checkbox from 'components/atoms/Checkbox/Checkbox';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import OptionToggle from 'components/molecules/OptionToggle/OptionToggle';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import TextAreaField from 'components/molecules/inputs/TextAreaField/TextAreaField';
import ImageUploadField from 'components/molecules/inputs/ImageUploadField/ImageUploadField';
import SkeletonLine from 'components/atoms/SkeletonLine/SkeletonLine';
import botApi from 'data/api/bot';
import fileApi from 'data/api/file';
import BotEditor from 'components/organisms/UserSettingsModalContent/BotsPage/BotEditor';
import BotBadge from 'components/atoms/BotBadge/BotBadge';
import Jdenticon from 'components/atoms/Jdenticon/Jdenticon';
import errors from 'common/errors';

const BOT_USERNAME_MAX_LENGTH = 30;
const INSTALLABLE_PAGE_SIZE = 25;
const BOT_USERNAME_PATTERN = /^[a-z0-9_-]+$/i;

function validateBotUsername(username: string) {
  if (username.length < 3) return 'Username must be at least 3 characters';
  if (username.length > BOT_USERNAME_MAX_LENGTH) return `Username must be at most ${BOT_USERNAME_MAX_LENGTH} characters`;
  if (!BOT_USERNAME_PATTERN.test(username)) return 'Use only letters, numbers, hyphens, and underscores';
  return undefined;
}

// Roles a manager can assign to a bot: the community's custom roles (Member/Public/Admin
// predefined roles are managed by the platform, not hand-assigned here).
function useAssignableRoles() {
  const { roles } = useLoadedCommunityContext();
  return useMemo(
    () => roles.filter(role => role.type !== RoleType.PREDEFINED),
    [roles],
  );
}

const RoleAssignmentModal: React.FC<{
  isOpen: boolean;
  botUserId: string;
  botName: string;
  communityId: string;
  initialRoleIds: string[];
  onClose: () => void;
  onSaved: () => void;
}> = ({ isOpen, botUserId, botName, communityId, initialRoleIds, onClose, onSaved }) => {
  const assignableRoles = useAssignableRoles();
  const { showSnackbar } = useSnackbarContext();
  const assignableIds = useMemo(() => new Set(assignableRoles.map(r => r.id)), [assignableRoles]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) setSelected(new Set(initialRoleIds.filter(id => assignableIds.has(id))));
  }, [isOpen, initialRoleIds, assignableIds]);

  const toggle = useCallback((roleId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId); else next.add(roleId);
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await botApi.setBotRoles({ botUserId, communityId, roleIds: Array.from(selected) });
      showSnackbar({ type: 'info', text: 'Bot roles updated' });
      onSaved();
      onClose();
    } catch (e) {
      showSnackbar({ type: 'warning', text: (e as Error).message || 'Could not update roles' });
    } finally {
      setSaving(false);
    }
  }, [botUserId, communityId, selected, showSnackbar, onSaved, onClose]);

  return <ScreenAwareModal
    isOpen={isOpen}
    onClose={onClose}
    title={`Channels & roles — ${botName}`}
    footerActions={<div className='flex gap-2 justify-end'>
      <Button role='secondary' text='Cancel' onClick={onClose} />
      <Button role='primary' text='Save' loading={saving} disabled={saving} onClick={save} />
    </div>}
  >
    <div className='flex flex-col gap-1 p-4'>
      <span className='cg-text-md-400 cg-text-secondary pb-2'>
        The bot can read and post in whatever channels these roles grant. Manage channel
        access by editing the roles themselves.
      </span>
      {assignableRoles.length === 0
        ? <span className='cg-text-md-400 cg-text-secondary'>This community has no custom roles yet. Create one under Roles &amp; Permissions first.</span>
        : assignableRoles.map(role => <div
          key={role.id}
          className='flex items-center gap-2 py-2 cursor-pointer'
          role='button'
          onClick={() => toggle(role.id)}
        >
          <Checkbox checked={selected.has(role.id)} />
          <span className='cg-text-md-500 cg-text-main'>{role.title}</span>
        </div>)}
    </div>
  </ScreenAwareModal>;
};

const CreateCommunityBotModal: React.FC<{
  isOpen: boolean;
  communityId: string;
  onClose: () => void;
  onCreated: (bot: API.Bot.BotView) => void;
}> = ({ isOpen, communityId, onClose, onCreated }) => {
  const { showSnackbar } = useSnackbarContext();
  const [username, setUsername] = useState('');
  const [description, setDescription] = useState('');
  const [imageFile, setImageFile] = useState<File | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const previewUrl = useMemo(() => (imageFile ? URL.createObjectURL(imageFile) : undefined), [imageFile]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  useEffect(() => {
    if (isOpen) { setUsername(''); setDescription(''); setImageFile(undefined); }
  }, [isOpen]);

  const create = useCallback(async () => {
    setSaving(true);
    try {
      let imageId: string | null = null;
      if (imageFile) imageId = (await fileApi.uploadImage({ type: 'userProfileImage' }, imageFile)).imageId;
      const bot = await botApi.createBot({
        ownerType: 'community',
        ownerId: communityId,
        username,
        description: description.trim() || null,
        imageId,
      });
      showSnackbar({ type: 'info', text: 'Community bot created' });
      onCreated(bot);
      onClose();
    } catch (e) {
      const message = (e as Error).message;
      showSnackbar({
        type: 'warning',
        text: message === errors.server.EXISTS_ALREADY ? 'Username is already taken' : message || 'Could not create bot',
      });
    } finally {
      setSaving(false);
    }
  }, [imageFile, communityId, username, description, showSnackbar, onCreated, onClose]);

  const usernameError = username.length > 0 ? validateBotUsername(username) : undefined;
  const canCreate = username.length >= 3 && !usernameError && !saving;

  return <ScreenAwareModal
    isOpen={isOpen}
    onClose={onClose}
    title='Create community bot'
    footerActions={<div className='flex gap-2 justify-end'>
      <Button role='secondary' text='Cancel' onClick={onClose} />
      <Button role='primary' text='Create' loading={saving} disabled={!canCreate} onClick={create} />
    </div>}
  >
    <div className='flex flex-col gap-4 p-4'>
      <ImageUploadField label='Bot avatar' subLabels={['PNG or JPEG']} imageURL={previewUrl} onChange={setImageFile} />
      <TextInputField
        value={username}
        onChange={setUsername}
        label='Username'
        placeholder='community-helper'
        maxLetters={BOT_USERNAME_MAX_LENGTH}
        error={usernameError}
      />
      <TextAreaField value={description} onChange={setDescription} label='Description' placeholder='What does this bot do?' maxLetters={2000} autoGrow />
      <span className='cg-text-sm-400 cg-text-secondary'>
        The bot joins this community immediately. After creation you can issue its first API
        token and assign channel roles.
      </span>
    </div>
  </ScreenAwareModal>;
};

const InstallableUserBotRow: React.FC<{
  bot: API.Bot.InstallableUserBotView;
  installing: boolean;
  disabled: boolean;
  onInstall: () => void;
}> = ({ bot, installing, disabled, onInstall }) => <div className='flex items-center justify-between gap-3 py-2'>
  <div className='flex items-center gap-2 min-w-0'>
    <Jdenticon userId={bot.userId} defaultImageId={bot.imageId} predefinedSize='32' hideStatus />
    <div className='flex flex-col min-w-0'>
      <div className='flex items-center gap-1 min-w-0'>
        <span className='cg-text-md-500 cg-text-main overflow-hidden text-ellipsis'>@{bot.username}</span>
        <BotBadge />
      </div>
      <span className='cg-text-sm-400 cg-text-secondary overflow-hidden text-ellipsis'>
        Owned by @{bot.ownerUsername}
      </span>
      {bot.description && <span className='cg-text-sm-400 cg-text-secondary overflow-hidden text-ellipsis'>
        {bot.description}
      </span>}
    </div>
  </div>
  <Button role='primary' text='Add' loading={installing} disabled={disabled} onClick={onInstall} />
</div>;

const AddUserBotModal: React.FC<{
  isOpen: boolean;
  communityId: string;
  onClose: () => void;
  onInstalled: () => void;
}> = ({ isOpen, communityId, onClose, onInstalled }) => {
  const { showSnackbar } = useSnackbarContext();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<API.Bot.InstallableUserBotView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);

  useEffect(() => { if (isOpen) setQuery(''); }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const response = await botApi.listInstallableUserBots({
          communityId,
          query: query.trim() || null,
          cursor: null,
          limit: INSTALLABLE_PAGE_SIZE,
        });
        if (!cancelled) { setResults(response.items); setNextCursor(response.nextCursor); }
      } catch {
        if (!cancelled) { setResults([]); setNextCursor(null); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [isOpen, query, communityId]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await botApi.listInstallableUserBots({
        communityId,
        query: query.trim() || null,
        cursor: nextCursor,
        limit: INSTALLABLE_PAGE_SIZE,
      });
      setResults(current => [...current, ...response.items]);
      setNextCursor(response.nextCursor);
    } catch (e) {
      showSnackbar({ type: 'warning', text: (e as Error).message || 'Could not load more bots' });
    } finally {
      setLoadingMore(false);
    }
  }, [communityId, query, nextCursor, loadingMore, showSnackbar]);

  const install = useCallback(async (botUserId: string) => {
    setInstallingId(botUserId);
    try {
      await botApi.installBot({ botUserId, communityId, roleIds: [] });
      showSnackbar({ type: 'info', text: 'Bot added — assign it roles next' });
      onInstalled();
      onClose();
    } catch (e) {
      showSnackbar({ type: 'warning', text: (e as Error).message || 'Could not add bot' });
    } finally {
      setInstallingId(null);
    }
  }, [communityId, showSnackbar, onInstalled, onClose]);

  return <ScreenAwareModal isOpen={isOpen} onClose={onClose} title='Add a user bot'>
    <div className='flex flex-col gap-3 p-4'>
      <span className='cg-text-md-400 cg-text-secondary'>
        Browse bots owned by members of this community. Search filters the eligible catalog.
      </span>
      <TextInputField value={query} onChange={setQuery} placeholder='Filter by username' maxLetters={30} />
      {loading && <SkeletonLine minWidth={180} maxWidth={280} />}
      {!loading && results.length === 0 &&
        <span className='cg-text-md-400 cg-text-secondary'>No eligible user bots found.</span>}
      <div className='flex flex-col gap-1'>
        {results.map(bot => <InstallableUserBotRow
          key={bot.userId}
          bot={bot}
          installing={installingId === bot.userId}
          disabled={installingId !== null}
          onInstall={() => install(bot.userId)}
        />)}
      </div>
      {nextCursor && <Button role='secondary' text='Load more' loading={loadingMore} disabled={loadingMore} onClick={loadMore} />}
    </div>
  </ScreenAwareModal>;
};

const InstalledBotRow: React.FC<{
  bot: API.Bot.CommunityBotView;
  isCommunityOwned: boolean;
  communityId: string;
  onManageRoles: () => void;
  onManageBot: () => void;
  onChanged: () => void;
}> = ({ bot, isCommunityOwned, communityId, onManageRoles, onManageBot, onChanged }) => {
  const { showSnackbar } = useSnackbarContext();
  const imageUrl = useSignedUrl(bot.imageId);

  const remove = useCallback(async () => {
    if (!window.confirm('Remove this bot from the community? It keeps existing but loses access here.')) return;
    try {
      await botApi.removeBot({ botUserId: bot.userId, communityId });
      showSnackbar({ type: 'info', text: 'Bot removed' });
      onChanged();
    } catch (e) {
      showSnackbar({ type: 'warning', text: (e as Error).message || 'Action failed' });
    }
  }, [bot.userId, communityId, showSnackbar, onChanged]);

  return <div className='flex items-center justify-between gap-2 py-2'>
    <div className='flex items-center gap-2 overflow-hidden'>
      {imageUrl
        ? <img src={imageUrl} alt='' className='w-7 h-7 rounded-full object-cover' />
        : <Robot weight='duotone' className='w-7 h-7 cg-text-secondary' />}
      <div className='flex flex-col overflow-hidden'>
        <span className='cg-text-md-500 cg-text-main overflow-hidden text-ellipsis'>
          @{bot.username}
        </span>
        <span className='cg-text-sm-400 cg-text-secondary'>
          {isCommunityOwned ? 'Community bot' : 'External bot'}
        </span>
      </div>
    </div>
    <div className='flex gap-1 shrink-0'>
      <Button role='secondary' text='Roles' onClick={onManageRoles} />
      {isCommunityOwned
        ? <Button role='primary' text='Manage' onClick={onManageBot} />
        : <Button role='destructive' text='Remove' onClick={remove} />}
    </div>
  </div>;
};

type Props = {
  showHeading?: boolean;
};

const BotManagement: React.FC<Props> = ({ showHeading = true }) => {
  const { community } = useLoadedCommunityContext();
  const { showSnackbar } = useSnackbarContext();
  const communityId = community.id;

  const [allowUserBots, setAllowUserBots] = useState(community.allowUserBots);
  const [savingToggle, setSavingToggle] = useState(false);
  const [installedBots, setInstalledBots] = useState<API.Bot.CommunityBotView[] | undefined>(undefined);
  const [communityOwnedBots, setCommunityOwnedBots] = useState<Map<string, API.Bot.BotView>>(new Map());
  const [createOpen, setCreateOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [roleModalBot, setRoleModalBot] = useState<API.Bot.CommunityBotView | null>(null);
  const [managedBot, setManagedBot] = useState<API.Bot.BotView | null>(null);

  const load = useCallback(async () => {
    try {
      const [installed, owned] = await Promise.all([
        botApi.listCommunityBots({ communityId }),
        botApi.listBots({ ownerType: 'community', ownerId: communityId }),
      ]);
      setInstalledBots(installed);
      setCommunityOwnedBots(new Map(owned.filter(bot => !bot.disabledAt).map(bot => [bot.userId, bot])));
    } catch (e) {
      showSnackbar({ type: 'warning', text: 'Could not load bots' });
      setInstalledBots([]);
      setCommunityOwnedBots(new Map());
    }
  }, [communityId, showSnackbar]);

  useEffect(() => { load(); }, [load]);

  const toggleAllowUserBots = useCallback(async (value: boolean) => {
    setSavingToggle(true);
    setAllowUserBots(value);
    try {
      await botApi.setAllowUserBots({ communityId, allowUserBots: value });
      showSnackbar({ type: 'info', text: value ? 'User bots allowed' : 'User bots disabled and removed' });
      await load();
    } catch (e) {
      setAllowUserBots(!value);
      showSnackbar({ type: 'warning', text: (e as Error).message || 'Could not update setting' });
    } finally {
      setSavingToggle(false);
    }
  }, [communityId, showSnackbar, load]);

  return <div className='bot-management flex flex-col gap-6 p-4 cg-text-main'>
    {showHeading && <div className='flex flex-col gap-2'>
      <span className='cg-heading-3'>Bots</span>
      <span className='cg-text-md-400 cg-text-secondary'>
        Bots are automated accounts that read and post in your channels through the Bot API.
      </span>
    </div>}

    <OptionToggle
      title='Allow user-owned bots'
      description='Let members add their own bots to this community. Community-owned bots are unaffected.'
      isToggled={allowUserBots}
      onToggle={toggleAllowUserBots}
      disabled={savingToggle}
    />

    <div className='flex flex-col gap-2'>
      <div className='flex items-center justify-between'>
        <span className='cg-text-lg-500 cg-text-main'>Installed bots</span>
        <div className='flex gap-1'>
          <Button role='secondary' text='Add user bot' disabled={!allowUserBots} onClick={() => setAddOpen(true)} />
          <Button role='primary' text='Create bot' onClick={() => setCreateOpen(true)} />
        </div>
      </div>
      {installedBots === undefined
        ? <SkeletonLine minWidth={200} maxWidth={300} />
        : installedBots.length === 0
          ? <span className='cg-text-md-400 cg-text-secondary'>No bots in this community yet.</span>
          : <div className='flex flex-col'>
            {installedBots.map(bot => <InstalledBotRow
              key={bot.userId}
              bot={bot}
              communityId={communityId}
              isCommunityOwned={bot.communityOwned}
              onManageRoles={() => setRoleModalBot(bot)}
              onManageBot={() => setManagedBot(communityOwnedBots.get(bot.userId) ?? null)}
              onChanged={load}
            />)}
          </div>}
    </div>

    <CreateCommunityBotModal
      isOpen={createOpen}
      communityId={communityId}
      onClose={() => setCreateOpen(false)}
      onCreated={bot => {
        setManagedBot(bot);
        load();
      }}
    />
    <AddUserBotModal
      isOpen={addOpen}
      communityId={communityId}
      onClose={() => setAddOpen(false)}
      onInstalled={load}
    />
    {roleModalBot && <RoleAssignmentModal
      isOpen={!!roleModalBot}
      botUserId={roleModalBot.userId}
      botName={`@${roleModalBot.username}`}
      communityId={communityId}
      initialRoleIds={roleModalBot.roleIds}
      onClose={() => setRoleModalBot(null)}
      onSaved={load}
    />}
    {managedBot && <ScreenAwareModal
      isOpen={!!managedBot}
      onClose={() => setManagedBot(null)}
      title={`Manage @${managedBot.username}`}
    >
      <div className='py-4'>
        <BotEditor
          bot={managedBot}
          owner={{ ownerType: 'community', ownerId: communityId }}
          onSaved={bot => {
            setManagedBot(bot);
            load();
          }}
          onDisabled={() => {
            setManagedBot(null);
            load();
          }}
          setPage={() => undefined}
        />
      </div>
    </ScreenAwareModal>}
  </div>;
};

export default React.memo(BotManagement);
