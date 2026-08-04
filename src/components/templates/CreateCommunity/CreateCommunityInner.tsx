// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useState } from "react";
import './CreateCommunity.css';
import { useNavigate } from "react-router";

import { CommunityLink } from "common/types";
import { validateGenericTextInput } from "../../../common/validators";

import CloseIcon from '../../../components/atoms/icons/16/Close-1.svg?react';

import Button from "../../../components/atoms/Button/Button";
import Modal from "../../atoms/Modal/Modal";
import TagInputField from "../../../components/molecules/inputs/TagInputField/TagInputField";
import TextAreaField from "../../molecules/inputs/TextAreaField/TextAreaField";
import TextInputField from "../../molecules/inputs/TextInputField/TextInputField";
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";
import { useLoggedInOwnUser } from "context/OwnDataProvider";
import { useSnackbarContext } from "context/SnackbarContext";
import data from "data";
import fileApi from "data/api/file";
import { getUrl } from 'common/util';
import Tag from "components/atoms/Tag/Tag";
import ImageUploadField from "components/molecules/inputs/ImageUploadField/ImageUploadField";

type Props = {
  onCancel: () => void;
  onSuccess?: () => void;
}

const CreateCommunityInner: React.FC<Props> = ({ onCancel, onSuccess }) => {
  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const ownUser = useLoggedInOwnUser();
  const { showSnackbar } = useSnackbarContext();
  const [title, setTitle] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [shortDescription, setShortDescription] = useState<string>('');
  const [links] = useState<CommunityLink[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string>();
  const [nameError, setNameError] = useState<string>();
  const [descError, setDescError] = useState<string>();
  const [shortDescError, setShortDescError] = useState<string>();
  const [nftError, setNftError] = useState<string>();
  const [selectedLogo, setSelectedLogo] = useState<File>();
  const [logoUrl, setLogoUrl] = React.useState<string>();
  const [selectedSidebarImage, setSelectedSidebarImage] = useState<File>();
  const [sidebarImageUrl, setSidebarImageUrl] = React.useState<string>();
  const [selectedHeader, setSelectedHeader] = useState<File>();
  const [headerUrl, setHeaderUrl] = React.useState<string>();
  const [showModal, setShowModal] = useState<boolean>(false);

  const [userEmail, setUserEmail] = useState(ownUser.email || '');

  //////////////// Validation ////////////////

  useEffect(() => {
    setNameError(validateGenericTextInput(title));
  }, [title]);

  useEffect(() => {
    if (description.length > 1000) {
      setDescError("You’ve reached the 1000 character limit! Well done!");
    } else {
      setDescError(undefined);
    }
  }, [description]);

  useEffect(() => {
    if (shortDescription.length > 50) {
      setShortDescError("You’ve reached the 50 character limit! Well done!");
    } else {
      setShortDescError(undefined);
    }
  }, [shortDescription]);

  useEffect(() => {
    if (!selectedLogo) {
      return;
    }
    const objectUrl = URL.createObjectURL(selectedLogo)
    setLogoUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl)
  }, [selectedLogo]);

  useEffect(() => {
    if (!selectedSidebarImage) {
      return;
    }
    const objectUrl = URL.createObjectURL(selectedSidebarImage)
    setSidebarImageUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl)
  }, [selectedSidebarImage]);

  useEffect(() => {
    if (!selectedHeader) {
      return;
    }
    const objectUrl = URL.createObjectURL(selectedHeader)
    setHeaderUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl)
  }, [selectedHeader]);

  ////////////////////////////////////////////

  const saveCommunity = async () => {
    if (!title && !selectedLogo) {
      setError('Please add a name and logo for your community');
      return;
    } else if (!title) {
      setError('Please add a name for your community');
      return;
    } else if (!selectedLogo) {
      setError('Please add a logo for your community');
      return;
    } else if (nameError !== undefined ||
      descError !== undefined ||
      shortDescError !== undefined ||
      nftError !== undefined) {
      setError('There are still some errors present, please check all fields.');
      return;
    }

    if (!nameError && !descError && title !== '') {
      setSaving(true);
      try {
        if (userEmail) {
          // Todo
          // await cgApi.write.addEmailContact(userEmail, true);
        }
      }
      catch (e) {
        console.warn('Error during subscription to community creation email journey');
      }
      try {
        let headerImageId: string | null = null, logoLargeId: string | null = null, logoSmallId: string | null = null;
        if (!!selectedHeader) {
          const response = await fileApi.uploadImage({
            type: "communityHeaderImage"
          }, selectedHeader);
          headerImageId = response.imageId;
        }
        if (!!selectedSidebarImage) {
          const response = await fileApi.uploadImage({
            type: "communityLogoLarge"
          }, selectedSidebarImage);
          logoLargeId = response.imageId;
        }
        if (!!selectedLogo) {
          const response = await fileApi.uploadImage({
            type: "communityLogoSmall"
          }, selectedLogo);
          logoSmallId = response.imageId;
        }
        const community = await data.community.createCommunity({
          title,
          description,
          shortDescription,
          links,
          tags,
          headerImageId,
          logoLargeId,
          logoSmallId
        });
        showSnackbar({ type: 'info', text: 'Post successful' });

        navigate(getUrl({ type: 'community-lobby', community }));
        onSuccess?.();
      }
      catch (e) {
        setError(e instanceof Error ? e.message : 'An unknown error occurred');
        setSaving(false);
      }
    }
  }

  let errorEl: React.JSX.Element | undefined;
  if (error !== '') {
    errorEl = (
      <Tag variant="error" label={error} />
    );
  }

  return (
    <>
      {showModal && <Modal headerText="Are you sure you want to cancel?" close={() => setShowModal(false)}>
        <div className="modal-inner">
          <p>You will lose your progress</p>
          <div className="btnList justify-end mt-4">
            <Button
              text="No, stay here"
              onClick={() => setShowModal(false)}
              role="secondary"
            />
            <Button
              text="Yes, cancel"
              onClick={onCancel}
              role="primary"
              iconLeft={<CloseIcon />}
            />
          </div>
        </div>
      </Modal>}
      <div className="content">
        <TextInputField
          value={title}
          onChange={(value: string) => setTitle(value)}
          placeholder="Make it catchy"
          label="Community name"
          inputClassName={`${nameError ? 'error ' : ''}`}
          error={nameError}
        />
        <TextAreaField
          value={description}
          onChange={setDescription}
          placeholder="Describe your community in a way anyone can understand"
          label="Description"
          inputClassName={`${descError ? 'error ' : ''} input`}
          error={descError}
          maxLetters={1000}          
        />
        <TextInputField
          value={shortDescription}
          onChange={setShortDescription}
          placeholder="For the community tile, 50 character limit, be brief!"
          label="Tagline"
          inputClassName={`${shortDescError ? 'error ' : ''}`}
          error={shortDescError}
          maxLetters={50}
        />
        <TagInputField
          tags={tags}
          onTagsChange={setTags}
          placeholder={isMobile ? "Add tags" : "Add tags like Sports, Games, Music, Business"}
          label="Tags"
          // subLabel="Select up to 4 tags to represent your community"
        />
        <ImageUploadField 
          label="Community banner"
          subLabels={["Banner on your community frontpage", "8mb limit, 800 x 252 px recommended"]}
          imageURL={headerUrl}
          onChange={setSelectedHeader}
          imagePreviewStyle={{width: '100%', height: 'auto', aspectRatio: '4'}}
        />
        <ImageUploadField 
          label="Community sidebar cover*"
          subLabels={["On the community sidebar", "8mb limit, 282 x 220 px recommended"]}
          imageURL={sidebarImageUrl}
          onChange={setSelectedSidebarImage}
          imagePreviewStyle={{width: '282px', height: '220px'}}
        />
        <ImageUploadField 
          label="Community logo*"
          subLabels={["8mb limit, 75 x 75 px recommended"]}
          imageURL={logoUrl}
          onChange={setSelectedLogo}
          imagePreviewStyle={{width: '75px', height: '75px'}}
        />
        {/* <CommunityLinks
          links={links}
          onChange={setLinks}
          label="Links"
          subLabel="Add links to other platforms relevant for your community"
        /> */}

        {!ownUser?.email && <TextInputField
          value={userEmail}
          onChange={setUserEmail}
          label="Your E-mail"
          placeholder="Receive community tips, guides and more"
        />}

        {error && errorEl}

        <div className="btnList justify-between mb-8">
          <Button
            text="Cancel"
            role="secondary"
            onClick={() => setShowModal(true)}
          />
          <Button
            text="Create a community"
            role="primary"
            loading={saving}
            onClick={saveCommunity}
          />
        </div>
      </div>
    </>
  )
}

export default React.memo(CreateCommunityInner);