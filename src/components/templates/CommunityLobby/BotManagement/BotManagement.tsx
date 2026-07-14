// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './BotManagement.css';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Robot } from '@phosphor-icons/react';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import { useSnackbarContext } from 'context/SnackbarContext';
import { useMultipleUserData } from 'context/UserDataProvider';
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
import { getDisplayNameString } from 'util/index';
import botApi from 'data/api/bot';
import communityApi from 'data/api/community';
import searchApi from 'data/api/search';
import fileApi from 'data/api/file';

const MEMBER_FETCH_LIMIT = 200;

type InstalledBot = {
  userId: string;
  roleIds: string[];
};

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
  onCreated: () => void;
}> = ({ isOpen, communityId, onClose, onCreated }) => {
  const { showSnackbar } = useSnackbarContext();
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [imageFile, setImageFile] = useState<File | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const previewUrl = useMemo(() => (imageFile ? URL.createObjectURL(imageFile) : undefined), [imageFile]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  useEffect(() => {
    if (isOpen) { setDisplayName(''); setDescription(''); setImageFile(undefined); }
  }, [isOpen]);

  const create = useCallback(async () => {
    setSaving(true);
    try {
      let imageId: string | null = null;
      if (imageFile) imageId = (await fileApi.uploadImage({ type: 'userProfileImage' }, imageFile)).imageId;
      await botApi.createBot({
        ownerType: 'community',
        ownerId: communityId,
        displayName: displayName.trim(),
        description: description.trim() || null,
        imageId,
      });
      showSnackbar({ type: 'info', text: 'Community bot created' });
      onCreated();
      onClose();
    } catch (e) {
      showSnackbar({ type: 'warning', text: (e as Error).message || 'Could not create bot' });
    } finally {
      setSaving(false);
    }
  }, [imageFile, communityId, displayName, description, showSnackbar, onCreated, onClose]);

  return <ScreenAwareModal
    isOpen={isOpen}
    onClose={onClose}
    title='Create community bot'
    footerActions={<div className='flex gap-2 justify-end'>
      <Button role='secondary' text='Cancel' onClick={onClose} />
      <Button role='primary' text='Create' loading={saving} disabled={saving || displayName.trim().length === 0} onClick={create} />
    </div>}
  >
    <div className='flex flex-col gap-4 p-4'>
      <ImageUploadField label='Bot avatar' subLabels={['PNG or JPEG']} imageURL={previewUrl} onChange={setImageFile} />
      <TextInputField value={displayName} onChange={setDisplayName} label='Display name' placeholder='Community helper' maxLetters={255} />
      <TextAreaField value={description} onChange={setDescription} label='Description' placeholder='What does this bot do?' maxLetters={2000} autoGrow />
      <span className='cg-text-sm-400 cg-text-secondary'>
        The bot joins this community immediately. Assign it channel roles afterwards; issue an
        API token from the bot owner's settings to run it.
      </span>
    </div>
  </ScreenAwareModal>;
};

const AddExistingBotModal: React.FC<{
  isOpen: boolean;
  communityId: string;
  installedIds: Set<string>;
  onClose: () => void;
  onInstalled: () => void;
}> = ({ isOpen, communityId, installedIds, onClose, onInstalled }) => {
  const { showSnackbar } = useSnackbarContext();
  const [query, setQuery] = useState('');
  const [resultIds, setResultIds] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const results = useMultipleUserData(resultIds);

  useEffect(() => { if (isOpen) { setQuery(''); setResultIds([]); } }, [isOpen]);

  useEffect(() => {
    if (!query.trim()) { setResultIds([]); return; }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await searchApi.searchUsers({ query: query.trim(), limit: 20 });
        if (!cancelled) {
          setResultIds(res
            .filter(r => r.matchedAccountTypes?.includes('bot'))
            .map(r => r.id)
            .filter(id => !installedIds.has(id)));
        }
      } catch {
        if (!cancelled) setResultIds([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query, installedIds]);

  const install = useCallback(async (botUserId: string) => {
    try {
      await botApi.installBot({ botUserId, communityId, roleIds: [] });
      showSnackbar({ type: 'info', text: 'Bot added — assign it roles next' });
      onInstalled();
      onClose();
    } catch (e) {
      showSnackbar({ type: 'warning', text: (e as Error).message || 'Could not add bot' });
    }
  }, [communityId, showSnackbar, onInstalled, onClose]);

  return <ScreenAwareModal isOpen={isOpen} onClose={onClose} title='Add a bot'>
    <div className='flex flex-col gap-3 p-4'>
      <span className='cg-text-md-400 cg-text-secondary'>
        Search for a bot by name to add it to this community. User-owned bots can only be added
        if this community allows them.
      </span>
      <TextInputField value={query} onChange={setQuery} placeholder='Search bots by name' />
      {searching && <SkeletonLine minWidth={180} maxWidth={280} />}
      {!searching && query.trim() && resultIds.length === 0 &&
        <span className='cg-text-md-400 cg-text-secondary'>No matching bots found.</span>}
      <div className='flex flex-col gap-1'>
        {resultIds.map(id => {
          const bot = results[id];
          return <div key={id} className='flex items-center justify-between gap-2 py-1'>
            <span className='cg-text-md-500 cg-text-main overflow-hidden text-ellipsis'>
              {bot ? getDisplayNameString(bot) : id}
            </span>
            <Button role='primary' text='Add' onClick={() => install(id)} />
          </div>;
        })}
      </div>
    </div>
  </ScreenAwareModal>;
};

const InstalledBotRow: React.FC<{
  bot: InstalledBot;
  userData?: Models.User.Data;
  isCommunityOwned: boolean;
  communityId: string;
  onManageRoles: () => void;
  onChanged: () => void;
}> = ({ bot, userData, isCommunityOwned, communityId, onManageRoles, onChanged }) => {
  const { showSnackbar } = useSnackbarContext();
  const imageUrl = useSignedUrl(userData?.accounts?.find(a => a.type === 'bot')?.imageId ?? null);

  const remove = useCallback(async () => {
    const owned = isCommunityOwned;
    const msg = owned
      ? 'Disable this community bot? Its tokens are revoked and it leaves the community. Its identity and past messages are preserved.'
      : 'Remove this bot from the community? It keeps existing but loses access here.';
    if (!window.confirm(msg)) return;
    try {
      if (owned) await botApi.disableBot({ botUserId: bot.userId });
      else await botApi.removeBot({ botUserId: bot.userId, communityId });
      showSnackbar({ type: 'info', text: owned ? 'Bot disabled' : 'Bot removed' });
      onChanged();
    } catch (e) {
      showSnackbar({ type: 'warning', text: (e as Error).message || 'Action failed' });
    }
  }, [isCommunityOwned, bot.userId, communityId, showSnackbar, onChanged]);

  return <div className='flex items-center justify-between gap-2 py-2'>
    <div className='flex items-center gap-2 overflow-hidden'>
      {imageUrl
        ? <img src={imageUrl} alt='' className='w-7 h-7 rounded-full object-cover' />
        : <Robot weight='duotone' className='w-7 h-7 cg-text-secondary' />}
      <div className='flex flex-col overflow-hidden'>
        <span className='cg-text-md-500 cg-text-main overflow-hidden text-ellipsis'>
          {userData ? getDisplayNameString(userData) : bot.userId}
        </span>
        <span className='cg-text-sm-400 cg-text-secondary'>
          {isCommunityOwned ? 'Community bot' : 'External bot'}
        </span>
      </div>
    </div>
    <div className='flex gap-1 shrink-0'>
      <Button role='secondary' text='Roles' onClick={onManageRoles} />
      <Button role='destructive' text={isCommunityOwned ? 'Disable' : 'Remove'} onClick={remove} />
    </div>
  </div>;
};

const BotManagement: React.FC = () => {
  const { community } = useLoadedCommunityContext();
  const { showSnackbar } = useSnackbarContext();
  const communityId = community.id;

  const [allowUserBots, setAllowUserBots] = useState(community.allowUserBots);
  const [savingToggle, setSavingToggle] = useState(false);
  const [installedBots, setInstalledBots] = useState<InstalledBot[] | undefined>(undefined);
  const [communityBotIds, setCommunityBotIds] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [roleModalBot, setRoleModalBot] = useState<InstalledBot | null>(null);

  const memberIds = useMemo(() => installedBots?.map(b => b.userId) ?? [], [installedBots]);
  const memberData = useMultipleUserData(memberIds);

  const load = useCallback(async () => {
    try {
      const [memberList, ownedBots] = await Promise.all([
        communityApi.getMemberList({ communityId, offset: 0, limit: MEMBER_FETCH_LIMIT }),
        botApi.listBots({ ownerType: 'community', ownerId: communityId }),
      ]);
      const entries = [...memberList.online, ...memberList.offline];
      setInstalledBots(entries.map(([userId, roleIds]) => ({ userId, roleIds })));
      setCommunityBotIds(new Set(ownedBots.map(b => b.userId)));
    } catch (e) {
      showSnackbar({ type: 'warning', text: 'Could not load bots' });
      setInstalledBots([]);
    }
  }, [communityId, showSnackbar]);

  useEffect(() => { load(); }, [load]);

  // Only the bot members (identities resolve to isBot) belong on this screen.
  const botMembers = useMemo(
    () => (installedBots ?? []).filter(b => memberData[b.userId]?.isBot),
    [installedBots, memberData],
  );

  const installedIdSet = useMemo(() => new Set((installedBots ?? []).map(b => b.userId)), [installedBots]);

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
    <div className='flex flex-col gap-2'>
      <span className='cg-heading-3'>Bots</span>
      <span className='cg-text-md-400 cg-text-secondary'>
        Bots are automated accounts that read and post in your channels through the Bot API.
      </span>
    </div>

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
          <Button role='secondary' text='Add existing' onClick={() => setAddOpen(true)} />
          <Button role='primary' text='Create bot' onClick={() => setCreateOpen(true)} />
        </div>
      </div>
      {installedBots === undefined
        ? <SkeletonLine minWidth={200} maxWidth={300} />
        : botMembers.length === 0
          ? <span className='cg-text-md-400 cg-text-secondary'>No bots in this community yet.</span>
          : <div className='flex flex-col'>
            {botMembers.map(bot => <InstalledBotRow
              key={bot.userId}
              bot={bot}
              userData={memberData[bot.userId]}
              communityId={communityId}
              isCommunityOwned={communityBotIds.has(bot.userId)}
              onManageRoles={() => setRoleModalBot(bot)}
              onChanged={load}
            />)}
          </div>}
    </div>

    <CreateCommunityBotModal
      isOpen={createOpen}
      communityId={communityId}
      onClose={() => setCreateOpen(false)}
      onCreated={load}
    />
    <AddExistingBotModal
      isOpen={addOpen}
      communityId={communityId}
      installedIds={installedIdSet}
      onClose={() => setAddOpen(false)}
      onInstalled={load}
    />
    {roleModalBot && <RoleAssignmentModal
      isOpen={!!roleModalBot}
      botUserId={roleModalBot.userId}
      botName={memberData[roleModalBot.userId] ? getDisplayNameString(memberData[roleModalBot.userId]!) : 'bot'}
      communityId={communityId}
      initialRoleIds={roleModalBot.roleIds}
      onClose={() => setRoleModalBot(null)}
      onSaved={load}
    />}
  </div>;
};

export default React.memo(BotManagement);
