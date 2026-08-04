// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md


import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import "./ChannelItem.css";
import SettingsListItem from "components/atoms/SettingsListItem/SettingsListItem";
import { DotsSixVertical } from "@phosphor-icons/react";

type Props = {
    /**
     * The area the row currently sits in. Not `channel.areaId`: while a channel
     * is dragged across areas the row is rendered from the drag preview, and
     * the channel object still carries its old area until the drop persists.
     */
    areaId: string;
    channel: Models.Community.Channel;
    onChannelEditClick: (channel: Models.Community.Channel) => void;
    selected?: boolean;
}

export default function ChannelItem(props: Props) {
    const { areaId, channel, onChannelEditClick, selected } = props;
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: channel.channelId,
        data: { type: 'text-channels', areaId },
    });

    const className = [
        "channel-item",
        isDragging ? "dragging" : ""
    ].join(" ").trim();

    // The whole row is the drag handle, as it was under react-beautiful-dnd.
    return (
        <div
            className={className}
            ref={setNodeRef}
            {...attributes}
            {...listeners}
            style={{
                transform: CSS.Transform.toString(transform),
                transition,
                position: 'relative',
                zIndex: isDragging ? 5000 : undefined,
            }}
        >
            <SettingsListItem
                onClick={() => onChannelEditClick(channel)}
                text={<>{channel.emoji || '💬'} {channel.title}</>}
                iconLeft={<span className="flex" >
                    <DotsSixVertical className="w-5 h-5" />
                </span>}
                selected={selected}
            />
        </div>
    )
}
