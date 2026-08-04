// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import Button from 'components/atoms/Button/Button';
import { ArrowPathIcon } from '@heroicons/react/20/solid';
import TokenIcon from '../../atoms/icons/20/Token.svg?react';
import TokenRuleEditor from '../AccessRulesEditor/TokenRuleEditor';

import './RoleAccessEditor.css';
import { formatUnits } from 'viem';
import { HandArrowDown, HandDeposit, LockKey } from '@phosphor-icons/react';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { createSearchParams, useLocation, useNavigate } from 'react-router-dom';
import { getUrl } from 'common/util';

type Props = {
  assignmentRules: Models.Community.AssignmentRules | null;
  setAssignmentRules: (assignmentRules: Models.Community.AssignmentRules | null) => void;
  lockEditing?: boolean;
  community: Models.Community.DetailView;
  contractData?: Record<string, Models.Contract.Data>;
};

export type RuleData = {
  tokenId: string;
  amount: "loading..." | `${number}`;
  contractId: string;
};

const defaultRuleData: RuleData = {
  contractId: '',
  amount: '0',
  tokenId: ''
};

const RoleAccessEditor: React.FC<Props> = (props) => {
  const { assignmentRules, setAssignmentRules, lockEditing, community, contractData } = props;
  const { isMobile } = useWindowSizeContext();
  const navigate = useNavigate();
  const location = useLocation();

  const initialRuleData = useMemo(() => {
    const result: RuleData[] = [];
    if (assignmentRules?.type === 'token') {
      const { rule1 } = assignmentRules.rules;
      const _contract = contractData?.[rule1.contractId];
      let amount: 'loading...' | `${number}` = 'loading...';
      if (_contract) {
        amount = rule1.amount;
        if (_contract?.data.type === 'ERC20' || _contract?.data.type === 'LSP7') {
          amount = formatUnits(BigInt(amount), _contract.data.decimals) as `${number}`;
        }
      }
      result.push({
        tokenId: rule1.type === 'ERC1155' ? rule1.tokenId : '',
        amount,
        contractId: rule1.contractId,
      });
      if ('rule2' in assignmentRules.rules) {
        const { rule2 } = assignmentRules.rules;
        const _contract = contractData?.[rule2.contractId];
        let amount: 'loading...' | `${number}` = 'loading...';
        if (_contract) {
          amount = rule2.amount;
          if (_contract?.data.type === 'ERC20' || _contract?.data.type === 'LSP7') {
            amount = formatUnits(BigInt(amount), _contract.data.decimals) as `${number}`;
          }
        }
        result.push({
          tokenId: rule2.type === 'ERC1155' ? rule2.tokenId : '',
          amount,
          contractId: rule2.contractId,
        });
      }
    }
    return result;
  }, [contractData, assignmentRules]);
  
  const [ruleData, setRuleData] = useState<RuleData[]>(initialRuleData);
  const ruleCount = assignmentRules?.type === 'token' && "rule2" in assignmentRules.rules ? 2 : 1;
  const hasCommunityTokens = community.tokens.length > 0;
  const goToTokenPage = useCallback(() => {
    if (isMobile) {
      navigate(getUrl({ type: 'community-settings-token', community }));
    } else {
      navigate({
        pathname: location.pathname,
        search: createSearchParams({
          modal: 'token-management'
        }).toString()
      });
    }
  }, [community, isMobile, location.pathname, navigate]);

  useEffect(() => {
    let update = false;
    for (const rule of ruleData) {
      const contract = contractData?.[rule.contractId];
      if (contract && rule.amount === 'loading...') {
        update = true;
        break;
      }
    }
    if (update) {
      setRuleData(oldRuleData => {
        const fromUpdatedInitial = [...initialRuleData];
        const newData = oldRuleData.map(rule => {
          const contract = contractData?.[rule.contractId];
          if (contract && rule.amount === 'loading...') {
            const matchIndex = fromUpdatedInitial.findIndex(r => r.contractId === rule.contractId && r.tokenId === rule.tokenId);
            if (matchIndex > -1) {
              const [ item ] = fromUpdatedInitial.splice(matchIndex, 1);
              return item;
            }
          } 
          return rule;
        });
        return newData;
      });
    }
  }, [contractData, initialRuleData, ruleData]);

  const tokenEditorArea = useMemo(() => {
    if (assignmentRules?.type !== 'token') return null;

    const setGatingRule = (rule: 1 | 2) => (gatingRule: Models.Community.GatingRule | undefined) => {
      if (assignmentRules?.type !== 'token' || !gatingRule) return;

      if (rule === 1) {
        setAssignmentRules({
          type: 'token',
          rules: {
            ...assignmentRules.rules,
            rule1: gatingRule
          }
        });
      } else {
        setAssignmentRules({
          type: 'token',
          rules: {
            ...assignmentRules.rules,
            rule2: gatingRule
          }
        });
      }
    };

    const removeRule = (rule: 1 | 2) => () => {
      if (assignmentRules?.type !== 'token' || !('rule2' in assignmentRules.rules)) return;

      if (rule === 1) {
        setAssignmentRules({
          ...assignmentRules,
          rules: {
            rule1: assignmentRules.rules.rule2
          }
        });
        setRuleData(oldRuleData => ([oldRuleData[1], { ...defaultRuleData }]));
      } else {
        setAssignmentRules({
          ...assignmentRules,
          rules: {
            rule1: assignmentRules.rules.rule1
          }
        });
        setRuleData(oldRuleData => ([oldRuleData[0], { ...defaultRuleData }]));
      }
    };

    if (!hasCommunityTokens) {
      return <div className='flex flex-col p-4 gap-4 items-center cg-bg-subtle cg-border-xxl cg-simple-container border-dashed'>
        <div className='flex flex-col gap-2'>
          <span className='cg-text-lg-500 cg-text-main'>You haven’t set up a community token</span>
          <span className='cg-text-lg-400 cg-text-secondary'>Set up a token and use it to gate roles</span>
        </div>
        <Button
          role='primary'
          text='Set up community token'
          className='w-full'
          onClick={goToTokenPage}
        />
      </div>;
    }

    return <>
      {ruleData[0] && <TokenRuleEditor
        setGatingRule={setGatingRule(1)}
        ruleData={ruleData[0]}
        setRuleData={setRuleData}
        contractData={contractData}
        community={community}
        ruleIndex={0}
        goToTokenPage={goToTokenPage}
        onRemoveRule={ruleCount === 2 ? removeRule(1) : undefined}
      />}

      {ruleCount === 1 && hasCommunityTokens && <Button
        role='secondary'
        iconLeft={<TokenIcon />}
        text="Add another required token"
        onClick={() => {
          setAssignmentRules({
            type: 'token',
            rules: {
              rule1: assignmentRules.rules.rule1,
              logic: 'and',
              rule2: {
                type: 'ERC721',
                amount: '0',
                contractId: ''
              }
            }
          });
          setRuleData(oldRuleData => ([oldRuleData[0], { ...defaultRuleData }]));
        }}
      />}

      {'rule2' in assignmentRules.rules && <div className='relative flex items-center justify-center'>
        <div className='ruleButtonDivider' />
        <Button
          role='secondary'
          className='z-10'
          style={{ borderRadius: '50px' }}
          text={assignmentRules.rules.logic === 'and' ? 'And' : 'Or'}
          iconLeft={<ArrowPathIcon className='w-5 h-5' />}
          onClick={() => setAssignmentRules({
            ...assignmentRules,
            rules: {
              ...assignmentRules.rules,
              logic: 'rule2' in assignmentRules.rules && assignmentRules.rules.logic === 'and' ? 'or' : 'and'
            }
          })}
        />
      </div>}

      {ruleCount === 2 && ruleData[1] && <TokenRuleEditor
        setGatingRule={setGatingRule(2)}
        ruleData={ruleData[1]}
        setRuleData={setRuleData}
        contractData={contractData}
        community={community}
        ruleIndex={1}
        goToTokenPage={goToTokenPage}
        onRemoveRule={removeRule(2)}
      />}
    </>
  }, [assignmentRules, hasCommunityTokens, ruleData, ruleCount, contractData, community, goToTokenPage, setAssignmentRules]);

  return (<div className='flex flex-col gap-4 p-4 cg-bg-subtle cg-border-l'>
    <div className='flex flex-wrap gap-2'>
      <Button
        text='Assign'
        iconLeft={<HandDeposit className='w-5 h-5' weight='duotone' />}
        role='chip'
        active={!assignmentRules}
        onClick={() => setAssignmentRules(null)}
      />
      <Button
        text='Claim'
        iconLeft={<HandArrowDown className='w-5 h-5' weight='duotone' />}
        role='chip'
        active={assignmentRules?.type === 'free'}
        onClick={() => setAssignmentRules({ type: 'free' })}
      />
      <Button
        text='Token-gated'
        iconLeft={<LockKey className='w-5 h-5' weight='duotone' />}
        role='chip'
        active={assignmentRules?.type === 'token'}
        onClick={() => {
          setAssignmentRules({
            type: 'token',
            rules: {
              rule1: {
                amount: '0',
                contractId: '',
                tokenId: '0',
                type: 'ERC1155'
              }
            }
          });
          setRuleData([{ ...defaultRuleData }]);
        }}
      />
    </div>

    {!assignmentRules && <span className='cg-text-md-400 cg-text-secondary'>This role must be assigned by an Admin or Plugin</span>}
    {assignmentRules?.type === 'free' && <span className='cg-text-md-400 cg-text-secondary'>This role can be claimed by anyone, no assigning needed!</span>}
    {assignmentRules?.type === 'token' && <span className='cg-text-md-400 cg-text-secondary'>This role can be claimed by people with the right token/s.{hasCommunityTokens && <>You can set up a community token <span className='cursor-pointer underline' onClick={goToTokenPage}>here</span></>}</span>}
    {tokenEditorArea}
  </div>
  );
}

export default React.memo(RoleAccessEditor);