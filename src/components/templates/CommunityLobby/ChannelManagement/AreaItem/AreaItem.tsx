// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from "react";
import { Droppable, DraggableProvidedDragHandleProps } from "react-beautiful-dnd";
import { ChevronDownIcon, FolderIcon } from "@heroicons/react/20/solid";
import { DotsSixVertical } from "@phosphor-icons/react";
import Button from "../../../../atoms/Button/Button";
import ChannelItem from "../ChannelItem/ChannelItem";

import "./AreaItem.css";

type Props = {
  area: Models.Community.Area;
  expanded: boolean;
  onAreaClick: (area: Models.Community.Area) => void;
  onAreaEditClick: (area: Models.Community.Area) => void;
  onChannelEditClick: (channel: Models.Community.Channel) => void;
  onCreateChannelClick: (area: Models.Community.Area) => void;
  sortedTextChannels: Models.Community.Channel[];
  dragging: boolean;
  // react-beautiful-dnd types >= 13.1.3 widened `dragHandleProps` to include null
  draggableHandlerProps: DraggableProvidedDragHandleProps | null | undefined;
  selectedId?: string;
}

export default function AreaItem(props: React.PropsWithChildren<Props>) {
  const {
    area,
    expanded,
    onAreaClick,
    onAreaEditClick,
    onChannelEditClick,
    onCreateChannelClick,
    sortedTextChannels,
    dragging,
    draggableHandlerProps,
    selectedId
  } = props;

  const className = [
    "panel-item area-item",
    dragging ? "dragging" : ""
  ].join(" ").trim();

  const innerClassName = [
    "area-item-inner",
    expanded ? "expanded-item" : "",
    selectedId === area.id ? 'selected' : ''
  ].join(" ").trim();

  return (
    <div className={className}>
      <div className={innerClassName} onClick={() => onAreaClick(area)} {...draggableHandlerProps}>
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <span className="drag-handle-icon">
              <DotsSixVertical className="w-5 h-5" />
            </span>
            <span className="panel-item-text">{area.title}</span>
          </div>
          <span className="chevron-icon flex">
            <ChevronDownIcon className="w-5 h-5" />
          </span>
        </div>
      </div>
      {expanded && <>
        <Droppable
          droppableId={`${area.id}|text-channels`}
          type="text-channels"
        >
          {(provided, snapshot) => {
            const textChannelIds = sortedTextChannels?.map(channel => channel.channelId);
            return (
              <div
                className="flex flex-col gap-2 p-2 pl-4"
                ref={provided.innerRef}
                style={{
                  borderRadius: '6px',
                  background: snapshot.isDraggingOver && snapshot.draggingOverWith ? (textChannelIds?.includes(snapshot.draggingOverWith) ? "rgba(255, 255, 255, 0.03)" : "none") : "none"
                }}
                {...provided.droppableProps}
              >
                {sortedTextChannels?.map((channel, index) => {
                  return (
                    <ChannelItem
                      key={channel.channelId}
                      index={index}
                      channel={channel}
                      onChannelEditClick={onChannelEditClick}
                      selected={selectedId === channel.channelId}
                    >
                      {provided.placeholder}
                    </ChannelItem>
                  );
                })}
                {provided.placeholder}
              </div>
            )
          }}
        </Droppable>
        <div className="flex gap-2 px-2 pb-2">
            <Button
              onClick={() => onCreateChannelClick(area)}
              role="chip"
              text="+ New Channel"
              className="flex-1"
            />
            <Button
              onClick={() => onAreaEditClick(area)}
              iconLeft={<FolderIcon className="w-5 h-5" />}
              role="chip"
              text="Edit Area"
              className="flex-1"
            />
          </div>
      </>}
    </div>
  )
}