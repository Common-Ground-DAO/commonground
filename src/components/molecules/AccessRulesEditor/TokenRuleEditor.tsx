// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useEffect, useMemo } from "react";
import config from '../../../common/config';
import TextInputField from "../../molecules/inputs/TextInputField/TextInputField";
import { parseUnits } from "viem";
import { RuleData } from "../RoleAccessEditor/RoleAccessEditor";

import { useNavigationContext } from "components/SuspenseRouter/SuspenseRouter";

import './AccessRulesEditor.css';
import ExternalIcon, { ExternalIconType } from "components/atoms/ExternalIcon/ExternalIcon";
import CheckboxBase from "components/atoms/CheckboxBase/CheckboxBase";
import { XCircleIcon } from "@heroicons/react/24/solid";
import { WarningCircle } from "@phosphor-icons/react";
import { Tooltip } from "components/atoms/Tooltip/Tooltip";

type Props = {
  setGatingRule: (gatingRule: Models.Community.GatingRule | undefined) => void;
  ruleData: RuleData;
  setRuleData: React.Dispatch<React.SetStateAction<RuleData[]>>;
  contractData?: Record<string, Models.Contract.Data>;
  community: Models.Community.DetailView;
  ruleIndex: number;
  goToTokenPage: () => void;
  onRemoveRule?: () => void;
};

