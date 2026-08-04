// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo, useState } from "react";

import { useWindowSizeContext } from "../../../../../context/WindowSizeProvider";
import { useSafeCommunityContext } from "context/CommunityProvider";

import Button from "../../../../../components/atoms/Button/Button";
import Modal from "../../../../atoms/Modal/Modal";

import CheckmarkIcon from '../../../../../components/atoms/icons/16/Checkmark.svg?react';
import CloseIcon from '../../../../../components/atoms/icons/16/Close.svg?react';
import CloseIcon1 from '../../../../../components/atoms/icons/16/Close-1.svg?react';
import { Popover } from "components/atoms/Tooltip/Tooltip";
import OptionToggle from "components/molecules/OptionToggle/OptionToggle";
import RolePermissionToggle, { PermissionType } from "components/molecules/RolePermissionToggle/RolePermissionToggle";
import BottomSliderModal from "components/atoms/BottomSliderModal/BottomSliderModal";
import { PredefinedRole } from "common/enums";
import { articlePermissionsToPermissionType, checkIsPrivateArticle, permissionTypeToArticlePermissions } from "./ArticleManagementToolbar.helper";
import Scrollable from "components/molecules/Scrollable/Scrollable";
import SchedulePostModal from "components/organisms/SchedulePostModal/SchedulePostModal";

import "./ArticleManagementToolbar.css";
import dayjs from "dayjs";
import { Clock, IdentificationBadge, Trash } from "@phosphor-icons/react";
import { useSnackbarContext } from "context/SnackbarContext";
import { ItemArticleType } from "components/organisms/GenericArticleManagement/GenericArticleManagement";
import { ChevronLeftIcon } from "@heroicons/react/20/solid";

type ArticleData = Omit<Models.BaseArticle.DetailView, "articleId" | "creatorId">;

type Props = {
    saveState: 'init' | 'saving' | 'saved' | 'deleting' | 'deleted' | 'published' | 'unpublished' | 'error';
    articleDataRef: React.RefObject<ArticleData | null>;
    itemArticleRef: React.RefObject<ItemArticleType | null>;
    setRolePermissions: (rolePermissions: Models.Community.CommunityArticlePermission[]) => void;
    publishArticle: () => Promise<void>;
    unpublishArticle: () => Promise<void>;
    removeArticle: () => void;
    goBack: () => void;
    scheduleArticle: (scheduleDate: dayjs.Dayjs | null, markAsNewsletter: boolean) => Promise<void>;
    sentAsNewsletter: boolean;
}

