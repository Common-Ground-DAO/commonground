// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import community from '../../../data/api/community';
import { dataStateReducer, Filters, initialState } from './CommunityExplorer.reducer';
import { useWindowSizeContext } from '../../../context/WindowSizeProvider';

import Button from '../../atoms/Button/Button';
import CreateCommunityButton from '../../molecules/CreateCommunityButton/CreateCommunityButton';
import { ReactComponent as ChevronDownIcon } from '../../../components/atoms/icons/16/ChevronDown.svg';
import Dropdown from '../../molecules/Dropdown/Dropdown';
import DropdownItem from '../../atoms/ListItem/ListItem';
import GroupSlider from 'components/molecules/GroupSlider/GroupSlider';
import CreateCommunityBanner from 'components/molecules/CreateCommunityBanner/CreateCommunityBanner';

import './CommunityExplorer.css'
import { getUrl } from 'common/util';
import TagHeader from '../TagHeader/TagHeader';
import { PredefinedTag } from 'components/molecules/inputs/TagInputField/predefinedTags';

type Props = {
  mode: 'limited' | 'unlimited';
  search?: string;
  loadingAmount?: number;
  useLargeHeader?: boolean;
}

const tabOptions: { text: string, value: Filters }[] = [
  { text: '🔥 Most active', value: 'popular' },
  { text: '✨ New', value: 'new' },
];

const CommunityExplorer: React.FC<Props> = ({ mode, loadingAmount, search, useLargeHeader }) => {
  const { isMobile, isSmallTablet, isTablet } = useWindowSizeContext();
  const navigate = useNavigate();
  const isLimitedMode = mode === 'limited';
  const [dataState, dispatch] = React.useReducer(dataStateReducer, initialState);
  const [activeTab, setActiveTab] = React.useState<Filters>("popular");
  const [activeTags, setActiveTags] = React.useState<PredefinedTag[]>([]);

  // const globalTagData = useLiveQuery(async () => {
  //   return await data.community.getGlobalCommunityTagData();
  // })

  const MAX_CONTENT = useMemo((): number | undefined => {
    if (isLimitedMode) {
      if (!isMobile) {
        return 3;
      } else {
        return 5;
      }
    }
    return undefined;
  }, [isLimitedMode, isMobile]);

  const calculatedLoadingAmount = useMemo(() => {
    if (!loadingAmount && !MAX_CONTENT) {
      return 6;
    }
    if (!loadingAmount && !!MAX_CONTENT) {
      return MAX_CONTENT;
    }
    if (!!loadingAmount && !!MAX_CONTENT && loadingAmount > MAX_CONTENT) {
      return MAX_CONTENT;
    }
    return loadingAmount;
  }, [loadingAmount, MAX_CONTENT]);

  const updateFiltersAndRefresh = React.useCallback(async (tab: Filters, search?: string) => {
    dispatch({
      type: 'ClearAndLoad',
      filterTab: tab,
      filterTag: '',
      tags: [],
      search: search || undefined,
    });

    const communityList = await community.getCommunityList({
      offset: 0,
      sort: activeTab,
      tags: activeTags.map(tag => tag.name),
      limit: isLimitedMode ? MAX_CONTENT : undefined,
      search: search || undefined,
    });

    dispatch({
      type: 'UpdateFreshData',
      communityList: isLimitedMode ? communityList.slice(0, MAX_CONTENT) : communityList // do we really need it? it should be stricted by getCommunityList
    });
  }, [activeTab, activeTags, isLimitedMode, MAX_CONTENT]);

  const loadMoreGroups = React.useCallback(async () => {
    if (dataState.stateNode !== 'IDLE') return;
    dispatch({ type: 'StartLoading' });

    const communityList = await community.getCommunityList({
      offset: dataState.communityList.length,
      sort: activeTab,
      tags: activeTags.map(tag => tag.name),
      search: search || undefined,
    });

    dispatch({
      type: 'AppendGroups',
      communityList
    });
  }, [activeTab, activeTags, dataState.communityList.length, dataState.stateNode, search]);

  // Initial load
  React.useEffect(() => {
    updateFiltersAndRefresh(activeTab, search);
  }, [updateFiltersAndRefresh, activeTab, search]);

  const selectedOption = tabOptions.find(opt => opt.value === dataState.filterTab);

  const containerClassName: string[] = ["groupExplorer-group-container"];
  if (isMobile) {
    containerClassName.push("mobile")
    containerClassName.push("grid-view");
  } else if (isSmallTablet) {
    containerClassName.push("smallTablet");
  } else if (isTablet) {
    containerClassName.push("tablet");
  }

  return (
    <div className={`flex flex-col gap-4${isMobile ? ' px-4' : ''}`}>
      {!isLimitedMode && <>
        <div>
          <CreateCommunityBanner />
        </div>
        <TagHeader
          preTagElements={<Dropdown
            placement='bottom-start'
            triggerClassname='h-fit'
            triggerContent={<Button className='groupExplorer-dropdown-button' text={selectedOption?.text || ''} role='textual' iconRight={<ChevronDownIcon />} />}
            items={tabOptions.map(opt => <DropdownItem key={opt.value} title={opt.text} selected={dataState.filterTab === opt.value} onClick={() => setActiveTab(opt.value)} />)}
          />}
          activeTags={activeTags}
          setActiveTags={setActiveTags}
        />
      </>}
      <div className='h-full w-full flex flex-col'>
        <GroupSlider
          communities={dataState.communityList}
          mobileMode={isLimitedMode ? 'slider' : 'grid'}
          isLoading={dataState.stateNode === 'LOADING'}
          loadingGhostCount={calculatedLoadingAmount}
          loadMore={loadMoreGroups}
          useLargeCards
        />
      </div>
      <div className='flex justify-center'>
        {isLimitedMode && <Button role='secondary' text='Find more' onClick={() => navigate(getUrl({ type: 'browse-communities' }))} />}
        {!isLimitedMode && dataState.stateNode === 'DONE' && <div className='cta-buttons'>
          <Button role='secondary' text='Home' onClick={() => navigate(getUrl({ type: 'home' }))} />
          <CreateCommunityButton role='primary' text='Create your community' />
        </div>}
      </div>
    </div>
  );
}

export default React.memo(CommunityExplorer);