export default function TokenRuleEditor(props: Props) {
  const {
    setGatingRule,
    ruleData,
    setRuleData: _setRuleData,
    contractData,
    community,
    ruleIndex,
  } = props;
  const { amount, tokenId } = ruleData;
  const { setDirty } = useNavigationContext();
  const contract = !!ruleData.contractId ? contractData?.[ruleData.contractId] as Models.Contract.Data | undefined : undefined;
  const activeChains = useMemo(() => new Set(config.ACTIVE_CHAINS), []);

  const amountRegex = useMemo(() => {
    switch (contract?.data.type) {
      case "ERC20":
      case "LSP7":
        if (contract.data.decimals > 0) {
          return /^\d+(\.\d+)?$/;
        }
        break;
    }
    return /^\d+$/;
  }, [contract]);

  const getAmountPlaceholder = useMemo(() => (_contract?: Models.Contract.Data) => {
    if (!!_contract) {
      switch (_contract.data.type) {
        case "ERC20":
        case "LSP7":
          if (_contract.data.decimals > 0) {
            return "0.0";
          }
      }
    }
    return "0";
  }, []);

  const setRuleData = useCallback((updateFunc: ((oldRuleData: RuleData) => RuleData)) => {
    _setRuleData(oldRuleData => {
      const newData = [...oldRuleData];
      newData[ruleIndex] = updateFunc(newData[ruleIndex]);
      return newData
    })
  }, [_setRuleData, ruleIndex]);

  const checkGatingRules = useCallback((_amount: string, _tokenId: string) => {
    try {
      if (
        !!contract &&
        _amount.match(amountRegex) &&
        (contract.data.type !== "ERC1155" || _tokenId.match(/^\d+$/))
      ) {
        switch (contract.data.type) {
          case "ERC20": {
            const parsedAmount = parseUnits(_amount, contract.data.decimals);
            if (parsedAmount <= BigInt(0)) {
              throw new Error();
            }
            const rule: Models.Community.GatingRuleERC20 = {
              type: "ERC20",
              amount: parsedAmount.toString() as `${number}`,
              contractId: contract.id,
            };
            setGatingRule(rule);
            break;
          }
          case "ERC721": {
            const parsedAmount = BigInt(_amount);
            if (parsedAmount <= 0) {
              throw new Error();
            }
            const rule: Models.Community.GatingRuleERC721 = {
              type: "ERC721",
              amount: parsedAmount.toString() as `${number}`,
              contractId: contract.id,
            };
            setGatingRule(rule);
            break;
          }
          case "ERC1155": {
            const parsedAmount = BigInt(_amount);
            if (parsedAmount <= 0) {
              throw new Error();
            }
            const rule: Models.Community.GatingRuleERC1155 = {
              type: "ERC1155",
              amount: parsedAmount.toString() as `${number}`,
              tokenId: _tokenId as `${number}`,
              contractId: contract.id,
            };
            setGatingRule(rule);
            break;
          }
          case "LSP7": {
            const parsedAmount = parseUnits(_amount, contract.data.decimals);
            if (parsedAmount <= BigInt(0)) {
              throw new Error();
            }
            const rule: Models.Community.GatingRuleLSP7 = {
              type: "LSP7",
              amount: parsedAmount.toString() as `${number}`,
              contractId: contract.id,
            };
            setGatingRule(rule);
            break;
          }
          case "LSP8": {
            const parsedAmount = BigInt(_amount);
            if (parsedAmount <= 0) {
              throw new Error();
            }
            const rule: Models.Community.GatingRuleLSP8 = {
              type: "LSP8",
              amount: parsedAmount.toString() as `${number}`,
              contractId: contract.id,
            };
            setGatingRule(rule);
            break;
          }
        }
      } else {
        throw new Error();
      }
    } catch (e) {
      setGatingRule(undefined);
    }
  }, [amountRegex, contract, setGatingRule]);

  const setAmountAndCheck = (value: `${number}`) => {
    setRuleData(oldData => ({ ...oldData, amount: value }));
    checkGatingRules(value, tokenId);
  }

  const setTokenIdAndCheck = (value: string) => {
    setRuleData(oldData => ({ ...oldData, tokenId: value }));
    checkGatingRules(amount, value);
  }

  const setContractAndClear = useCallback((value: string) => {
    setDirty(true);
    setRuleData(oldData => ({ ...oldData, contractId: value, tokenId: '', amount: '0' }));
    setGatingRule(undefined);
  }, [setDirty, setGatingRule, setRuleData]);

  // Autofilling first entry
  useEffect(() => {
    if (!contract?.id && community.tokens.length > 0) {
      setContractAndClear(community.tokens[0].contractId);
    }
  }, [community.tokens, contract?.id, props.ruleIndex, setContractAndClear]);

  return (<div className="flex flex-col gap-4 cg-text-main">
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <span className="cg-text-lg-500">Select required token</span>
        {props.onRemoveRule && <XCircleIcon className='w-6 h-6 cursor-pointer' onClick={props.onRemoveRule} />}
      </div>
      {community.tokens.map(t => {
        const data = contractData?.[t.contractId] as Models.Contract.Data | undefined;
        const chain = data ? config.AVAILABLE_CHAINS[data.chain] : null;
        const isInactive = !!data?.chain && !activeChains.has(data?.chain);
        return (<div
          key={t.contractId}
          className="flex gap-2 py-2 px-4 items-center self-stretch cg-bg-subtle cg-border-xxl cursor-pointer"
          onClick={() => {
            if (!isInactive) setContractAndClear(t.contractId);
          }}
        >
          <ExternalIcon type={(chain?.title.toLocaleLowerCase() || '') as ExternalIconType} className="w-5 h-5" />
          <span className="flex-1 cg-text-lg-500">{data?.data.name || data?.address}{!!data?.data.type ? ` (${data.data.type})` : ''}</span>
          {!isInactive && <CheckboxBase type="radio" size="normal" checked={contract?.id === t.contractId} />}
          {isInactive && <Tooltip
            placement="top"
            offset={6}
            triggerContent={
              <span className='cg-text-error mr-1'><WarningCircle className='w-5 h-5' weight='duotone' /></span>
            }
            tooltipContent={<span>This chain is inactive. Roles with this token can not be created anymore, and cannot be claimed.</span>}
          />}
        </div>);
      })}
    </div>
    <div className="flex w-full items-center justify-center">
      <span className="cg-text-md-400 cg-text-secondary underline cursor-pointer" onClick={props.goToTokenPage}>Or create a new token</span>
    </div>
    {contract?.data.type === 'ERC1155' && <TextInputField
      value={tokenId}
      onChange={tokenId => setTokenIdAndCheck(tokenId)}
      label="Token ID"
      placeholder="id"
      inlineToast={tokenId.match(/^\d+$/) ? "done" : undefined}
      forceShowToast={true}
    />}
    <TextInputField
      value={amount}
      disabled={amount === 'loading...'}
      onChange={amount => setAmountAndCheck(amount as `${number}`)}
      label="Set Required amount"
      placeholder={getAmountPlaceholder(contract)}
      inlineToast={amount.match(amountRegex) ? "done" : undefined}
      forceShowToast={true}
    />
  </div>);
}