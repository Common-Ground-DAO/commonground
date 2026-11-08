// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { AccessLevel } from "common/types";
import { PredefinedRole } from "common/enums";

import DismissIcon from '../../../components/atoms/icons/20/Dismiss.svg?react';
import MuteIcon from '../../../components/atoms/icons/20/Mute.svg?react';
import DeleteIcon from '../../../components/atoms/icons/20/Delete.svg?react';
import ModIcon from '../../../components/atoms/icons/20/Mod.svg?react';
import RoleIcon from '../../../components/atoms/icons/20/Role.svg?react';
import { useLoadedCommunityContext } from "../../../context/CommunityProvider";

import Button from "../../../components/atoms/Button/Button";
import Dropdown from "../../molecules/Dropdown/Dropdown";
import DropdownItem from "../../atoms/ListItem/ListItem";

type Props = {
    isSelf: boolean;
    userId: string;
    accessLevel?: AccessLevel;
    communityId: string;
    showDeleteButton: boolean;
    onDeleteMessageTriggerClick?: () => void;
    onWarnReasonChange?: (reason: Common.Content.WarnReason) => void;
    onMuteDurationChange?: (duration: Common.Content.DurationOption) => void;
    onBanDurationChange?: (duration: Common.Content.DurationOption) => void;
    closeButtonRef?: React.RefObject<HTMLButtonElement | null>;
}

