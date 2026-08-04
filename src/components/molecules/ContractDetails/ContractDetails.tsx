// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from "react";
import './ContractDetails.css';
import { formatUnits } from 'viem';
import config from "common/config";
import { getTruncatedId } from "../../../util";
import { CheckBadgeIcon } from "@heroicons/react/20/solid";
import { useSnackbarContext } from "context/SnackbarContext";
import { ArrowTopRightOnSquareIcon, ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import { useContractData } from "context/CommunityProvider";

type Props = {
  assignmentRules: Models.Community.AssignmentRules;
  contractData: Record<string, Models.Contract.Data>;
  locked: boolean;
}

const ContractDetails: React.FC<Props> = (props) => {
  const { assignmentRules, contractData, locked } = props;

  if (assignmentRules.type !== 'token') {
    return null;
  }

  return (<div className='flex flex-col gap-2 items-start self-stretch'>
    <div className="flex justify-between items-center gap-1">
      <span className="cg-text-lg-400 cg-text-secondary py-1 flex-1">Requirements</span>
      {!locked && <CheckBadgeIcon className="w-5 h-5 cg-text-main"/>}
    </div>
    <RuleDetail
      contracts={contractData}
      rule={assignmentRules.rules.rule1}
    />
    {'rule2' in assignmentRules.rules && <>
      <span className="w-full text-center">
        {assignmentRules.rules.logic === 'and' ? 'And' : 'Or'}
      </span>
      <RuleDetail
        contracts={contractData}
        rule={assignmentRules.rules.rule2}
      />
    </>}
  </div>);
}

type RuleDetailProps = {
  contracts: Record<string, Models.Contract.Data>;
  rule: Models.Community.GatingRule;
}

const RuleDetail: React.FC<RuleDetailProps> = (props) => {
  const { contracts, rule } = props;
  const contract = contracts[rule.contractId];
  const { showSnackbar } = useSnackbarContext();

  if (!contract) {
    return null;
  }

  const copyToClipboard = () => {
    navigator.clipboard.writeText(contract.address);
    showSnackbar({type: 'info', text: 'Contract address copied to clipboard'});
  };

  const copyTokenIdToClipboard = (tokenId: string) => {
    navigator.clipboard.writeText(tokenId);
    showSnackbar({type: 'info', text: 'Token ID copied to clipboard'});
  };

  return (
    <div className="rule-details p-4 flex flex-col cg-text-lg-400 cg-border-xxl self-stretch">
      <span className="cg-text-lg-500 cg-text-main">
        Hold at least {formatUnits(BigInt(rule.amount), contract.data.type === "ERC20" || contract.data.type === 'LSP7' ? contract.data.decimals : 0)}
        {" "}
        {contract.data.type !== "ERC1155" ? contract.data.symbol : contract.data.name || 'ERC1155'}
      </span>
      {rule.type === "ERC1155" && <span className="cg-text-secondary" style={{wordBreak: 'break-all'}}>
        Token ID&nbsp;{rule.tokenId.length >= 10 ? rule.tokenId.slice(0, 3) + '...' + rule.tokenId.slice(-3) : rule.tokenId} <ClipboardDocumentIcon className="w-5 h-5 ml-2 inline-block cursor-pointer" onClick={() => copyTokenIdToClipboard(rule.tokenId)} /><br/>
      </span>}
      <span className="cg-text-secondary">
        <span>
          Contract&nbsp;{getTruncatedId(contract.address)}
          <ClipboardDocumentIcon className="w-5 h-5 ml-2 inline-block cursor-pointer" onClick={copyToClipboard} />
          <a href={config.AVAILABLE_CHAINS[contract.chain].link(contract.address)} target="_blank"><ArrowTopRightOnSquareIcon className="w-5 h-5 ml-1 inline-block cursor-pointer" /></a>
        </span>
      </span>
      <span className="cg-text-secondary">
        on {config.AVAILABLE_CHAINS[contract.chain].title}
      </span>
    </div>
  );
}

export default React.memo(ContractDetails);