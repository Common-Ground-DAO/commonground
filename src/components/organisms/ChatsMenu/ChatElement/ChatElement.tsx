// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useMemo } from "react";
import { useLocation } from "react-router";

import Jdenticon from "../../../atoms/Jdenticon/Jdenticon";
import MessageBodyRenderer from "../../../molecules/MesssageBodyRenderer/MessageBodyRenderer";
import UsernameWithVerifiedIcon from "../../../molecules/UsernameWithVerifiedIcon/UsernameWithVerifiedIcon";
import Timestamp from "../../../atoms/Timestamp/Timestamp";

import "./ChatElement.css";
import { getUrl } from 'common/util';
import { useOwnUser } from "context/OwnDataProvider";
import { useUserData } from "context/UserDataProvider";
import { truncateMessage } from "common/converters";
import { getDisplayNameString } from "../../../../util";
import NotificationCount from "components/atoms/NotificationCount/NotificationCount";

type ChatElementProps = {
    chat: Models.Chat.Chat,
    isArchived?: boolean,
    highlighted?: boolean
};
  
export default function ChatElement(props: ChatElementProps) {
    const location = useLocation();
    const { chat, highlighted } = props;
    const ownUser = useOwnUser();

    const otherUserId = useMemo(() => {
        if (!!ownUser) {
            const userIds = chat.userIds.filter(id => id !== ownUser.id);
            if (userIds.length !== 1) {
                // In a later state, this can show e.g. multiple user Icons,
                // if there are more than 2 users in a chat
                console.error(`More than one other user exists in chat: ${chat.id}, userId(s): [${userIds.join(', ')}]`);
            }
            return userIds[0];
        }
    }, [ownUser, chat]);

    const otherUser = useUserData(otherUserId);

    const listItemClassName = useMemo(() => {
        return [
            "conversation-element",
            "user-list-item",
            !!chat.unread ? "list-item-unread" : "",
            highlighted ? "highlighted" : "",
            location.pathname === getUrl({ type: 'chat', chat }) ? "conversation-element-active" : ""
        ].join(" ").trim();
    }, [chat, highlighted, location.pathname])

    const iconStyle = { height: '48px', width: '48px' };

    const timestamp = useMemo(() => {
        if (chat.lastMessage?.createdAt) {
            return <Timestamp timestamp={chat.lastMessage?.createdAt} mode='minimal' className="dm-timestamp ml-auto" />
        }
        return null;
    }, [chat.lastMessage?.createdAt]);

    // Todo
    if (!ownUser || !otherUserId) {
        return <div>Login Required to see chats, fixme</div>
    }

    return (
        <div className={listItemClassName}>
            <div className="flex w-full">
                <div className="pr-2" title={otherUser ? getDisplayNameString(otherUser) : otherUserId}>
                    <Jdenticon userId={otherUserId} iconStyle={iconStyle} />
                </div>
                <div className="flex flex-col gap-1 w-full overflow-hidden">
                    <div className="flex items-center gap-3">
                        <div className="conversation-element-user">
                            <UsernameWithVerifiedIcon
                                userId={otherUserId}
                                userData={otherUser}
                                disableTooltip
                            />
                        </div>
                        {timestamp}
                    </div>
                    <div className="flex gap-3">
                        <div className="dm-excerpt-container">
                            {chat.lastMessage && (<MessageBodyRenderer
                                message={truncateMessage(chat.lastMessage)}
                                hideTimestamp
                                truncate
                            />)}
                        </div>
                        {!!chat.unread && <div className="ml-auto relative">
                            <NotificationCount notificationCount={chat.unread} noOutline />
                        </div>}
                    </div>
                </div>
            </div>
        </div>
    );
}