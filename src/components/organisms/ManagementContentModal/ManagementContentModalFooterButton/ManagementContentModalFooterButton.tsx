// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button from '../../../../components/atoms/Button/Button';
import DismissIcon from '../../../../components/atoms/icons/20/Dismiss.svg?react';

import "./ManagementContentModalFooterButton.css";

type Props = {
    text: string;
    onClick: () => void;
}

export default function ManagementContentModalFooterButton(props: Props) {
    const { text, onClick } = props;
    
    return (
        <div className="management-content-modal-footer">
            <Button
                text={text}
                iconLeft={<DismissIcon />}
                onClick={onClick}
                className="management-content-modal-footer-button"
            />
        </div>
    )
}