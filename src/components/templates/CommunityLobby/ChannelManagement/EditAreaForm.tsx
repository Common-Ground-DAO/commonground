// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useState } from "react";
import data from "data";
import Modal from "components/atoms/Modal/Modal";
import TextInputField from "components/molecules/inputs/TextInputField/TextInputField";
import CloseIcon from 'components/atoms/icons/16/Close-1.svg?react';
import Button from "components/atoms/Button/Button";
import { useNavigationContext } from "components/SuspenseRouter/SuspenseRouter";
import { useSnackbarContext } from "context/SnackbarContext";
import FloatingSaveOptions from "../FloatingSaveOptions/FloatingSaveOptions";

type Props = {
  communityId: string;
  area: Models.Community.Area | undefined;
  onFinish: (close?: boolean) => void;
  nextOrder: number;
}

export default function EditAreaForm(props: Props) {
  const { communityId, area, onFinish, nextOrder } = props;
  const [areaName, setAreaName] = useState<string>(area?.title || '');
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState<boolean>(false);
  const { showSnackbar } = useSnackbarContext();
  const { isDirty, setDirty } = useNavigationContext();
  const isEditing = !!area;

  const setAreaNameDirty = useCallback((areaName: string) => {
    setAreaName(areaName);
    setDirty(true);
  }, [setDirty]);

  const handleDeleteArea = useCallback(async () => {
    if (isEditing) {
      try {
        await data.community.deleteArea(communityId, area.id);
        showSnackbar({ type: 'info', text: 'Area deleted' });
        setShowDeleteConfirmation(false);
        onFinish(true);
      } catch (err) {
        console.error(err);
      }
    }
  }, [area, communityId, isEditing, onFinish, showSnackbar])

  const handleAreaSave = useCallback(async () => {
    if (!areaName || area?.title === areaName) {
      onFinish();
    } else if (isEditing) {
      if (areaName !== area.title) {
        try {
          data.community.updateArea(communityId, area.id, { title: areaName });
          showSnackbar({ type: 'info', text: 'Area updated' });
          onFinish();
        } catch (err) {
          console.error(err);
        }
      }
    } else {
      try {
        data.community.createArea({
          communityId,
          title: areaName,
          order: nextOrder,
        });
        showSnackbar({ type: 'info', text: 'Area created' });
        onFinish();
      } catch (err) {
        console.error(err);
      }
    }
  }, [area, areaName, communityId, isEditing, nextOrder, onFinish, showSnackbar])

  return (
    <>
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <span className='section-title'>General</span>
          <div className="form-container cg-content-stack">
            <TextInputField
              label="Area name"
              value={areaName}
              onChange={setAreaNameDirty}
              placeholder="What should the area be called?"
            />
          </div>
        </div>
        {isEditing && <Button
          className='w-full'
          role='destructive'
          text="Delete area"
          onClick={() => setShowDeleteConfirmation(true)}
        />}
      </div>
      {showDeleteConfirmation && isEditing && (
        <Modal
          headerText={`Delete ${area.title}`}
          close={() => setShowDeleteConfirmation(false)}
        >
          <div className="modal-inner">
            <p>Are you sure you want to delete {area.title}?</p>
            <div className="btnList justify-end align-center mt-6">
              <Button
                onClick={() => setShowDeleteConfirmation(false)}
                text="Cancel"
                role="secondary"
              />
              <Button
                onClick={handleDeleteArea}
                iconLeft={<CloseIcon />}
                text="Delete area"
                role="destructive"
              />
            </div>
          </div>
        </Modal>
      )}
      {isDirty && <FloatingSaveOptions onSave={handleAreaSave} />}
    </>
  )
}