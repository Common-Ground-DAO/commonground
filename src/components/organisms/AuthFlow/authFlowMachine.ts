// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from "common/errors";
import { formatRetryAfter } from "data/auth/authErrors";

/**
 * Step machine of the login / sign-up flow (AuthFlow). Pure, so the
 * transitions are unit-tested without a DOM (authFlowMachine.test.ts).
 *
 * Login is one form (`login`) with side steps for the email code, a wallet
 * and the "More" methods. Sign-up is
 *   signup-details (name, email; the captcha when the email code follows)
 *   → signup-verify (8-digit code; skipped without mail / on a legacy instance)
 *   → signup-method ("How will you sign in?")
 *   → signup-password | signup-wallet (passkey runs from signup-method)
 * The captcha is solved exactly where the server checks it: with the email
 * code request when there is one (createUser then needs none), otherwise on
 * the step that calls createUser — so no token has to survive the steps.
 * and ends in `done` with User/createUser. After a password login the flow
 * may stop at `offer-passkey` once before `done`.
 */

export type AuthFlowStep =
  | 'login'
  | 'login-code'
  | 'login-wallet'
  | 'login-lukso'
  | 'login-farcaster'
  | 'login-recovery-phrase'
  | 'signup-details'
  | 'signup-verify'
  | 'signup-method'
  | 'signup-password'
  | 'signup-wallet'
  | 'offer-passkey'
  | 'done';

export type SignupMethod = 'passkey' | 'password' | 'wallet';
export type MoreLoginMethod = 'lukso' | 'farcaster' | 'recovery-phrase';

export type AuthFlowConfig = {
  /** the instance sends mail: sign-up verifies the address first */
  emailEnabled: boolean;
  /** legacy CG ID (gateway) instance: no passkey sign-up, no email-code step */
  legacy: boolean;
  /** WebAuthn usable here */
  passkeysSupported: boolean;
  /** false: sign-in only, no way to sign up (a gateway, docs/auth-identity §12); default true */
  signup?: boolean;
};

export type SignupData = {
  displayName: string;
  email: string;
  /** the address the email code confirmed in this flow (going back keeps it) */
  verifiedEmail?: string;
  /**
   * instances that check the captcha at createUser: the captcha solved on the
   * method step, handed to the password / wallet step (single use: that step
   * shows a new one after a failed attempt)
   */
  captchaToken?: string;
};

export type AuthFlowState = {
  step: AuthFlowStep;
  signup: SignupData;
  /** shown on the current step; cleared by every transition */
  error?: string;
  /** how the flow ended (`done`) */
  outcome?: 'login' | 'signup';
};

export type AuthFlowEvent =
  | { type: 'SHOW_LOGIN' }
  | { type: 'SHOW_SIGNUP' }
  | { type: 'USE_EMAIL_CODE' }
  | { type: 'USE_WALLET' }
  | { type: 'USE_MORE'; method: MoreLoginMethod }
  | { type: 'BACK' }
  | { type: 'DETAILS_SUBMITTED'; data: SignupData }
  | { type: 'EMAIL_VERIFIED' }
  | { type: 'CHOOSE_METHOD'; method: Exclude<SignupMethod, 'passkey'>; captchaToken?: string }
  | { type: 'SIGNUP_FAILED'; code: string; retryAfterSeconds?: number }
  | { type: 'ACCOUNT_CREATED' }
  | { type: 'LOGGED_IN'; offerPasskey: boolean }
  | { type: 'PASSKEY_OFFER_DONE' }
  | { type: 'ERROR'; message: string };

export const emptySignup: SignupData = { displayName: '', email: '' };