export default function ArticleManagementToolbar(props: Props) {
    const { width, isMobile } = useWindowSizeContext();
    const { showSnackbar } = useSnackbarContext();
    const { saveState, articleDataRef, itemArticleRef, publishArticle, unpublishArticle, removeArticle, goBack, setRolePermissions, scheduleArticle, sentAsNewsletter } = props;
    const commContext = useSafeCommunityContext();
    const [showDeleteArticleModal, setShowDeleteArticleModal] = useState<boolean>(false);
    const [showScheduleModal, setShowScheduleModal] = useState<boolean>(false);

    const isScheduled = useMemo(() => {
        return !!itemArticleRef.current?.published && dayjs(itemArticleRef.current?.published).isAfter(dayjs());
    }, [itemArticleRef, itemArticleRef.current?.published]);

    const showAdditionalSaveStateBar = useMemo(() => {
        return width < 845;
    }, [width]);

    const articleSaveStateDisplay = useMemo(() => {
        return (
            <>
                {saveState === 'init' && <div className="save-state init">Saves automatically</div>}
                {saveState === 'saving' && <div className="save-state saving">Saving...</div>}
                {saveState === 'saved' && <div className="save-state saved">Saved<CheckmarkIcon className="ml-2" /></div>}
                {saveState === 'deleting' && <div className="save-state deleting">Removing...</div>}
                {saveState === 'deleted' && <div className="save-state deleted">Deleted<CheckmarkIcon className="ml-2" /></div>}
                {saveState === 'published' && <div className="save-state published">Published<CheckmarkIcon className="ml-2" /></div>}
                {saveState === 'unpublished' && <div className="save-state published">Unpublished<CheckmarkIcon className="ml-2" /></div>}
                {saveState === 'error' && <div className="save-state error">Saving failed. Please check your connection.<CloseIcon className="ml-2" /></div>}
            </>
        )
    }, [saveState]);

    return (
        <>
            <div className={`bottom-nav-articles-container${showAdditionalSaveStateBar ? " bottom-nav-articles-container-mobile" : ""}`}>
                {showAdditionalSaveStateBar && articleSaveStateDisplay}
                <div className='bottom-nav-articles'>
                    <div className="nav-left">
                        <Button
                            onClick={goBack}
                            text='Back'
                            iconLeft={<ChevronLeftIcon className="w-5 h-5"/>}
                            role="secondary"
                        />
                    </div>
                    <div className="nav-right">
                        {!showAdditionalSaveStateBar && articleSaveStateDisplay}
                        <Button
                            text={isMobile ? undefined : "Delete"}
                            iconRight={<Trash weight="duotone" className="w-5 h-5 cg-text-secondary" />}
                            onClick={() => setShowDeleteArticleModal(true)}
                            role="secondary"
                        />
                        {commContext.state === 'loaded' && <VisibilityDropdown
                            permissions={itemArticleRef.current?.rolePermissions || []}
                            setPermissions={setRolePermissions}
                        />}
                        {itemArticleRef?.current?.published === null && <Button
                            text={isMobile ? undefined : "Schedule"}
                            iconRight={<Clock weight="duotone" className="w-5 h-5 cg-text-secondary" />}
                            onClick={() => {
                                if (articleDataRef.current?.title) {
                                    setShowScheduleModal(true);
                                } else {
                                    showSnackbar({
                                        text: 'Please enter a title for the article before scheduling it.',
                                        type: 'warning'
                                    });
                                }
                            }}
                            role="secondary"
                        />}
                        {itemArticleRef?.current?.published === null && <Button
                            text="Publish"
                            onClick={() => {
                                if (articleDataRef.current?.title) {
                                    publishArticle();
                                } else {
                                    showSnackbar({
                                        text: 'Please enter a title for the article before publishing it.',
                                        type: 'warning'
                                    });
                                }
                            }}
                            role="primary"
                        />}
                        {itemArticleRef?.current?.published !== null && <Button
                            text={isScheduled ? 'Unschedule' : "Unpublish"}
                            onClick={() => unpublishArticle()}
                            role="primary"
                        />}
                    </div>
                </div>
            </div>
            {showDeleteArticleModal && (
                <Modal
                    headerText={`Delete article`}
                    close={() => setShowDeleteArticleModal(false)}
                >
                    <div className="modal-inner">
                        <p>{`Are you sure you want to delete this article?`}</p>
                        <div className="btnList justify-end pt-4">
                            <Button
                                text="Keep in drafts"
                                onClick={() => setShowDeleteArticleModal(false)}
                                role="secondary"
                            />
                            <Button
                                text={`Delete article`}
                                iconLeft={<CloseIcon1 />}
                                onClick={() => { removeArticle(); setShowDeleteArticleModal(false); }}
                                role="primary"
                            />
                        </div>
                    </div>
                </Modal>
            )}
            <SchedulePostModal
                isOpen={showScheduleModal}
                onClose={() => setShowScheduleModal(false)}
                roles={itemArticleRef.current?.rolePermissions || []}
                scheduleArticle={scheduleArticle}
                itemArticleRef={itemArticleRef}
                sentAsNewsletter={sentAsNewsletter}
            />
        </>
    )
}

type VisibilityDropdownProps = {
    permissions: Models.Community.CommunityArticlePermission[];
    setPermissions: (permissions: Models.Community.CommunityArticlePermission[]) => void;
};

