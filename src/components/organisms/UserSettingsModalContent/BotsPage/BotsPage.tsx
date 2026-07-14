// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useState } from 'react';
import { ChevronRightIcon, PlusIcon } from '@heroicons/react/20/solid';
import { Robot } from '@phosphor-icons/react';
import UserSettingsButton from 'components/molecules/UserSettingsButton/UserSettingsButton';
import SkeletonLine from 'components/atoms/SkeletonLine/SkeletonLine';
import { useOwnUser } from 'context/OwnDataProvider';
import { useSignedUrl } from 'hooks/useSignedUrl';
import botApi from 'data/api/bot';
import { PageType } from '../UserSettingsModalContent';

type Props = {
  setPage: (pageType: PageType) => void;
  selectBot: (bot: API.Bot.BotView | null, owner: API.Bot.Owner) => void;
};

const BotRow: React.FC<{ bot: API.Bot.BotView; onClick: () => void }> = ({ bot, onClick }) => {
  const imageUrl = useSignedUrl(bot.imageId);
  return <UserSettingsButton
    leftElement={imageUrl
      ? <img src={imageUrl} alt='' className='w-6 h-6 rounded-full object-cover' />
      : <Robot weight='duotone' className='w-6 h-6 cg-text-secondary' />}
    text={bot.displayName}
    rightElement={<ChevronRightIcon className='w-5 h-5' />}
    onClick={onClick}
  />;
};

const BotsPage: React.FC<Props> = ({ setPage, selectBot }) => {
  const ownUser = useOwnUser();
  const [userBots, setUserBots] = useState<API.Bot.BotView[] | undefined>(undefined);
  const [platformBots, setPlatformBots] = useState<API.Bot.BotView[] | undefined>(undefined);
  const [isPlatformOperator, setIsPlatformOperator] = useState(false);

  const load = useCallback(async () => {
    if (!ownUser) return;
    const userOwner: API.Bot.Owner = { ownerType: 'user', ownerId: ownUser.id };
    try {
      setUserBots(await botApi.listBots(userOwner));
    } catch {
      setUserBots([]);
    }
    // Platform-bot management is authorized server-side by PLATFORM_OPERATOR_USER_IDS;
    // the frontend can't know that list, so probe: a NOT_ALLOWED means "not an operator".
    try {
      const bots = await botApi.listBots({ ownerType: 'platform', ownerId: null });
      setIsPlatformOperator(true);
      setPlatformBots(bots);
    } catch {
      setIsPlatformOperator(false);
    }
  }, [ownUser]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = useCallback((owner: API.Bot.Owner) => {
    selectBot(null, owner);
    setPage('bot-editor');
  }, [selectBot, setPage]);

  const openBot = useCallback((bot: API.Bot.BotView) => {
    selectBot(bot, { ownerType: bot.ownerType, ownerId: bot.ownerId });
    setPage('bot-editor');
  }, [selectBot, setPage]);

  return <div className='flex flex-col px-4 gap-4 cg-text-main'>
    <span className='cg-text-md-400 cg-text-secondary'>
      Bots are programmable accounts you control through the Bot API. Create one, then
      issue a token to authenticate your own script or service.
    </span>

    <div className='flex flex-col gap-2'>
      <span className='cg-text-sm-500 cg-text-secondary'>Your bots</span>
      {userBots === undefined
        ? <SkeletonLine minWidth={200} maxWidth={300} />
        : userBots.length === 0
          ? <span className='cg-text-md-400 cg-text-secondary py-1'>You have no bots yet.</span>
          : userBots.map(bot => <BotRow key={bot.userId} bot={bot} onClick={() => openBot(bot)} />)}
      <UserSettingsButton
        leftElement={<PlusIcon className='w-5 h-5' />}
        text='Create a bot'
        rightElement={<ChevronRightIcon className='w-5 h-5' />}
        onClick={() => openCreate({ ownerType: 'user', ownerId: ownUser?.id ?? null })}
      />
    </div>

    {isPlatformOperator && <>
      <div className='cg-separator' />
      <div className='flex flex-col gap-2'>
        <span className='cg-text-sm-500 cg-text-secondary'>Platform bots</span>
        <span className='cg-text-sm-400 cg-text-secondary'>
          Instance-wide bots you manage as a platform operator.
        </span>
        {platformBots === undefined
          ? <SkeletonLine minWidth={200} maxWidth={300} />
          : platformBots.length === 0
            ? <span className='cg-text-md-400 cg-text-secondary py-1'>No platform bots yet.</span>
            : platformBots.map(bot => <BotRow key={bot.userId} bot={bot} onClick={() => openBot(bot)} />)}
        <UserSettingsButton
          leftElement={<PlusIcon className='w-5 h-5' />}
          text='Create a platform bot'
          rightElement={<ChevronRightIcon className='w-5 h-5' />}
          onClick={() => openCreate({ ownerType: 'platform', ownerId: null })}
        />
      </div>
    </>}
  </div>;
};

export default React.memo(BotsPage);
