// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import CommunityLinks from "../../../molecules/CommunityLinksInput/CommunityLinks";
import LeaveCommunityModal from "../../../../components/organisms/LeaveCommunityModal/LeaveCommunityModal";
import TagInputField from "../../../../components/molecules/inputs/TagInputField/TagInputField";
import TextAreaField from "../../../molecules/inputs/TextAreaField/TextAreaField";
import TextInputField from "../../../molecules/inputs/TextInputField/TextInputField";

import { validateGenericTextInput } from "../../../../common/validators";
import { useSignedUrl } from "../../../../hooks/useSignedUrl";
import { useLoadedCommunityContext } from "../../../../context/CommunityProvider";
import { useCommunitySidebarContext } from "../../../../components/organisms/CommunityViewSidebar/CommunityViewSidebarContext";
import { useWindowSizeContext } from "../../../../context/WindowSizeProvider";
import data from "data";
import fileApi from "data/api/file";
import Scrollable from "components/molecules/Scrollable/Scrollable";
import { getUrl } from 'common/util';

import './CommunityManagement.css';
import ImageUploadField from "components/molecules/inputs/ImageUploadField/ImageUploadField";
import ManagementHeader2 from "components/molecules/ManagementHeader2/ManagementHeader2";
import { useNavigationContext } from "components/SuspenseRouter/SuspenseRouter";
import FloatingSaveOptions from "../FloatingSaveOptions/FloatingSaveOptions";
import { useSnackbarContext } from "context/SnackbarContext";
import { imageUploadErrorText, notifyIfImageRejected } from "moderation/imageUploadError";

type Props = {
};

