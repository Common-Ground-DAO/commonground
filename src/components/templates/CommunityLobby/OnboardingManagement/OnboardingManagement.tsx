// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './OnboardingManagement.css';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HandWaving, Keyhole, ListChecks, LockKey, UserCirclePlus } from '@phosphor-icons/react';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import ManagementHeader2 from 'components/molecules/ManagementHeader2/ManagementHeader2';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import ToggleInputField from 'components/molecules/inputs/ToggleInputField/ToggleInputField';
import MultiEntryField from 'components/molecules/inputs/MultiEntryField/MultiEntryField';
import OnboardingQuestions from './OnboardingQuestions/OnboardingQuestions';
import TextAreaField from 'components/molecules/inputs/TextAreaField/TextAreaField';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import FloatingSaveOptions from '../FloatingSaveOptions/FloatingSaveOptions';
import { useNavigationContext } from 'components/SuspenseRouter/SuspenseRouter';
import communityApi from 'data/api/community';
import { useSnackbarContext } from 'context/SnackbarContext';
import OnboardingRequirements from './OnboardingRequirements/OnboardingRequirements';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import PasswordField from 'components/molecules/PasswordField/PasswordField';

const RULE_LIMIT = 5;

const OnboardingManagement: React.FC = () => {
  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const { community } = useLoadedCommunityContext();
  const { isDirty, setDirty } = useNavigationContext();
  const { showSnackbar } = useSnackbarContext();

  const isInitialized = useRef<boolean>(false);
  const [manuallyApprove, setManuallyApprove] = useState(community.onboardingOptions?.manuallyApprove?.enabled || false);
  const [customWelcome, setCustomWelcome] = useState(community.onboardingOptions?.customWelcome?.enabled || false);
  const [questionnaireEnabled, setQuestionnaireEnabled] = useState(community.onboardingOptions?.questionnaire?.enabled || false);
  const [requirementsEnabled, setRequirementsEnabled] = useState(community.onboardingOptions?.requirements?.enabled || false);
  const [passwordProtected, setPasswordProtected] = useState(community.onboardingOptions?.passwordProtected?.enabled || false);

  const [welcomeString, setWelcomeString] = useState(community.onboardingOptions?.customWelcome?.welcomeString || 'Welcome to {community}!');
  const [rules, setRules] = useState(community.onboardingOptions?.customWelcome?.rules || []);
  const [questions, setQuestions] = useState(community.onboardingOptions?.questionnaire?.questions || []);
  const [requirements, setRequirements] = useState<NonNullable<Models.Community.OnboardingOptions['requirements']>>(community.onboardingOptions?.requirements || {});
  const [showErrors, setShowErrors] = useState(false);
  const [password, setPassword] = useState('');

  const originalPassword = useAsyncMemo(async () => {
    const result = await communityApi.getCommunityPassword({ communityId: community.id });
    setPassword(result.password || '');
    return result.password;
  }, [community.id]);

  useEffect(() => {
    if (isInitialized.current) {
      setDirty(true);
    } else {
      isInitialized.current = true;
    }
  }, [manuallyApprove, customWelcome, questionnaireEnabled, requirementsEnabled, passwordProtected, welcomeString, rules, questions, requirements, setDirty]);

  const onDiscard = useCallback(() => {
    setManuallyApprove(community.onboardingOptions?.manuallyApprove?.enabled || false);
    setCustomWelcome(community.onboardingOptions?.customWelcome?.enabled || false);
    setQuestionnaireEnabled(community.onboardingOptions?.questionnaire?.enabled || false);
    setRequirementsEnabled(community.onboardingOptions?.requirements?.enabled || false);
    setPasswordProtected(community.onboardingOptions?.passwordProtected?.enabled || false);

    setWelcomeString(community.onboardingOptions?.customWelcome?.welcomeString || 'Welcome to {community}!');
    setRules(community.onboardingOptions?.customWelcome?.rules || []);
    setQuestions(community.onboardingOptions?.questionnaire?.questions || []);
    setRequirements(community.onboardingOptions?.requirements || {});
    setPassword(originalPassword || '');

    setTimeout(() => {
      setDirty(false);
    }, 1);
  }, [community, originalPassword, setDirty]);

  const onSave = useCallback(async () => {
    try {
      let request: API.Community.setOnboardingOptions.Request = {
        communityId: community.id,
        onboardingOptions: {},
        password: null
      };

      if (customWelcome) {
        request.onboardingOptions.customWelcome = {
          enabled: customWelcome,
          rules,
          welcomeString
        }
      }

      if (manuallyApprove) {
        request.onboardingOptions.manuallyApprove = {
          enabled: manuallyApprove
        }
      }

      if (questionnaireEnabled && questions.length > 0) {
        request.onboardingOptions.questionnaire = {
          enabled: questionnaireEnabled,
          questions: questions.map(question => ({
            ...question,
            options: question.type !== 'text' ? question.options : []
          }))
        }
      }

      if (requirementsEnabled) {
        request.onboardingOptions.requirements = {
          ...requirements,
          enabled: requirementsEnabled
        }
      }

      if (passwordProtected) {
        request.onboardingOptions.passwordProtected = {
          enabled: passwordProtected
        }
        request.password = password;
      }

      await communityApi.setOnboardingOptions(request);
      setDirty(false);
      setShowErrors(false);
    } catch (e) {
      showSnackbar({ type: 'warning', text: 'Something went wrong, check your inputs and try again' });
      setShowErrors(true);
    }
  }, [community.id, customWelcome, manuallyApprove, questionnaireEnabled, requirementsEnabled, passwordProtected, setDirty, rules, welcomeString, questions, requirements, password, showSnackbar]);

  const header = useMemo(() => (
    <ManagementHeader2
      title='Onboarding'
      help={<>
        <span>Welcome people to your community with a custom welcome message, collect information about new members with a questionnaire, or control who can join your community with an approval process. Learn more</span>
      </>}
      goBack={isMobile ? () => navigate(-1) : undefined}
    />
  ), [isMobile, navigate]);

  const welcomeRulesBox = useMemo(() => (
    <OnboardingBox
      expanded={customWelcome}
      header={<>
        <div className='flex justify-between gap-4'>
          <div className='flex items-center gap-2'>
            <HandWaving weight='duotone' className='w-6 h-6' />
            <span className='cg-heading-3'>Welcome & Rules</span>
          </div>
          <ToggleInputField
            toggled={customWelcome}
            onChange={setCustomWelcome}
          />
        </div>
        <span className='cg-text-md-400 cg-text-secondary'>{"Customize the welcome message to your community and add a list of rules. You can mention your community's name using {community}."}</span>
      </>}
      content={<>
        <div className='entry-field-content'>
          <TextAreaField
            value={welcomeString}
            onChange={setWelcomeString}
            autoGrow
            inputClassName='multi-entry-text-input'
          />
        </div>
        <div className='cg-separator' />
        <div className='flex flex-col gap-2'>
          <span className='cg-text-secondary cg-text-md-400'>{rules.length} of {RULE_LIMIT} rules</span>
          <MultiEntryField
            newEntryBtnText='Rule'
            entries={rules}
            setEntries={setRules}
            limit={RULE_LIMIT}
            disallowEmpty={showErrors}
          />
        </div>
      </>}
    />
  ), [customWelcome, setCustomWelcome, welcomeString, setWelcomeString, rules, showErrors]);

  const passwordBox = useMemo(() => (
    <OnboardingBox
      expanded={passwordProtected}
      header={<>
        <div className='flex justify-between gap-4'>
          <div className='flex items-center gap-2'>
            <LockKey weight='duotone' className='w-6 h-6' />
            <span className='cg-heading-3'>Password protect</span>
          </div>
          <ToggleInputField
            toggled={passwordProtected}
            onChange={setPasswordProtected}
          />
        </div>
        <span className='cg-text-md-400 cg-text-secondary'>People can apply to join your community, and must be approved by an admin from the Members page. You can add a questionnaire that applicants must complete.</span>
      </>}
      content={<PasswordField
        label='Community password'
        sublabel=''
        placeholder='password123'
        password={password}
        setPassword={(password) => {
          setPassword(password);
          setDirty(true);
        }}
        maxLetters={30}
      />}
    />
  ), [password, passwordProtected, setDirty]);

  const requirementsBox = useMemo(() => (
    <OnboardingBox
      expanded={requirementsEnabled}
      header={<>
        <div className='flex justify-between gap-4'>
          <div className='flex items-center gap-2'>
            <Keyhole weight='duotone' className='w-6 h-6' />
            <span className='cg-heading-3'>Requirements</span>
          </div>
          <ToggleInputField
            toggled={requirementsEnabled}
            onChange={setRequirementsEnabled}
          />
        </div>

        <span className='cg-text-md-400 cg-text-secondary'>Add requirements that any new members need to be able to join your community.</span>
      </>}
      content={<OnboardingRequirements
        requirements={requirements}
        setRequirements={setRequirements}
      />}
    />
  ), [requirements, requirementsEnabled]);

  const manuallyApproveBox = useMemo(() => (
    <OnboardingBox
      expanded={false}
      header={<>
        <div className='flex justify-between gap-4'>
          <div className='flex items-center gap-2'>
            <UserCirclePlus weight='duotone' className='w-6 h-6' />
            <span className='cg-heading-3'>Manually approve people</span>
          </div>
          <ToggleInputField
            toggled={manuallyApprove}
            onChange={setManuallyApprove}
          />
        </div>

        <span className='cg-text-md-400 cg-text-secondary'>People can apply to join your community, and must be approved by an admin from the Members page. You can add a questionnaire that applicants must complete.</span>
      </>}
      content={<></>}
    />
  ), [manuallyApprove]);

  const questionnaireBox = useMemo(() => (
    <OnboardingBox
      expanded={questionnaireEnabled}
      header={<>
        <div className='flex justify-between gap-4'>
          <div className='flex items-center gap-2'>
            <ListChecks weight='duotone' className='w-6 h-6' />
            <span className='cg-heading-3'>Questionnaire</span>
          </div>
          <ToggleInputField
            toggled={questionnaireEnabled}
            onChange={setQuestionnaireEnabled}
          />
        </div>
        <span className='cg-text-md-400 cg-text-secondary'>Anyone who joins your community will be given these questions to answer. This can help you collect key data on your members. Combine it with manually approving members so you can decide who to approve based on their answers.</span>
      </>}
      content={<>
        <div className='cg-separator' />
        <OnboardingQuestions
          questions={questions}
          setQuestions={setQuestions}
          showErrors={showErrors}
        />
      </>}
    />
  ), [questionnaireEnabled, questions, showErrors]);

  return useMemo(() => {
    const content = (
      <div className={`flex flex-col gap-2${isMobile ? ` px-4 ${isDirty ? 'pb-28' : 'pb-4'}` : ''}`}>
        {welcomeRulesBox}
        {passwordBox}
        {requirementsBox}
        {manuallyApproveBox}
        {questionnaireBox}

        {isDirty && <FloatingSaveOptions
          onSave={onSave}
          onDiscard={onDiscard}
        />}
      </div>
    );

    if (isMobile) {
      return <div className={`flex flex-col h-full cg-text-main`}>
        {header}
        <Scrollable>
          {content}
        </Scrollable>
      </div>
    } else {
      return <div>
        <div className={`flex flex-col gap-6 cg-text-main${isDirty ? ' pb-28' : ''}`}>
          {header}
          {content}
        </div>
      </div>
    }
  }, [isMobile, header, welcomeRulesBox, passwordBox, requirementsBox, manuallyApproveBox, questionnaireBox, isDirty, onSave, onDiscard]);
}

type OnboardingBoxProps = {
  expanded: boolean;
  header: React.JSX.Element;
  content: React.JSX.Element;
}

const OnboardingBox: React.FC<OnboardingBoxProps> = (props) => {
  return <div className={`cg-content-stack flex flex-col pt-4 px-4 gap-4 cg-border-xxl${props.expanded ? ' pb-4' : ''}`}>
    {props.header}
    <div className={`grid onboarding-box-content${props.expanded ? ' open' : ''}`}>
      <div className='flex flex-col gap-4 overflow-hidden'>
        {props.content}
      </div>
    </div>
  </div>;
}

export default React.memo(OnboardingManagement);