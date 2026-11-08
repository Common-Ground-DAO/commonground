// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button from "../../../components/atoms/Button/Button";
import UnlockedIcon from '../../../components/atoms/icons/misc/Unlocked.svg?react';

import "./TokenGatedTag.css";

type Props = {}

export default function TokenGatedTag(props: Props) {
    return (
        <Button role="borderless" className="token-gated-tag" iconLeft={<UnlockedIcon />} text="Unlocked" />
    );
}