// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import SwitchInputField from "../inputs/SwitchInputField/SwitchInputField";

import GridIcon from "../../atoms/icons/16/Grid.svg?react";
import TripleRowsIcon from "../../atoms/icons/16/TripleRows.svg?react";

import "./GridToColumnToggle.css";

type Props = {
    selectedValue: SwitchViewMode;
    onChange: (value: SwitchViewMode) => void;
}

export type SwitchViewMode = 'list' | 'grid';

const switchViewModes = [
    {
        value: 'grid',
        iconRight: <GridIcon />
    },
    {
      value: 'list',
      iconRight: <TripleRowsIcon />
    }
];

export default function GridToColumnToggle(props: Props) {
    const { selectedValue, onChange } = props;

    return (
        <div className="grid-column-toggle">
            <SwitchInputField
                options={switchViewModes}
                value={selectedValue}
                onChange={(value) => onChange(value as SwitchViewMode)}
            />
        </div>
    )
}