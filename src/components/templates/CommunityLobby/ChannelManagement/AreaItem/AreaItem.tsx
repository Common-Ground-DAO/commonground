// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ChevronDownIcon, FolderIcon } from "@heroicons/react/20/solid";
import { DotsSixVertical } from "@phosphor-icons/react";
import Button from "../../../../atoms/Button/Button";
import ChannelItem from "../ChannelItem/ChannelItem";
import type { DragHandleProps } from "../ChannelManagementAreaList";

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
  draggableHandlerProps: DragHandleProps;
  /**
   * Whether a drag over this area's channel list should tint it. Reproduces
   * react-beautiful-dnd's `isDraggingOver` + `draggingOverWith` check, which
   * only ever matched channels that started out in *this* area — i.e. the
   * tint marks a reorder inside the area, not a drop from another one. The
   * parent derives it from the drag's source area and the area currently
   * hovered, so it is on for the whole hover, as it was under rbd.
   */
  highlightOnDragOver: boolean;
  /**
   * True while any channel drag is in progress. Keeps an *empty* area's drop
   * zone open: without a minimum height its droppable collapses to the list
   * padding, where rbd's placeholder held it open at roughly a row's height.
   */
  channelDragActive: boolean;
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
    highlightOnDragOver,
    channelDragActive,
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
      <div
        className={innerClassName}
        onClick={() => onAreaClick(area)}
        ref={draggableHandlerProps.setActivatorNodeRef}
        {...draggableHandlerProps.attributes}
        {...draggableHandlerProps.listeners}
      >
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
        <AreaChannelList
          areaId={area.id}
          areaTitle={area.title}
          sortedTextChannels={sortedTextChannels}
          onChannelEditClick={onChannelEditClick}
          highlightOnDragOver={highlightOnDragOver}
          channelDragActive={channelDragActive}
          selectedId={selectedId}
        />
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

type ChannelListProps = {
  areaId: string;
  areaTitle: string;
  sortedTextChannels: Models.Community.Channel[];
  onChannelEditClick: (channel: Models.Community.Channel) => void;
  highlightOnDragOver: boolean;
  channelDragActive: boolean;
  selectedId?: string;
}

/**
 * The area's channel drop zone. Rendered only while the area is expanded, so a
 * channel still cannot be dropped into a collapsed area — same as before.
 */
function AreaChannelList(props: ChannelListProps) {
  const { areaId, areaTitle, sortedTextChannels, onChannelEditClick, highlightOnDragOver, channelDragActive, selectedId } = props;
  const { setNodeRef } = useDroppable({
    id: `${areaId}|text-channels`,
    data: { type: 'text-channels', areaId, isContainer: true, label: `area ${areaTitle}` },
  });
  const textChannelIds = sortedTextChannels?.map(channel => channel.channelId) || [];

  return (
    <SortableContext items={textChannelIds} strategy={verticalListSortingStrategy}>
      <div
        className="flex flex-col gap-2 p-2 pl-4"
        ref={setNodeRef}
        style={{
          borderRadius: '6px',
          minHeight: channelDragActive ? '2.5rem' : undefined,
          background: highlightOnDragOver ? "rgba(255, 255, 255, 0.03)" : "none"
        }}
      >
        {sortedTextChannels?.map((channel) => {
          return (
            <ChannelItem
              key={channel.channelId}
              areaId={areaId}
              channel={channel}
              onChannelEditClick={onChannelEditClick}
              selected={selectedId === channel.channelId}
            />
          );
        })}
      </div>
    </SortableContext>
  )
}