export default function AdminModView(props: Props) {
    const {
        isSelf,
        userId,
        accessLevel,
        communityId,
        showDeleteButton,
        onDeleteMessageTriggerClick,
        onWarnReasonChange,
        onMuteDurationChange,
        onBanDurationChange,
        closeButtonRef,
    } = props;
    const { communityPermissions } = useLoadedCommunityContext();
    const isAdmin = communityPermissions.has('COMMUNITY_MODERATE');

    const roleOptions = [
        {
            label: "Admin",
            value: "admin"
        }, {
            label: "Moderator",
            value: "moderator"
        }, {
            label: "Editor",
            value: "editor"
        }, {
            label: "Member",
            value: "user"
        }
    ]
    
    const getRole = (accessLevel: AccessLevel | undefined) => {
        return roleOptions.find(option => option.value === accessLevel);
    }

    const handleRoleChange = (newValue: AccessLevel) => {
        if (!!newValue && communityId) {
            try {
                // Todo
                // cgApi.write.setUserRole(communityId, userId, newValue as AccessLevel);
            } catch(err) {
                console.error(err);
            }
        }
    }

    const handleWarnChange = (newValue: Common.Content.WarnReason) => {
        if (onWarnReasonChange && newValue) {
            onWarnReasonChange(newValue);
        }
    }

    const handleDurationChange = (newValue: Common.Content.DurationOption, type: "mute" | "ban") => {
        if (newValue && type) {
            if (type === "mute" && onMuteDurationChange) {
                onMuteDurationChange(newValue);
            } else if (type === "ban" && onBanDurationChange) {
                onBanDurationChange(newValue)
            };
        }
    }

    return (
        <div className="admin">
            <div className="admin-header">
                <span>Moderator options</span>
                <Button
                    iconLeft={<DismissIcon />}
                    role="borderless"
                    buttonRef={closeButtonRef}
                />
            </div>
            <div className="admin-tools">
                {showDeleteButton && <div className="row delete-row" onClick={onDeleteMessageTriggerClick}>
                    <div>
                        <DeleteIcon />
                    </div>
                    <div>
                        <p className="title">Delete message</p>
                        {/* <p className="sub-text">Delete {`${isSelf ? 'your' : 'this'}`} message for all users</p> */}
                    </div>
                </div>}
                {!isSelf && isAdmin && <div className="row">
                    <div>
                        <RoleIcon />
                    </div>
                    <div>
                        <p className="title">Role</p>
                        {/* <p className="sub-text">Set this user's role</p> */}
                    </div>
                    <div className="drop-down" onClick={(ev) => ev.stopPropagation()}>
                        <Dropdown
                            triggerContent={getRole(accessLevel)?.label || ""}
                            items={[
                                <DropdownItem
                                    title="Admin"
                                    key="admin"
                                    onClick={() => handleRoleChange("admin")}
                                />,
                                <DropdownItem
                                    title="Moderator"
                                    key="moderator"
                                    onClick={() => handleRoleChange("moderator")}
                                />,
                                <DropdownItem
                                    title="Editor"
                                    key="editor"
                                    onClick={() => handleRoleChange("editor")}
                                />,
                                <DropdownItem
                                    title="Member"
                                    key="member"
                                    onClick={() => handleRoleChange("user")}
                                />
                            ]}
                            offset={4}
                        />
                    </div>
                </div>}
                {!isSelf && <>
                    <div className="row warnUser">
                        <div>
                            <ModIcon />
                        </div>
                        <div>
                            <p className="title">Warn</p>
                            {/* <p className="sub-text">Publicly warn user</p> */}
                        </div>
                        <div className="drop-down" onClick={(ev) => ev.stopPropagation()}>
                            <Dropdown
                                triggerContent="Reason"
                                items={[
                                    <DropdownItem
                                        key="Behavior"
                                        title="Behavior"
                                        onClick={() => handleWarnChange("Behavior")}
                                    />,
                                    <DropdownItem
                                        key="Off-topic"
                                        title="Off-topic"
                                        onClick={() => handleWarnChange("Off-topic")}
                                    />,
                                    <DropdownItem
                                        key="Language"
                                        title="Language"
                                        onClick={() => handleWarnChange("Language")}
                                    />,
                                    <DropdownItem
                                        key="Spam"
                                        title="Spam"
                                        onClick={() => handleWarnChange("Spam")}
                                    />,
                                    <DropdownItem
                                        key="Breaking rules"
                                        title="Breaking rules"
                                        onClick={() => handleWarnChange("Breaking rules")}
                                    />
                                ]}
                                offset={4}
                            />
                        </div>
                    </div>
                    <div className="row muteUser">
                        <div>
                            <MuteIcon />
                        </div>
                        <div>
                            <p className="title">Mute</p>
                            {/* <p className="sub-text">Stop user from writing</p> */}
                        </div>
                        <div className="drop-down" onClick={(ev) => ev.stopPropagation()}>
                            <Dropdown
                                triggerContent="Duration"
                                items={[
                                    <DropdownItem
                                        key="15m"
                                        title="15m"
                                        onClick={() => handleDurationChange("15m", "mute")}
                                    />,
                                    <DropdownItem
                                        key="1h"
                                        title="1h"
                                        onClick={() => handleDurationChange("1h", "mute")}
                                    />,
                                    <DropdownItem
                                        key="1d"
                                        title="1d"
                                        onClick={() => handleDurationChange("1d", "mute")}
                                    />,
                                    <DropdownItem
                                        key="1w"
                                        title="1w"
                                        onClick={() => handleDurationChange("1w", "mute")}
                                    />,
                                    <DropdownItem
                                        key="permanently"
                                        title="permanently"
                                        onClick={() => handleDurationChange("permanently", "mute")}
                                    />
                                ]}
                                offset={4}
                            />
                        </div>
                    </div>
                    <div className="row banUser">
                        <div>
                            <DismissIcon />
                        </div>
                        <div>
                            <p className="title">Ban</p>
                            {/* <p className="sub-text">Ban user from community</p> */}
                        </div>
                        <div className="drop-down" onClick={(ev) => ev.stopPropagation()}>
                            <Dropdown
                                triggerContent="Duration"
                                items={[
                                    <DropdownItem
                                        key="15m"
                                        title="15m"
                                        onClick={() => handleDurationChange("15m", "ban")}
                                    />,
                                    <DropdownItem
                                        key="1h"
                                        title="1h"
                                        onClick={() => handleDurationChange("1h", "ban")}
                                    />,
                                    <DropdownItem
                                        key="1d"
                                        title="1d"
                                        onClick={() => handleDurationChange("1d", "ban")}
                                    />,
                                    <DropdownItem
                                        key="1w"
                                        title="1w"
                                        onClick={() => handleDurationChange("1w", "ban")}
                                    />,
                                    <DropdownItem
                                        key="permanently"
                                        title="permanently"
                                        onClick={() => handleDurationChange("permanently", "ban")}
                                    />
                                ]}
                                offset={4}
                            />
                        </div>
                    </div>
                </>}
            </div>
        </div>
    );
}