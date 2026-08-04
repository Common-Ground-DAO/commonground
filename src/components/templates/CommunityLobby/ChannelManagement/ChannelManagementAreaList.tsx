// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useLoadedCommunityContext } from 'context/CommunityProvider';
import _ from 'lodash';
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  closestCenter,
  CollisionDetection,
  DndContext,
  DragEndEvent,
  DraggableAttributes,
  DraggableSyntheticListeners,
  DragOverEvent,
  DragStartEvent,
  pointerWithin,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDragSensors } from 'hooks/useDragSensors';
import AreaItem from './AreaItem/AreaItem';
import Button from 'components/atoms/Button/Button';
import data from 'data';

/** What a `useSortable` caller has to hand to whichever element is the handle. */
export type DragHandleProps = {
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  setActivatorNodeRef: (element: HTMLElement | null) => void;
};

const AREA_TYPE = 'areas';
const CHANNEL_TYPE = 'text-channels';

/** Which area's list a channel currently sits in. */
function findChannelArea(dict: ChannelDict, channelId: string): string | undefined {
  return Object.keys(dict)
    .find(areaId => dict[areaId].textChannels.some(channel => channel.channelId === channelId));
}

/**
 * react-beautiful-dnd scoped drop targets with a `type` prop: an area could
 * only land in the area list, a channel only in a channel list. dnd-kit has no
 * equivalent, so the same rule is enforced here — drop targets of the wrong
 * type are filtered out before collision detection runs, which is also what
 * keeps a channel from being dropped onto an area row (there is no nesting
 * beyond area → channel).
 *
 * Within the surviving targets, a row beats the list container it sits in, and
 * `closestCenter` is the fallback so that keyboard drags — which have no
 * pointer position for `pointerWithin` to work with — still resolve.
 */
const typedCollisionDetection: CollisionDetection = (args) => {
  const activeType = args.active.data.current?.type;
  const candidates = args.droppableContainers
    .filter(container => container.data.current?.type === activeType);
  const rows = candidates.filter(container => !container.data.current?.isContainer);
  const containers = candidates.filter(container => container.data.current?.isContainer);

  const rowHit = pointerWithin({ ...args, droppableContainers: rows });
  if (rowHit.length > 0) {
    return rowHit;
  }
  const containerHit = pointerWithin({ ...args, droppableContainers: containers });
  if (containerHit.length > 0) {
    return containerHit;
  }
  return closestCenter({ ...args, droppableContainers: rows });
};

const BASE_ORDER_STEP = 1000000;
const NUKE_OPTION_THRESHOLD = 0.9;

type ChannelDict = {
  [areaId: string]: {
    textChannels: Models.Community.Channel[];
  }
}

export const findNewOrder: <T extends { order: number }>(items: T[]) => T[] = (oldItems) => {
  const itemsClone = _.cloneDeep(oldItems);

  function reassignOrder<T extends { order: number }>(items: T[], index: number) {
    // if first element set BASE_ORDER_STEP
    if (index === 0) {
      items[0].order = BASE_ORDER_STEP;

      // Sanity check
      const nextEl = items[1];
      if (nextEl && items[0].order >= nextEl.order) {
        reassignOrder(items, 1);
      }
      return;
    }

    // if last element, set max + 1000000
    if (index === items.length - 1) {
      const orders: number[] = items.map(item => isNaN(item.order) ? 0 : item.order);
      const maxOrder = Math.max(...orders);
      items[index].order = (maxOrder - maxOrder % BASE_ORDER_STEP) + BASE_ORDER_STEP;

      // Sanity check unneeded since we can always grow up
      return;
    }

    // If middle of array, use average of values
    const prevItem = items[index - 1];
    const nextItem = items[index + 1];

    // ceil so we always grow up
    const newOrder = Math.ceil((prevItem.order + nextItem.order) / 2);
    items[index].order = newOrder;

    // sanity check
    // reassign higher indexes first
    if (items[index].order >= items[index + 1].order) {
      reassignOrder(items, index + 1);
    }

    if (items[index - 1].order >= items[index].order) {
      reassignOrder(items, index - 1);
    }
  }

  function reassignAllOrders<T extends { order: number }>(items: T[]) {
    items.forEach((item, index) => {
      item.order = (index + 1) * BASE_ORDER_STEP;
    });
  }

  let ordersAreValid = false;
  while (!ordersAreValid) {
    ordersAreValid = true;

    for (let i = 0; i < itemsClone.length; i += 1) {
      const currItem = itemsClone[i];
      const prevItem = itemsClone[i - 1];
      if (prevItem && prevItem.order >= currItem.order) {
        reassignOrder(itemsClone, i);
        ordersAreValid = false;
        break;
      }
    }
  }

  // nuke option -> if changed rate is above threshhold
  // just update everything into good numbers to avoid future recalcs
  let numberChanged = 0;
  for (let i = 0; i < itemsClone.length; i += 1) {
    if (itemsClone[i].order !== oldItems[i].order) {
      numberChanged += 1;
    }
  }

  const changedRate = numberChanged / itemsClone.length;
  if (changedRate > NUKE_OPTION_THRESHOLD) {
    reassignAllOrders(itemsClone);
  }

  return itemsClone;
}