const CommunityManagement: React.FC<Props> = (props: Props) => {
  const { showSnackbar } = useSnackbarContext();
  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const { community } = useLoadedCommunityContext();
  const { showLeaveGroupModal, setShowLeaveGroupModal } = useCommunitySidebarContext();
  const { isDirty, setDirty } = useNavigationContext();
  const [nameError, setNameError] = React.useState<string | undefined>();
  const [descError, setDescError] = React.useState<string | undefined>();

  const [title, setTitle] = React.useState<string>(community.title);
  const [description, setDescription] = React.useState<string>(community.description);
  const [shortDescription, setShortDescription] = React.useState<string>(community.shortDescription);
  const [links, setLinks] = React.useState<Common.Link[]>(community.links);
  const [tags, setTags] = React.useState<string[]>(community.tags);

  const [selectedImage, setSelectedImage] = useState<File | undefined>();
  const [selectedSidebarImage, setSelectedSidebarImage] = useState<File | undefined>();
  const [selectedHeader, setSelectedHeader] = useState<File | undefined>();

  const headerUrl = useSignedUrl(community.headerImageId);
  const sidebarImageUrl = useSignedUrl(community.logoLargeId);
  const imageUrl = useSignedUrl(community.logoSmallId);

  const headerSrc = useMemo(() => {
    if (!!selectedHeader) {
      return URL.createObjectURL(selectedHeader);
    } else {
      return headerUrl;
    }
  }, [selectedHeader, headerUrl]);

  const sidebarImageSrc = useMemo(() => {
    if (!!selectedSidebarImage) {
      return URL.createObjectURL(selectedSidebarImage);
    } else {
      return sidebarImageUrl;
    }
  }, [selectedSidebarImage, sidebarImageUrl]);

  const imageSrc = useMemo(() => {
    if (!!selectedImage) {
      return URL.createObjectURL(selectedImage);
    } else {
      return imageUrl;
    }
  }, [selectedImage, imageUrl]);

  const updateTitle = React.useCallback((newTitle: string) => {
    setDirty(true);
    setTitle(newTitle);
    setNameError(validateGenericTextInput(newTitle));
  }, [setDirty]);

  const updateDescription = React.useCallback((newDescription: string) => {
    setDirty(true);
    setDescription(newDescription);
    if (newDescription.length > 1000) {
      setDescError("You’ve reached the 1000 character limit! Well done!");
    } else {
      setDescError(undefined);
    }
  }, [setDirty]);

  const updateShortDescription = React.useCallback((newDescription: string) => {
    setDirty(true);
    setShortDescription(newDescription);
    if (newDescription.length > 50) {
      setDescError("You’ve reached the 50 character limit! Well done!");
    } else {
      setDescError(undefined);
    }
  }, [setDirty]);

  const updateLinks = React.useCallback((newLinks: Common.Link[]) => {
    setDirty(true);
    setLinks([...newLinks]);
  }, [setDirty]);

  const handleImageChange = useCallback((file?: File) => {
    setDirty(true);
    setSelectedImage(file);
  }, [setDirty]);

  const handleSidebarImageChange = useCallback((file?: File) => {
    setDirty(true);
    setSelectedSidebarImage(file);
  }, [setDirty]);

  const handleHeaderChange = useCallback((file?: File) => {
    setDirty(true);
    setSelectedHeader(file);
  }, [setDirty])

  // Submits changes of the current groupInfo to API
  const submitChanges = React.useCallback(async () => {
    if (!!nameError || !!descError) return;

    const communityUpdates: Partial<Models.Community.DetailView> = {
      title,
      description,
      shortDescription,
      links: links.filter(link => !!link.text && !!link.url),
      tags,
      enablePersonalNewsletter: undefined
    }
    await data.community.updateCommunity(community.id, communityUpdates);

    // `FloatingSaveOptions` wires this straight to an onClick without awaiting,
    // so an upload rejection (e.g. the NSFW filter's IMAGE_CONTENT_REJECTED)
    // would otherwise escape as an unhandled rejection and tell the user
    // nothing.
    try {
      if (selectedImage) {
        await fileApi.uploadImage({
          type: 'communityLogoSmall',
          communityId: community.id
        }, selectedImage);
      }

      if (selectedSidebarImage) {
        await fileApi.uploadImage({
          type: 'communityLogoLarge',
          communityId: community.id
        }, selectedSidebarImage);
      }

      if (selectedHeader) {
        await fileApi.uploadImage({
          type: 'communityHeaderImage',
          communityId: community.id
        }, selectedHeader);
      }
    } catch (e) {
      if (!notifyIfImageRejected(e)) {
        showSnackbar({ type: 'warning', text: imageUploadErrorText(e, 'Could not upload the image') });
      }
      return;
    }
    setDirty(false);
  }, [community.id, descError, description, links, nameError, selectedHeader, selectedImage, selectedSidebarImage, setDirty, shortDescription, showSnackbar, tags, title]);

  const updateTags = React.useCallback((newTags: string[]) => {
    setDirty(true);
    setTags(newTags);
  }, [setDirty]);

  const communityManagementContent = useMemo(() => <div className="flex flex-col gap-6 mb-20">
    <TextInputField
        value={title}
        onChange={updateTitle}
        placeholder="Make it catchy"
        label="Community name"
        inputClassName={`${nameError ? 'error ' : ''}`}
        error={nameError}
      />
      <TextAreaField
        value={description}
        onChange={updateDescription}
        placeholder="Describe the community in a way anyone can understand"
        label="Description"
        inputClassName={`${descError ? 'error ' : ''}rounded input`}
        error={descError}
        rows={3}
        maxLetters={1000}
      />
      <TextInputField
        value={shortDescription || ''}
        onChange={updateShortDescription}
        placeholder="For the community tile, 50 character limit, be brief!"
        label="Tagline"
        inputClassName={`${nameError ? 'error ' : ''}`}
        error={nameError}
        maxLetters={50}
      />
      <TagInputField
        tags={tags || []}
        onTagsChange={updateTags}
        placeholder="Add tags like DeFi, NFT, Ethereum, and more"
        label="Tags"
        // subLabel="Add tags so your community can be found"
      />
      <ImageUploadField 
        label="Community banner"
        subLabels={["Banner on your community frontpage", "8mb limit, 800 x 252 px recommended"]}
        imageURL={headerSrc}
        onChange={handleHeaderChange}
        imagePreviewStyle={{width: '100%', height: 'auto', aspectRatio: '4'}}
      />
      <ImageUploadField 
        label="Community sidebar cover*"
        subLabels={["On the community sidebar", "8mb limit, 282 x 220 px recommended"]}
        imageURL={sidebarImageSrc}
        onChange={handleSidebarImageChange}
        imagePreviewStyle={{width: '282px', height: '220px'}}
      />
      <ImageUploadField 
        label="Community logo*"
        subLabels={["8mb limit, 75 x 75 px recommended"]}
        imageURL={imageSrc}
        onChange={handleImageChange}
        imagePreviewStyle={{width: '75px', height: '75px'}}
      />
      <CommunityLinks
        links={links || []}
        onChange={updateLinks}
        label="Links"
        subLabel="Add links to other platforms relevant for your community"
      />
  </div>, [descError, description, handleHeaderChange, handleImageChange, handleSidebarImageChange, headerSrc, imageSrc, links, nameError, shortDescription, sidebarImageSrc, tags, title, updateDescription, updateLinks, updateShortDescription, updateTags, updateTitle]);

  return (
    <>
      <div className="communityManagement">
        <ManagementHeader2
          title="Set up your community"
          goBack={() => navigate(getUrl({ type: 'community-settings', community }))}
        />
        {isMobile && <Scrollable>
          {communityManagementContent}
        </Scrollable>}
        {!isMobile && communityManagementContent}
        {isDirty && <FloatingSaveOptions
          onSave={submitChanges}
        />}
      </div>
      <LeaveCommunityModal open={showLeaveGroupModal} onClose={() => setShowLeaveGroupModal(false)} />
    </>
  )
}

export default CommunityManagement