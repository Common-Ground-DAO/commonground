// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useLocation } from "react-router";
import { useManagementContentModalContext, withManagementContentModalProvider } from "./ManagementContentModalContext";

import "./ManagementContentModal.css";
import { XMarkIcon } from "@heroicons/react/24/solid";

type Props = {
    title: string;
}

const ManagementContentModal = (props: React.PropsWithChildren<Props>) => {
    const location = useLocation();
    const navigate = useNavigate();
    const { activeModalContent, lockModalOpen } = useManagementContentModalContext();
    const isOpen = !!activeModalContent;

    const { title, children } = props;
    const portalRoot = useMemo(() => document.getElementById("management-content-modal-root") as HTMLElement, []);
    const modalRef = useRef<HTMLDivElement>(null);

    const close = useCallback(() => {
        navigate({
            pathname: location.pathname,
            search: ''
        });
    }, [location.pathname, navigate]);

    useEffect(() => {
        if (lockModalOpen) {
            return;
        }

        // const handleClickOutside = (ev: MouseEvent) => {
        //     const target = ev.target as Element;
        //     if (isOpen && !modalRef?.current?.contains(target) && !document.getElementById("modal-root-anchor")?.contains(target)) {
        //         close();
        //     }
        // };

        const onKeydown = (ev: KeyboardEvent) => {
            const target = ev.target as Element;
            if (ev.key === 'Escape' && isOpen && !modalRef?.current?.contains(target) && !document.getElementById("modal-root-anchor")?.contains(target)) {
                close();
            }
        }
    
        // document.addEventListener('click', handleClickOutside, true);
        document.addEventListener('keydown', onKeydown, true);
        return () => {
            // document.removeEventListener('click', handleClickOutside, true);
            document.removeEventListener('keydown', onKeydown, true);
        };
    }, [isOpen, close, lockModalOpen]);

    return (
        createPortal(
            <div>
                {isOpen && (
                    <div
                        className="management-content-modal"
                        onClick={(ev) => ev.stopPropagation()}
                    >
                        <div
                            className="management-content-modal-inner"
                            ref={modalRef}
                        >
                            <div className="cg-bg-subtle p-2 cursor-pointer absolute top-4 right-4 cg-text-main cg-circular z-10" role="button" onClick={close} >
                                <XMarkIcon className="w-6 h-6" />
                            </div>
                            <span className="management-modal-title cg-text-secondary">{title}</span>
                            {children}
                        </div>
                    </div>
                )}
            </div>
            ,
            portalRoot
        )
    );
}

export default withManagementContentModalProvider(ManagementContentModal);
export const UserSettingsManagementContentModal = withManagementContentModalProvider(ManagementContentModal, 'userSettings');