function sameEmail(a: string | undefined, b: string | undefined) {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** the details step can continue without a new code (and captcha) */
export function emailAlreadyVerified(signup: SignupData, email: string) {
  return sameEmail(signup.verifiedEmail, email);
}

/** whether createUser itself needs a captcha token (no email code step covered it) */
export function captchaAtCreateUser(config: AuthFlowConfig) {
  return !needsEmailVerification(config);
}

export function initialAuthFlowState(mode: 'login' | 'signup' = 'login'): AuthFlowState {
  return { step: mode === 'signup' ? 'signup-details' : 'login', signup: emptySignup };
}

/** sign-up verifies the email address before the account exists */
export function needsEmailVerification(config: AuthFlowConfig) {
  return config.emailEnabled && !config.legacy;
}

/** "How will you sign in?" — passkey first; never X/LUKSO/Farcaster or a recovery phrase */
export function signupMethods(config: AuthFlowConfig): SignupMethod[] {
  const methods: SignupMethod[] = [];
  if (config.passkeysSupported && !config.legacy) {
    methods.push('passkey');
  }
  methods.push('password', 'wallet');
  return methods;
}

/** The "More" menu of the login form: login only, for already linked accounts */
export function moreLoginMethods(config: AuthFlowConfig): MoreLoginMethod[] {
  const methods: MoreLoginMethod[] = ['lukso', 'farcaster'];
  if (config.legacy) {
    methods.push('recovery-phrase');
  }
  return methods;
}

/** the account-creation limit per network: when, and what else works */
export function accountLimitMessage(retryAfterSeconds?: number, now?: Date) {
  const when = retryAfterSeconds !== undefined ? formatRetryAfter(retryAfterSeconds, now) : "a bit later";
  return `Too many accounts were created from your network recently. You can create yours ${when}, `
    + "or right away from another network (e.g. mobile data instead of Wi-Fi). Already have an account? Log in instead.";
}

/** What a failed createUser (or sign-up passkey) means for the flow */
export function signupFailure(code: string, retryAfterSeconds?: number, now?: Date): { step: AuthFlowStep | null; message: string } {
  switch (code) {
    case errors.server.CAPTCHA_FAILED:
      return { step: 'signup-details', message: "Please solve the captcha again." };
    case errors.server.EMAIL_VERIFICATION_REQUIRED:
      return { step: 'signup-details', message: "Please confirm your email address again." };
    case errors.server.RATE_LIMIT_EXCEEDED:
      // the account-creation limit per network (or a sign-up passkey limit)
      return { step: null, message: accountLimitMessage(retryAfterSeconds, now) };
    case errors.server.ALREADY_LOGGED_IN:
      return { step: null, message: "You are already signed in. Reload the page to continue." };
    case errors.server.EXISTS_ALREADY:
    case errors.server.DUPLICATE_KEY:
      return { step: 'signup-details', message: "This name or email address is already taken." };
    case errors.server.INVALID_REQUEST:
      return { step: null, message: "Setting up your sign-in method took too long. Please try again." };
    default:
      return { step: null, message: "Something went wrong, please try again." };
  }
}

const BACK: Partial<Record<AuthFlowStep, AuthFlowStep>> = {
  'login-code': 'login',
  'login-wallet': 'login',
  'login-lukso': 'login',
  'login-farcaster': 'login',
  'login-recovery-phrase': 'login',
  'signup-details': 'login',
  'signup-verify': 'signup-details',
  'signup-password': 'signup-method',
  'signup-wallet': 'signup-method',
};

const MORE_STEPS: Record<MoreLoginMethod, AuthFlowStep> = {
  'lukso': 'login-lukso',
  'farcaster': 'login-farcaster',
  'recovery-phrase': 'login-recovery-phrase',
};

export function authFlowReducer(config: AuthFlowConfig) {
  return (state: AuthFlowState, event: AuthFlowEvent): AuthFlowState => {
    const to = (step: AuthFlowStep, extra: Partial<AuthFlowState> = {}): AuthFlowState => ({
      ...state,
      error: undefined,
      ...extra,
      step,
    });

    switch (event.type) {
      case 'SHOW_LOGIN':
        return to('login');

      case 'SHOW_SIGNUP':
        return config.signup === false ? state : to('signup-details');

      case 'USE_EMAIL_CODE':
        return config.emailEnabled ? to('login-code') : state;

      case 'USE_WALLET':
        return to('login-wallet');

      case 'USE_MORE':
        return moreLoginMethods(config).includes(event.method) ? to(MORE_STEPS[event.method]) : state;

      case 'BACK': {
        if (state.step === 'signup-method') {
          // the code is used up: back to the details, which know the
          // address is already confirmed
          return to('signup-details');
        }
        const previous = BACK[state.step];
        return previous ? to(previous) : state;
      }

      case 'DETAILS_SUBMITTED': {
        if (state.step !== 'signup-details') {
          return state;
        }
        if (!needsEmailVerification(config)) {
          return to('signup-method', { signup: { ...event.data, verifiedEmail: undefined } });
        }
        if (emailAlreadyVerified(state.signup, event.data.email)) {
          return to('signup-method', { signup: { ...event.data, verifiedEmail: state.signup.verifiedEmail } });
        }
        return to('signup-verify', { signup: { ...event.data, verifiedEmail: undefined } });
      }

      case 'EMAIL_VERIFIED':
        return state.step === 'signup-verify'
          ? to('signup-method', { signup: { ...state.signup, verifiedEmail: state.signup.email } })
          : state;

      case 'CHOOSE_METHOD':
        if (state.step !== 'signup-method' || !signupMethods(config).includes(event.method)) {
          return state;
        }
        return to(event.method === 'password' ? 'signup-password' : 'signup-wallet', {
          signup: { ...state.signup, captchaToken: captchaAtCreateUser(config) ? event.captchaToken || undefined : undefined },
        });

      case 'SIGNUP_FAILED': {
        const failure = signupFailure(event.code, event.retryAfterSeconds);
        let step = failure.step || state.step;
        let signup = state.signup;
        if (event.code === errors.server.CAPTCHA_FAILED && captchaAtCreateUser(config)) {
          // the captcha sits on the current step: solve it again right there
          step = state.step;
        }
        else if (step === 'signup-details') {
          // a new code (with a new captcha) is needed
          signup = { ...signup, verifiedEmail: undefined };
        }
        return { ...state, step, signup, error: failure.message };
      }

      case 'ACCOUNT_CREATED':
        return to('done', { outcome: 'signup' });

      case 'LOGGED_IN':
        return to(event.offerPasskey ? 'offer-passkey' : 'done', { outcome: 'login' });

      case 'PASSKEY_OFFER_DONE':
        return state.step === 'offer-passkey' ? to('done', { outcome: 'login' }) : state;

      case 'ERROR':
        return { ...state, error: event.message };

      default:
        return state;
    }
  };
}