const VisibilityDropdown: React.FC<VisibilityDropdownProps> = ({ permissions, setPermissions }) => {
    const { isMobile } = useWindowSizeContext();
    const commContext = useSafeCommunityContext();
    const [isBottomSliderOpen, setBottomSliderOpen] = useState(false);
    const [isPrivate, setIsPrivate] = useState(checkIsPrivateArticle(permissions));
    const [rolesPermissions, setRolesPermissions] = useState(articlePermissionsToPermissionType(permissions));
    const { roles, ownRoles } = commContext.state === 'loaded' ? commContext : { roles: [], ownRoles: [] };

    const defaultPermission = useMemo(() => {
        const publicRole = roles.find(role => role.title === PredefinedRole.Public);
        const result: Models.Community.CommunityArticlePermission[] = [];
        if (publicRole) {
            result.push({
                roleId: publicRole.id,
                roleTitle: publicRole.title,
                permissions: ['ARTICLE_PREVIEW', 'ARTICLE_READ']
            });
        }
        return result;
    }, [roles]);

    const setAndApplyRolesPermissions = useCallback((action: React.SetStateAction<Record<string, PermissionType>>) => {
        setRolesPermissions(old => {
            if (typeof action === 'function') {
                const result = action(old);
                setPermissions(permissionTypeToArticlePermissions(
                    roles,
                    result,
                    defaultPermission
                ));
                return result;
            } else {
                setPermissions(permissionTypeToArticlePermissions(
                    roles,
                    action,
                    defaultPermission
                ));
                return action;
            }
        });
    }, [defaultPermission, roles, setPermissions]);

    const visibilityDropdownTrigger = useMemo(() => {
        return (
            <Button
                text={!isMobile ? isPrivate ? "Private post" : "Public post" : undefined}
                iconRight={<IdentificationBadge weight="duotone" className="w-5 h-5 cg-text-secondary" />}
                onClick={() => { if (isMobile) setBottomSliderOpen(old => !old) }}
                role="secondary"
            />
        );
    }, [isMobile, isPrivate]);

    const visibleRoles = useMemo(() => {
        if (ownRoles.some(role => role.title === PredefinedRole.Admin)) return roles;
        return ownRoles;
    }, [ownRoles, roles]);

    const content = useMemo(() => {
        const contentClassname = [
            "p-4 flex flex-col gap-4",
            !isMobile ? 'permission-popup-container-desktop' : ''
        ].join(' ').trim();

        return <div className={contentClassname}>
            <OptionToggle
                title={"Limit who can read this"}
                description={"Change the visibility of this post"}
                isToggled={isPrivate}
                onToggle={(value) => {
                    setIsPrivate(value);

                    if (!value) {
                        const publicRole = roles.find(role => role.title === PredefinedRole.Public);
                        if (publicRole) {
                            setAndApplyRolesPermissions({
                                [publicRole.id]: 'full'
                            });
                        }
                    }
                }}
            />
            {isPrivate &&
                <RolePermissionToggle
                    title="Set permissions for this article"
                    subtitle="Roles you do not have are hidden in these settings"
                    availablePermissions={['none', 'preview', 'full']}
                    roles={visibleRoles}
                    rolesPermissions={rolesPermissions}
                    setRolesPermissions={setAndApplyRolesPermissions}
                />
            }
        </div>
    }, [isMobile, isPrivate, roles, rolesPermissions, setAndApplyRolesPermissions, visibleRoles]);

    if (isMobile) {
        return <>
            {visibilityDropdownTrigger}
            <BottomSliderModal isOpen={isBottomSliderOpen} onClose={() => setBottomSliderOpen(false)}>
                {content}
            </BottomSliderModal>
        </>
    } else {
        return <Popover
            tooltipClassName="permission-popup-tooltip"
            triggerContent={visibilityDropdownTrigger}
            triggerType="click"
            placement="bottom-start"
            closeOn="toggle"
            offset={6}
            tooltipContent={<Scrollable>
                {content}
            </Scrollable>}
        />
    }
}