type Props = {
  onAreaEditClick: (area: Models.Community.Area) => void;
  onChannelEditClick: (channel: Models.Community.Channel) => void;
  onCreateChannelClick: (area: Models.Community.Area) => void;
  onCreateNewArea: () => void;
  selectedId?: string;
};

const ChannelManagementAreaList: React.FC<Props> = (props) => {
  const { onAreaEditClick, onChannelEditClick, onCreateChannelClick, onCreateNewArea, selectedId } = props;
  const { community, areas, channels } = useLoadedCommunityContext();
  const [channelsDict, setChannelsDict] = useState<ChannelDict>({});

  const [_areas, _setAreas] = useState<Models.Community.Area[]>([...areas]);
  const [expandedAreaIds, setExpandedAreaIds] = useState<string[]>([]);
  const sensors = useDragSensors();

  // While a channel is being dragged this holds the *preview* arrangement, so a
  // channel dragged into another area is visibly inserted there. `channelsDict`
  // itself is deliberately left untouched for the duration of the drag — the
  // persistence code below is fed the pre-drag lists, exactly as it was under
  // react-beautiful-dnd.
  const [dragChannels, setDragChannels] = useState<ChannelDict | null>(null);
  const [channelDragStart, setChannelDragStart] = useState<{ areaId: string; index: number } | null>(null);
  const renderedChannels = dragChannels ?? channelsDict;
  const areaIds = useMemo(() => _areas.map(area => area.id), [_areas]);

  const handleAreaItemClick = (area: Models.Community.Area) => {
    if (expandedAreaIds.includes(area.id)) {
      const newExpandedIds = expandedAreaIds.filter(thisId => thisId !== area.id);
      setExpandedAreaIds(newExpandedIds);
    } else {
      setExpandedAreaIds([...expandedAreaIds, area.id]);
    }
  }

  const getAreaChannels = (areaId: string, channels: Readonly<Models.Community.Channel[]>) => {
    return channels.filter(channel => channel.areaId === areaId);
  }

  const _findNexOrder = (items: Pick<(Models.Community.Area | Models.Community.Channel), 'order'>[]): number => {
    if (!!items && items.length > 0) {
      const orders: number[] = items.map(item => isNaN(item.order) ? 0 : item.order);
      const maxOrder = Math.max(...orders);
      return (maxOrder - maxOrder % 1000000) + 1000000;
    }
    return 1000000;
  };

  const calculateMovedAreaOrder = useCallback((areas: Models.Community.Area[], previousAreaIndex: number, followingAreaIndex: number): number => {
    const previousAreaOrder = (previousAreaIndex >= 0) ? areas[previousAreaIndex].order : 0;
    const followingAreaOrder = (followingAreaIndex < areas.length) ? areas[followingAreaIndex].order : _findNexOrder(areas);
    const areaOrder = Math.round((previousAreaOrder + followingAreaOrder) / 2);
    return areaOrder;
  }, []);

  const calculateMovedChannelOrder = useCallback((channels: Models.Community.Channel[], previousChannelIndex: number, followingChannelIndex: number): number => {
    const previousChannelOrder = (previousChannelIndex >= 0) ? channels[previousChannelIndex].order : 0;
    const followingChannelOrder = (followingChannelIndex < channels.length) ? channels[followingChannelIndex].order : _findNexOrder(channels);
    const channelOrder = Math.round((previousChannelOrder + followingChannelOrder) / 2);
    return channelOrder;
  }, []);

  const updateAreaOrder = useCallback(async (prevAreas: Models.Community.Area[] | undefined, draggedArea: Models.Community.Area, sourceIndex: number, destinationIndex: number) => {
    if (prevAreas) {
      const prevIndex = destinationIndex > sourceIndex ? destinationIndex : destinationIndex - 1;
      const nextIndex = destinationIndex < sourceIndex ? destinationIndex : destinationIndex + 1;
      const movedAreaOrder = calculateMovedAreaOrder(prevAreas, prevIndex, nextIndex);
      const newDraggedArea = { ...draggedArea, order: movedAreaOrder };

      const updatedAreas = _.cloneDeep(prevAreas);
      updatedAreas.splice(sourceIndex, 1);
      updatedAreas.splice(destinationIndex, 0, newDraggedArea);
      const newAreas = findNewOrder(updatedAreas);

      _setAreas(newAreas);

      await data.community.updateArea(community.id, newDraggedArea.id, { order: movedAreaOrder });

      for (let i = 0; i < newAreas.length; i++) {
        const foundArea = prevAreas.find(prevArea => prevArea.id === newAreas[i].id);
        if (foundArea && foundArea.order !== newAreas[i].order) {
          await data.community.updateArea(community.id, newAreas[i].id, { order: newAreas[i].order });
        }
      }
    }
  }, [calculateMovedAreaOrder, community.id]);

  const updateChannelOrder = useCallback(async (areaId: string, prevChannels: Models.Community.Channel[] | undefined, draggedChannel: Models.Community.Channel, sourceIndex: number, destinationIndex: number) => {
    if (prevChannels) {
      const prevIndex = destinationIndex > sourceIndex ? destinationIndex : destinationIndex - 1;
      const nextIndex = destinationIndex < sourceIndex ? destinationIndex : destinationIndex + 1;
      const movedChannelOrder = calculateMovedChannelOrder(prevChannels, prevIndex, nextIndex);
      const newDraggedChannel = { ...draggedChannel, order: movedChannelOrder };

      const updatedChannels = _.cloneDeep(prevChannels);
      updatedChannels.splice(sourceIndex, 1);
      updatedChannels.splice(destinationIndex, 0, newDraggedChannel);
      const newChannels = findNewOrder(updatedChannels);

      const newChannelsDict = _.cloneDeep(channelsDict);
      newChannelsDict[areaId].textChannels = newChannels;
      setChannelsDict(newChannelsDict);

      await data.community.updateChannel(community.id, newDraggedChannel.channelId, { order: movedChannelOrder, areaId });

      for (let i = 0; i < newChannels.length; i++) {
        const foundChannel = prevChannels.find(prevChannel => prevChannel.channelId === newChannels[i].channelId);
        if (foundChannel && foundChannel.order !== newChannels[i].order) {
          await data.community.updateChannel(community.id, newChannels[i].channelId, { order: newChannels[i].order, areaId });
        }
      }
    }
  }, [calculateMovedChannelOrder, channelsDict, community.id]);

  const onAreaDragEnd = useCallback(async (activeId: string, overId: string) => {
    const sourceIndex = _areas.findIndex(area => area.id === activeId);
    const destinationIndex = _areas.findIndex(area => area.id === overId);

    // check if location of draggable didn't change
    if (sourceIndex < 0 || destinationIndex < 0 || sourceIndex === destinationIndex) {
      return;
    }

    const draggedArea = _areas[sourceIndex];
    if (draggedArea) {
      await updateAreaOrder(_areas, draggedArea, sourceIndex, destinationIndex);
    }
  }, [_areas, updateAreaOrder]);

  const onChannelDragEnd = useCallback(async (activeId: string, overId: string) => {
    const start = channelDragStart;
    const dict = dragChannels ?? channelsDict;
    const originalAreaId = start?.areaId;
    const newAreaId = findChannelArea(dict, activeId);

    if (!start || !originalAreaId || !newAreaId) {
      return;
    }

    // The list the channel currently previews in already contains it, so the
    // index `over` sits at is the index the channel ends up at — which is what
    // react-beautiful-dnd reported as `destination.index` for both a reorder
    // inside one area and a move into another one.
    const previewList = dict[newAreaId].textChannels;
    const overIndex = previewList.findIndex(channel => channel.channelId === overId);
    const destinationIndex = overIndex >= 0 ? overIndex : previewList.length - 1;
    const sourceIndex = start.index;

    // check if location of draggable didn't change
    if (newAreaId === originalAreaId && destinationIndex === sourceIndex) {
      return;
    }

    const originalAreaChannels = getAreaChannels(originalAreaId, channels);
    const draggedChannel = originalAreaChannels?.find((channel) => channel?.channelId === activeId);

    if (draggedChannel) {
      const newAreaTextChannels = channelsDict[newAreaId].textChannels;
      await updateChannelOrder(newAreaId, newAreaTextChannels, draggedChannel, sourceIndex, destinationIndex);
    }
  }, [channels, updateChannelOrder, channelsDict, dragChannels, channelDragStart]);

  const onDragStart = useCallback((event: DragStartEvent) => {
    if (event.active.data.current?.type !== CHANNEL_TYPE) {
      return;
    }
    const areaId = String(event.active.data.current?.areaId);
    const index = channelsDict[areaId]?.textChannels
      .findIndex(channel => channel.channelId === event.active.id) ?? -1;
    setChannelDragStart({ areaId, index });
    setDragChannels(_.cloneDeep(channelsDict));
  }, [channelsDict]);

  // Cross-area moves are applied to the preview while the pointer is still
  // down; reordering *within* one area is left to dnd-kit's sortable strategy
  // and only settled on drop.
  const onDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (active.data.current?.type !== CHANNEL_TYPE || !over) {
      return;
    }
    const targetAreaId = over.data.current?.areaId as string | undefined;
    if (!targetAreaId) {
      return;
    }

    setDragChannels(previous => {
      const dict = previous ?? channelsDict;
      const activeId = String(active.id);
      const sourceAreaId = findChannelArea(dict, activeId);
      if (!sourceAreaId || sourceAreaId === targetAreaId || !dict[targetAreaId]) {
        return previous;
      }
      const moved = dict[sourceAreaId].textChannels.find(channel => channel.channelId === activeId);
      if (!moved) {
        return previous;
      }

      const next = _.cloneDeep(dict);
      next[sourceAreaId].textChannels = next[sourceAreaId].textChannels
        .filter(channel => channel.channelId !== activeId);
      const overIndex = next[targetAreaId].textChannels
        .findIndex(channel => channel.channelId === String(over.id));
      const insertAt = overIndex >= 0 ? overIndex : next[targetAreaId].textChannels.length;
      next[targetAreaId].textChannels.splice(insertAt, 0, moved);
      return next;
    });
  }, [channelsDict]);

  const onDragCancel = useCallback(() => {
    setChannelDragStart(null);
    setDragChannels(null);
  }, []);

  const onDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;

    if (active.data.current?.type === AREA_TYPE) {
      if (over) {
        await onAreaDragEnd(String(active.id), String(over.id));
      }
      return;
    }

    const activeId = String(active.id);
    const overId = over ? String(over.id) : undefined;
    // Drop the preview here; `onChannelDragEnd` reads the arrangement out of
    // this render's `dragChannels` closure, not out of the state.
    setDragChannels(null);
    setChannelDragStart(null);
    if (overId !== undefined) {
      await onChannelDragEnd(activeId, overId);
    }
  }, [onAreaDragEnd, onChannelDragEnd]);

  useEffect(() => {
    _setAreas([...areas]);
    const newChannelsDict: ChannelDict = {};
    if (!!channels && !!areas) {
      areas.forEach(area => {
        const mappedChannels = {
          textChannels: channels.filter(channel => channel.areaId === area.id).sort((a, b) => a.order - b.order),
        }
        if (newChannelsDict[area.id]) {
          newChannelsDict[area.id] = mappedChannels;
        } else {
          newChannelsDict[area.id] = {
            textChannels: mappedChannels.textChannels,
          }
        }
      });
    }
    setChannelsDict(newChannelsDict);
  }, [areas, channels]);

  return (<DndContext
    sensors={sensors}
    collisionDetection={typedCollisionDetection}
    onDragStart={onDragStart}
    onDragOver={onDragOver}
    onDragCancel={onDragCancel}
    onDragEnd={onDragEnd}
  >
    <SortableContext items={areaIds} strategy={verticalListSortingStrategy}>
      <div className="management-area">
        <div className="area-panel">
          <div
            className="panel-list"
          >
            {_areas && _areas.map((area) => {
              const expanded = expandedAreaIds.includes(area.id);
              const sortedTextChannels = renderedChannels[area.id]?.textChannels;
              return (
                <SortableAreaRow key={area.id} areaId={area.id}>
                  {(dragging, dragHandleProps) => (
                    <AreaItem
                      area={area}
                      expanded={expanded}
                      sortedTextChannels={sortedTextChannels}
                      onAreaClick={handleAreaItemClick}
                      onAreaEditClick={onAreaEditClick}
                      onChannelEditClick={onChannelEditClick}
                      onCreateChannelClick={onCreateChannelClick}
                      dragging={dragging}
                      draggableHandlerProps={dragHandleProps}
                      highlightOnDragOver={channelDragStart?.areaId === area.id}
                      selectedId={selectedId}
                    />
                  )}
                </SortableAreaRow>
              );
            })}
          </div>

          <Button
            text="+ New area"
            onClick={onCreateNewArea}
            role="chip"
            className="mt-6"
          />
        </div>
      </div>
    </SortableContext>
  </DndContext>
  )
}

type SortableAreaRowProps = {
  areaId: string;
  children: (dragging: boolean, dragHandleProps: DragHandleProps) => React.ReactNode;
};

/**
 * The area row. The whole row moves, but only the header is the handle — the
 * expanded channel list below it belongs to the channels, not to the area.
 */
function SortableAreaRow(props: SortableAreaRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.areaId, data: { type: AREA_TYPE } });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        position: 'relative',
        zIndex: isDragging ? 5000 : undefined,
      }}
    >
      {props.children(isDragging, { attributes, listeners, setActivatorNodeRef })}
    </div>
  );
}

export default React.memo(ChannelManagementAreaList);