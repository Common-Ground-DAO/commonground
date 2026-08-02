// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useNavigate } from "react-router-dom";

import { useWindowSizeContext } from "../../../context/WindowSizeProvider";

import Button from "../../../components/atoms/Button/Button"
import UserSettingsList from "../../../components/organisms/UserSettingsList/UserSettingsList"

import ChevronDownIcon from '../../../components/atoms/icons/16/ChevronDown.svg?react';
import CloseIcon from '../../../components/atoms/icons/20/Close.svg?react';
import BottomSliderModal from "components/atoms/BottomSliderModal/BottomSliderModal";
import { useState } from "react";
import { getUrl } from 'common/util';
import { useOwnUser } from "context/OwnDataProvider";

type Props = {
    title: string;
}

export default function UserSettingsHeader(props: Props) {
    const { title } = props;
    const navigate = useNavigate();
    const { isMobile } = useWindowSizeContext();
    const [isSliderOpen, setSliderOpen] = useState(false);
    const ownUser = useOwnUser();

    const goToProfile = () => {
        if (ownUser) {
            navigate(getUrl({ type: 'user', user: ownUser }));
        } else {
            // if no user is available, redirect to home
            navigate(getUrl({ type: 'home' }));
        }
    }

    if (isMobile) {
        return (
            <div className="flex items-center gap-4 justify-between w-full">
                <div className="flex items-center gap-2 justify-between" onClick={() => setSliderOpen(true)}>
                    <h3 className="user-profile-management-title">{title}</h3>
                    <ChevronDownIcon />
                </div>
                <BottomSliderModal
                    isOpen={isSliderOpen}
                    onClose={() => setSliderOpen(false)}
                >
                    <UserSettingsList />
                </BottomSliderModal>
                <Button iconLeft={<CloseIcon />} onClick={goToProfile} />
            </div>
        )
    }
    return <h3 className="user-profile-management-title">{title}</h3>;
}