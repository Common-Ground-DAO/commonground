// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { UAParser } from 'ua-parser-js';
import React from 'react';

export function useUserAgent() {
    const uaData = React.useMemo(() => {
        return UAParser();
    }, []);
    return uaData;
}