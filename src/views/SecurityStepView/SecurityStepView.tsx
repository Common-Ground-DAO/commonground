// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import SecurityStep from 'components/organisms/SecurityStep/SecurityStep';

/**
 * Shown on every route instead of the app while the signed-in account has to
 * finish the account-security step (docs/auth-identity §11, frontend §10).
 */
const SecurityStepView: React.FC = () => (
  <div className='security-step-view'>
    <SecurityStep />
  </div>
);

export default SecurityStepView;
