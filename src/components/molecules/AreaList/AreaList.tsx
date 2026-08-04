// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useState } from 'react';

import { formatUnits } from 'viem';
import config from '../../../common/config';
import { CommunityPermission } from 'common/enums';
import contractApi from '../../../data/api/contract';
import { getTruncatedId } from '../../../util';

import useLocalStorage, { ExpandedAreasState } from '../../../hooks/useLocalStorage';
import { useLoadedCommunityContext } from 'context/CommunityProvider';

import Button from '../../atoms/Button/Button';
import Modal from '../../atoms/Modal/Modal';
import { MemoAreaItem } from './AreaItem';

import "./AreaList.css";
import { ArrowSquareOut } from '@phosphor-icons/react';

export type ModalData = { accessrules: Models.Community.AccessRules, areaName: string } | undefined;

type Props = {
  handleCloseSidebar?: () => void;
};

export function AreaList(props: Props) {
  const { handleCloseSidebar } = props;
  const { areas, channels, communityPermissions } = useLoadedCommunityContext();

  const [expandedAreasState, setExpandedAreasState] = useLocalStorage<ExpandedAreasState>({}, 'expanded-areas-state');
  // const [expandedLocked, setExpandedLocked] = useState(false);
  const emptyAreasVisible = communityPermissions.has(CommunityPermission.COMMUNITY_MANAGE_CHANNELS);

  const areaElements = React.useMemo(() => {
    const setAreaExpandedState = (areaId: string) => {
      setExpandedAreasState(oldState => {
        const expandedAreasStateCopy = { ...oldState };
        if (expandedAreasStateCopy[areaId] === true || expandedAreasStateCopy[areaId] === undefined) {
          expandedAreasStateCopy[areaId] = false;
        } else {
          expandedAreasStateCopy[areaId] = true;
        }
        return expandedAreasStateCopy;
      });
    }

    // Todo: Remove related css classes?
    /*
    const lockedAreasChevronClassname = `area-chevron-icon ${expandedLocked ? '' : 'area-chevron-icon-rotated'}`;
    {!!lockedAreas && lockedAreas.length > 0 && <div className={`locked-area-toggle ${expandedLocked ? 'expanded' : ''}`} onClick={() => setExpandedLocked(old => !old)}>
      <LockClosedIcon />
      <span>Locked areas</span>
      <div className='locked-area-toggle-number'>{lockedAreas.length}</div>
      <ChevronDownIcon className={lockedAreasChevronClassname} />
    </div>}
    */

    const areaElements = areas.reduce<React.JSX.Element[]>((agg, area) => {
      const areaChannels = channels.filter(ch => ch.areaId === area.id);
      // Check if area contains channels. If not, then
      // only show the (empty) area if the user has permissions
      // to edit the community channels & areas
      if (areaChannels.length > 0 || emptyAreasVisible) {
        agg.push(
          <MemoAreaItem
            area={area}
            channels={areaChannels}
            key={area.id}
            expanded={expandedAreasState[area.id] === true || expandedAreasState[area.id] === undefined}
            setExpandedState={setAreaExpandedState}
            onChannelClick={handleCloseSidebar}
          />
        );
      }
      return agg;
    }, []);

    return <>
      <div>
        {areaElements}
      </div>
    </>
  }, [areas, setExpandedAreasState, channels, emptyAreasVisible, expandedAreasState, handleCloseSidebar])

  return (
    <div className="area-list">
      {areaElements}
      {/* TODO: {communityType === 'unjoined' && areas?.sort(sortAreasByOrder).map(area => <ReducedAreaItem area={area} key={area.id} setModalData={openModal} />)} */}
      {/* TODO: {modalData && <AccessRuleModal accessrules={modalData.accessrules} areaName={modalData.areaName} close={closeModal} />} */}
    </div>
  );
}


// Todo: move this to channels? Also, make it show role
// requirements instead of the old accessRules

// If ever used again, fix contractData by using useContractData hook
function AccessRuleModal(props: { accessrules: Models.Community.AccessRules, areaName: string, close: () => void }) {
  const { accessrules, areaName, close } = props;
  const [contractData, setContractData] = useState<Record<string, Models.Contract.Data> | undefined>(undefined);

  useEffect(() => {
    const load = async () => {
      const contractIds = [accessrules.rule1.contractId];
      if ("rule2" in accessrules) {
        contractIds.push(accessrules.rule2.contractId);
      }
      const data = await contractApi.getContractDataByIds({ contractIds });
      const newContractData = data.reduce<Record<string, Models.Contract.Data>>((agg, cd) => {
        agg[cd.id] = cd;
        return agg;
      }, {});
      setContractData(newContractData);
    };
    load();
  }, [accessrules]);

  const ruleData: React.JSX.Element[] = [];
  if (!!contractData) {
    ruleData.push(
      <ContractDetails rule={accessrules.rule1} contracts={contractData} />
    );
    if ("rule2" in accessrules) {
      ruleData.push(
        <div className="py-4">{accessrules.logic === "and" ? "AND" : "OR"}</div>,
        <ContractDetails rule={accessrules.rule2} contracts={contractData} />
      )
    }
  }

  return (
    <Modal
      headerText="Restricted access"
      close={close}
    >
      <div className="modal-inner">
        <div className="mb-8">
          <b>{areaName}</b> is restricted with token gating rules.
        </div>
        {ruleData}
        <div className="flex justify-center mt-4">
          <Button
            className='btnSecondary accessrule-modal-close-btn w-full py-3 rounded'
            onClick={close}
            text='Close'
          />
        </div>
      </div>
    </Modal>
  );
}

const ContractDetails = (props: { contracts: Record<string, Models.Contract.Data>, rule: Models.Community.GatingRule }) => {
  const { contracts, rule } = props;
  const contract = contracts[rule.contractId];
  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-1">
        {contract.data.type !== "ERC1155" ? (
          <>
            <div>
              {contract.data.name}
            </div>
            <div className="p-1 rounded text-sm" style={{ backgroundColor: '#FFFFFF18' }}>
              {contract.data.symbol}
            </div>
          </>
        ) : (
          <div>
            ERC1155
          </div>
        )}
        <div className="flex-grow" />
        <div className="py-1 px-2 rounded" style={{ backgroundColor: '#F9F9F9', color: '#242424', fontWeight: '500' }}>
          {formatUnits(BigInt(rule.amount), contract.data.type === "ERC20" ? contract.data.decimals : 0)}
        </div>
      </div>
      <div className="mb-1">
        {config.AVAILABLE_CHAINS[contract.chain].title}
      </div>
      <div className="flex items-center gap-3">
        <span>{getTruncatedId(contract.address)}</span>
        <a href={config.AVAILABLE_CHAINS[contract.chain].link(contract.address)} rel="noreferrer" target="_blank"><ArrowSquareOut className='w-5 h-5' /></a>
      </div>
    </>
  );
}