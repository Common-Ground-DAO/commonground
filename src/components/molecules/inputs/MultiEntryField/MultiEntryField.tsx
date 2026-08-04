// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { DotsSixVertical, Minus, Plus } from '@phosphor-icons/react';
import React, { useCallback, useMemo, useState } from 'react';
import './MultiEntryField.css';
import { closestCenter, DndContext, DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDragSensors } from 'hooks/useDragSensors';
import Button from 'components/atoms/Button/Button';
import TextAreaField from '../TextAreaField/TextAreaField';

type Props = {
  entries: string[];
  setEntries: (entries: string[]) => void;
  newEntryBtnText: string;
  limit: number;
  disallowEmpty: boolean;
}

/** Stable within a drag: `entries` only changes on drop or on an edit. */
const entryId = (entry: string, index: number) => `${entry}_${index}`;

const MultiEntryField: React.FC<Props> = (props) => {
  const {
    entries,
    setEntries,
    newEntryBtnText,
    limit,
    disallowEmpty
  } = props;
  const [autoFocusIndex, setAutoFocusIndex] = useState<number | null>(null);
  const [draggingOver, setDraggingOver] = useState(false);
  const sensors = useDragSensors();

  const entryIds = useMemo(() => entries.map(entryId), [entries]);

  const onDragEnd = useCallback((event: DragEndEvent) => {
    setDraggingOver(false);
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    const sourceIndex = entryIds.indexOf(String(active.id));
    const destinationIndex = entryIds.indexOf(String(over.id));
    if (sourceIndex < 0 || destinationIndex < 0 || sourceIndex === destinationIndex) {
      return;
    }
    const newEntries = [...entries];
    const [element] = newEntries.splice(sourceIndex, 1);
    newEntries.splice(destinationIndex, 0, element);
    setEntries(newEntries);
  }, [entries, entryIds, setEntries]);

  return (<div className='flex flex-col gap-1 cg-text-main'>
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={() => setDraggingOver(true)}
      onDragCancel={() => setDraggingOver(false)}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={entryIds} strategy={verticalListSortingStrategy}>
        <div
          className={`multi-entry-field-container flex flex-col gap-1 ${draggingOver ? ' dragging-over' : ''}`}
        >
          {entries.map((entry, index) => <SortableEntry
            key={index}
            id={entryIds[index]}
          >
            <div className='entry-field-content'>
              <Minus weight='duotone' className='w-6 h-6 cg-text-secondary cursor-pointer' onClick={() => {
                const newEntries = [...entries];
                newEntries.splice(index, 1);
                setEntries(newEntries);
              }} />
              <div className='flex-col gap-1 w-full'>
                <TextAreaField
                  inputClassName='multi-entry-text-input'
                  autoGrow
                  autoFocus={autoFocusIndex === index}
                  value={entry}
                  placeholder={`${newEntryBtnText} ${index + 1}`}
                  maxLetters={180}
                  onChange={value => {
                    const newEntries = [...entries];
                    newEntries[index] = value;
                    setEntries(newEntries);
                  }}
                />
                {disallowEmpty && entry.length === 0 && <span className='cg-text-warning'>This field cannot be empty</span>}
              </div>
            </div>
          </SortableEntry>
          )}
        </div>
      </SortableContext>
    </DndContext>
    {entries.length < limit && <Button
      role='textual'
      className='w-fit'
      iconLeft={<Plus className='w-4 h-4'/>}
      text={newEntryBtnText}
      onClick={() => {
        setEntries([...entries, '']);
        setAutoFocusIndex(entries.length);
      }}
    />}
  </div>);
}

/** One row: the handle is the grip icon only, so the textarea stays selectable. */
function SortableEntry(props: React.PropsWithChildren<{ id: string }>) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        position: 'relative',
        zIndex: isDragging ? 5000 : undefined,
      }}
      className='flex items-center gap-2'
    >
      <div ref={setActivatorNodeRef} {...attributes} {...listeners} className='flex p-2'>
        <DotsSixVertical className='w-4 h-4 cg-text-secondary' />
      </div>
      {props.children}
    </div>
  );
}

export default React.memo(MultiEntryField);