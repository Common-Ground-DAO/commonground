// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Flow } from '../lib/harness.ts';
import { anonymous } from './01-anonymous.ts';
import { auth } from './02-auth.ts';
import { reload } from './03-reload.ts';
import { communityChat } from './04-community-chat.ts';
import { images } from './05-images.ts';
import { settings } from './06-settings.ts';
import { call } from './07-call.ts';
import { articlePlugin } from './08-article-plugin.ts';

/** every flow, in run order (each is independent; --flow picks a subset) */
export const flows: Flow[] = [
  anonymous,
  auth,
  reload,
  communityChat,
  images,
  settings,
  call,
  articlePlugin,
];
