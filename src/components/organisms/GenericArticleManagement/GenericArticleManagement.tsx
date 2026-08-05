// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './GenericArticleManagement.css';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Descendant } from "slate";
import { useSafeCommunityContext } from "context/CommunityProvider";
import { useSignedUrl } from "hooks/useSignedUrl";

import { convertToContentFormat, convertToFieldFormat } from "../../organisms/EditField/EditField.helpers";

import ArticleManagementToolbar from "../../templates/CommunityLobby/ArticleManagement/ArticleManagementToolbar/ArticleManagementToolbar";
import EditFieldThree from "../EditField/EditField";
import HeaderImageUpload from "../../molecules/inputs/HeaderImageUpload/HeaderImageUpload";
import Scrollable, { PositionData } from "../../molecules/Scrollable/Scrollable";
import TextAreaField from "../../molecules/inputs/TextAreaField/TextAreaField";
import { useMobileLayoutContext } from "../../../views/Layout/MobileLayout";

import fileApi from "data/api/file";
import { imageUploadErrorText } from "moderation/imageUploadError";
import { useSnackbarContext } from "context/SnackbarContext";
import ArticleBackupModal, { useArticleBackup } from "../../templates/CommunityLobby/ArticleManagement/ArticleBackupModal";
import dayjs from "dayjs";
import PostPublishedModal from "components/organisms/PostPublishedModal/PostPublishedModal";
import Tag from "components/atoms/Tag/Tag";
import { Clock } from "@phosphor-icons/react";
import TagInputField from "components/molecules/inputs/TagInputField/TagInputField";
import Button from "components/atoms/Button/Button";
import { XMarkIcon } from "@heroicons/react/20/solid";
import { PredefinedRole } from "common/enums";
import config from "common/config";
import communityApi from "data/api/community";

const MIN_SCROLL_UP_DELTA = 20;
const MIN_SCROLL_DOWN_DELTA = 100;
const MAX_SCROLL_DELTA = 200; // For huge avoid updating on huge rerenders

type SaveStates = 'init' | 'saving' | 'saved' | 'deleting' | 'deleted' | 'published' | 'unpublished' | 'error';
export type ItemArticleType =
  Pick<Models.Community.CommunityArticle, 'published' | 'url'> &
  Partial<Pick<Models.Community.CommunityArticle, 'rolePermissions'>> &
  ({
    communityId?: string;
  });

type Props = {
  articleId: string | undefined;
  loadItem: (articleId: string) => Promise<{ article: Models.BaseArticle.DetailView, itemArticle: ItemArticleType & { updatedAt: string } }>;
  createArticleCall: (
    article: Omit<Models.BaseArticle.DetailView, "articleId" | "creatorId">,
    item: ItemArticleType
  ) => Promise<{ articleId: string }>;
  updateArticleCall: (
    article: Omit<Models.BaseArticle.DetailView, "creatorId">,
    item: ItemArticleType & { articleId: string },
  ) => Promise<void>;
  removeArticleCall: (articleId: string) => Promise<void>;
  goBack: () => void;
  itemArticleRef: React.MutableRefObject<ItemArticleType>;

  sendItemAsNewsletter?: (articleId: string) => Promise<void>;
  markedAsNewsletter?: boolean;
  sentAsNewsletter?: string;
}

const emptyArticle: Omit<Models.BaseArticle.DetailView, "articleId" | "creatorId"> = {
  content: {
    version: '2',
    content: []
  },
  headerImageId: null,
  thumbnailImageId: null,
  title: '',
  previewText: '',
  channelId: '',
  commentCount: 0,
  latestCommentTimestamp: null,
  tags: []
}

const convertContentV1toV2 = (content: Models.BaseArticle.Content): Models.BaseArticle.ContentElementV2[] => {
  if (content.version === '2') {
    return content.content;
  }

  // Update v1
  if (content.version === '1') {
    const contentV2: Models.BaseArticle.ContentElementV2[] = [
      { type: 'text', value: content.text }
    ];
    return contentV2;
  }

  console.error('Could not recover article content');
  return [];
}

function formatDateForInfoTags(date: dayjs.Dayjs) {
  return date.format('MMM DD, [at] HH:mm');
}

const GenericArticleManagement: React.FC<Props> = (props) => {
  const {
    articleId,
    loadItem,
    createArticleCall,
    updateArticleCall,
    removeArticleCall,
    sendItemAsNewsletter,
    goBack,
    itemArticleRef,
    markedAsNewsletter,
    sentAsNewsletter,
  } = props;

  const commContext = useSafeCommunityContext();
  const { showSnackbar } = useSnackbarContext();
  const [canSendNewsletter, setCanSendNewsletter] = useState(false);
  const [nextSendDate, setNextSendDate] = useState<dayjs.Dayjs | null>(null);
  const lastStableScrollY = useRef<number>(0);
  const editFieldRef = useRef<React.ElementRef<typeof EditFieldThree>>(null);

  const [saveState, setSaveState] = useState<SaveStates>('init');
  const [imageId, setImageId] = useState<string | null>('');
  const [isSendPostAsEmailModalOpen, setIsSendPostAsEmailModalOpen] = useState<boolean>(false);
  const [title, _setTitle] = useState<string>('');
  const [tags, _setTags] = useState<string[]>([]);
  const [hideNewsletterBanner, setHideNewsletterBanner] = useState(false);
  const articleIdRef = useRef<string>('');
  const articleDataRef = useRef<typeof emptyArticle>(emptyArticle);
  const updatedAtRef = useRef<Models.Community.CommunityArticle['updatedAt']>('');
  const delayedSaveTimeoutRef = useRef<any>(null);
  const imageUrl = useSignedUrl(imageId);
  const { setMenuHidden } = useMobileLayoutContext();
  const { articleBackup, setArticleBackup, deleteBackup } = useArticleBackup(props.articleId);

  const communityId = commContext.state === 'loaded' ? commContext.community.id : '';

  useEffect(() => {
    const canSend = async () => {
      if (!communityId) {
        return;
      }

      try {
        const latestCommunityNewsletterSentDate = await communityApi.getLatestArticleSentAsNewsletterDate({ communityId });
        if (latestCommunityNewsletterSentDate === null) {
          setCanSendNewsletter(true);
          return;
        } else {
          const latestDate = dayjs(latestCommunityNewsletterSentDate);
          const nextValidDate = latestDate.add(config.EMAIL_WAIT_INTERVAL_MINUTES, 'minutes');
          const canSend = dayjs().isAfter(nextValidDate);
          setNextSendDate(nextValidDate);
          setCanSendNewsletter(canSend);
        }
      } catch (e: any) {
        // If we get a not allowed it just means the community is not whitelisted for newsletters
        if (e.message !== 'NOT_ALLOWED') {
          console.error('Failed to check if newsletter can be sent', e);
        }
      }
    }
    canSend();
  }, [communityId]);

  const isCurrentlyScheduled = useMemo(() => {
    return !!itemArticleRef.current?.published && dayjs(itemArticleRef.current?.published).isAfter(dayjs())
  }, [itemArticleRef]);
  const isPublished = !!itemArticleRef.current?.published && !isCurrentlyScheduled;

  const articleRoles = itemArticleRef.current.rolePermissions;
  const relevantRolesForNewsletter = useMemo(() => {
    if (!articleRoles || articleRoles.length === 0) {
      return [];
    }

    const publicRole = articleRoles.find(r => r.roleTitle === PredefinedRole.Public);
    const memberRole = articleRoles.find(r => r.roleTitle === PredefinedRole.Member);
    if (publicRole?.permissions.includes('ARTICLE_READ') || memberRole?.permissions.includes('ARTICLE_READ')) {
      if (memberRole) return [PredefinedRole.Member];
    }

    return articleRoles.filter(r => r.permissions.includes('ARTICLE_READ')).map(r => r.roleTitle);
  }, [articleRoles]);

  const positionCallback = useCallback((data: PositionData) => {
    const lastY = lastStableScrollY.current;
    const currDiff = lastY - data.scrollTop;

    const scrolledMinUp = MIN_SCROLL_UP_DELTA < currDiff;
    const scrolledMinDown = MIN_SCROLL_DOWN_DELTA < currDiff * -1;

    if (scrolledMinUp || scrolledMinDown) {
      // Only callback if there was a feasible change
      if (Math.abs(currDiff) <= MAX_SCROLL_DELTA) {
        if (currDiff > 0) {
          setMenuHidden(false);
        } else if (currDiff < 0) {
          setMenuHidden(true);
        }
      }
      // Always update lastScroll in steps
      lastStableScrollY.current = data.scrollTop;
    }
  }, [setMenuHidden]);

  const setArticleId = useCallback((value: string) => {
    articleIdRef.current = value;
  }, []);

  const saveArticle = useCallback(async (): Promise<string> => {
    setSaveState('saving');

    try {
      let articleId = '';
      if (!articleIdRef.current) {
        const { articleId } = await createArticleCall(articleDataRef.current, itemArticleRef.current);
        setArticleId(articleId);
        setSaveState('saved');

      } else {
        await updateArticleCall({ ...articleDataRef.current, articleId: articleIdRef.current }, { ...itemArticleRef.current, articleId: articleIdRef.current });
        setSaveState('saved');
        articleId = articleIdRef.current;
      }
      deleteBackup();
      return articleId;
    } catch (e) {
      setSaveState('error');
      setArticleBackup({
        ...articleDataRef.current,
        rolePermissions: itemArticleRef.current.rolePermissions || [],
        updatedAt: dayjs().toISOString()
      });
      showSnackbar({ type: 'warning', text: 'Failed to save article' });
      throw e;
    }
  }, [createArticleCall, deleteBackup, itemArticleRef, setArticleBackup, setArticleId, showSnackbar, updateArticleCall]);

  const delayDebounceSaveArticle = useCallback((timeout: number = 15000) => {
    if (!!delayedSaveTimeoutRef.current) {
      clearTimeout(delayedSaveTimeoutRef.current);
      delayedSaveTimeoutRef.current = null;
    }
    if (saveState !== 'deleting') {
      delayedSaveTimeoutRef.current = setTimeout(async () => {
        try {
          await saveArticle();
        } catch (e) {
          showSnackbar({ type: 'warning', text: 'Failed to auto-save, retrying in 10 seconds...', durationSeconds: 8 });
          delayDebounceSaveArticle(10000);
        }
      }, timeout);
    }
  }, [saveArticle, saveState !== 'deleting', showSnackbar]);

  const setTitle = useCallback((value: string) => {
    setSaveState('init');
    _setTitle(value);
    const articleData = articleDataRef.current;
    articleData.title = value;
    if (saveState !== 'deleting') {
      delayDebounceSaveArticle();
    }
  }, [delayDebounceSaveArticle, saveState !== 'deleting']);

  const setTags = useCallback((value: string[]) => {
    setSaveState('init');
    _setTags(value);
    const articleData = articleDataRef.current;
    articleData.tags = value;
    if (saveState !== 'deleting') {
      delayDebounceSaveArticle();
    }
  }, [delayDebounceSaveArticle, saveState !== 'deleting']);

  const setContentText = useCallback((value: Descendant[]) => {
    setSaveState('init');
    // Do not update initial text content
    const articleData = articleDataRef.current;
    // TODO: Maybe don't do this every change if it's too costly
    articleData.content = {
      version: '2',
      content: convertToContentFormat(value) as Models.BaseArticle.ContentElementV2[]
    };
    if (saveState !== 'deleting') {
      delayDebounceSaveArticle();
    }
  }, [delayDebounceSaveArticle, saveState !== 'deleting']);

  const setRolePermissions = useCallback((rolePermissions: Models.Community.CommunityArticlePermission[]) => {
    setSaveState('init');
    const communityArticleData = itemArticleRef.current;
    communityArticleData.rolePermissions = rolePermissions
    if (saveState !== 'deleting') {
      delayDebounceSaveArticle();
    }
  }, [delayDebounceSaveArticle, saveState !== 'deleting']);

  const saveDelayedArticleImmediately = useCallback(async () => {
    if (!!delayedSaveTimeoutRef.current) {
      // finish delayed article saving
      clearTimeout(delayedSaveTimeoutRef.current);
      delayedSaveTimeoutRef.current = null;
      const createdArticleId = await saveArticle();
      showSnackbar({ type: 'info', text: 'Saved successfully' });
      return createdArticleId || articleIdRef.current;
    } else {
      showSnackbar({ type: 'info', text: 'Saved successfully' });
      return articleIdRef.current;
    }
  }, [saveArticle, showSnackbar]);

  const publishArticle = useCallback(async () => {
    const articleId = await saveDelayedArticleImmediately();
    const published = new Date().toISOString();
    itemArticleRef.current.published = published;
    await updateArticleCall(
      { ...articleDataRef.current, articleId },
      { ...itemArticleRef.current, articleId }
    );
    setSaveState('published');
    setIsSendPostAsEmailModalOpen(true);
  }, [itemArticleRef, saveDelayedArticleImmediately, updateArticleCall]);

  const unpublishArticle = useCallback(async () => {
    const articleId = await saveDelayedArticleImmediately();
    itemArticleRef.current.published = null;
    await updateArticleCall(
      { ...articleDataRef.current, articleId },
      { ...(itemArticleRef.current), articleId }
    );
    setSaveState('unpublished');
  }, [itemArticleRef, saveDelayedArticleImmediately, updateArticleCall]);

  const scheduleArticle = useCallback(async (scheduleDate: dayjs.Dayjs | null, markAsNewsletter: boolean) => {
    const articleId = await saveDelayedArticleImmediately();
    const published = scheduleDate?.toISOString() || null;
    itemArticleRef.current.published = published;
    await updateArticleCall(
      { ...articleDataRef.current, articleId },
      { ...(itemArticleRef.current), articleId }
    );

    if (markAsNewsletter) {
      sendItemAsNewsletter?.(articleId);
      setIsSendPostAsEmailModalOpen(false);
    }

    // setIsSendPostAsEmailModalOpen(true);
  }, [itemArticleRef, saveDelayedArticleImmediately, sendItemAsNewsletter, updateArticleCall]);

  const clearView = useCallback(() => {
    setSaveState('init');
    _setTitle('');
    _setTags([]);
    editFieldRef.current?.setCurrentValue([]);
    setImageId('');
    articleDataRef.current = { ...emptyArticle };
    articleIdRef.current = '';
  }, []);

  const removeArticle = useCallback(async (): Promise<void> => {
    const articleId = articleIdRef.current;
    if (!!delayedSaveTimeoutRef.current) {
      // break delayed article saving
      clearTimeout(delayedSaveTimeoutRef.current);
      delayedSaveTimeoutRef.current = null;
    }
    if (!articleId) {
      // nothing to delete
      clearView();
      setSaveState('deleted');
    } else {
      setSaveState('deleting');
      await removeArticleCall?.(articleId);
      clearView();
      setSaveState('deleted');
    }
    goBack();
  }, [clearView, goBack, removeArticleCall]);

  const handleImageChange = async (file?: File) => {
    if (file) {
      let imageId: API.Files.UploadResponse<'articleImage'>;
      try {
        imageId = await fileApi.uploadImage({ type: 'articleImage' }, file);
      } catch (err) {
        // `ImageUploadField` calls this without awaiting, so an uncaught
        // rejection here would be invisible to the user.
        showSnackbar({ type: 'warning', text: imageUploadErrorText(err, 'Could not upload the image') });
        return;
      }
      if (!!imageId) {
        try {
          articleDataRef.current.headerImageId = imageId.largeImageId;
          articleDataRef.current.thumbnailImageId = imageId.imageId;
          setImageId(imageId.largeImageId);
          delayDebounceSaveArticle();
        } catch (err) {
          console.error(err);
        }
      }
    }
  }

  const handleImageRemove = () => {
    setImageId('');
    articleDataRef.current.headerImageId = '';
    articleDataRef.current.thumbnailImageId = '';
    delayDebounceSaveArticle();
  }

  const onRestoreBackup = useCallback(() => {
    if (articleBackup) {
      const articleContent = convertContentV1toV2(articleBackup.content);
      articleDataRef.current.headerImageId = articleBackup.headerImageId;
      articleDataRef.current.thumbnailImageId = articleBackup.thumbnailImageId;

      setImageId(articleBackup.headerImageId);
      setTitle(articleBackup.title);
      setTags(articleBackup.tags);
      setTimeout(() => {
        if (articleContent.length > 0) {
          editFieldRef.current?.setCurrentValue(convertToFieldFormat(articleContent));
        }
      }, 1);
      setContentText(convertToFieldFormat(articleContent));
      setRolePermissions(articleBackup.rolePermissions);
    }
  }, [articleBackup, setContentText, setRolePermissions, setTitle, setTags]);

  useEffect(() => {
    // If articleId exists and doesn't match existing id or url
    if (
      articleId &&
      articleIdRef.current !== articleId &&
      itemArticleRef.current.url !== articleId
    ) {
      const loadArticle = async () => {
        const result = await loadItem(articleId);
        const articleContent = convertContentV1toV2(result.article.content);

        articleIdRef.current = result.article.articleId;
        articleDataRef.current = { ...result.article };
        itemArticleRef.current = { ...result.itemArticle };
        updatedAtRef.current = result.itemArticle.updatedAt;
        setImageId(result.article.headerImageId);
        setTitle(result.article.title);
        setTags(result.article.tags);
        // Add slight delay to fix some rendering issues
        setTimeout(() => {
          if (articleContent.length > 0) {
            editFieldRef.current?.setCurrentValue(convertToFieldFormat(articleContent));
          }
        }, 1);
        setContentText(convertToFieldFormat(articleContent));
        if (!!result.itemArticle.rolePermissions) {
          setRolePermissions(result.itemArticle.rolePermissions);
        }
      }
      loadArticle();
    }
  }, [setTitle, setTags, setContentText, setRolePermissions, articleId, itemArticleRef, loadItem]);

  useEffect(() => {
    return () => {
      if (!!delayedSaveTimeoutRef.current) {
        clearTimeout(delayedSaveTimeoutRef.current);
        delayedSaveTimeoutRef.current = null;
        saveArticle();
      }
    }
  }, [saveArticle]);

  const showBannerDiv =
    isCurrentlyScheduled ||
    markedAsNewsletter ||
    (!hideNewsletterBanner && !markedAsNewsletter);

  return <div className="article-management">
    <ArticleManagementToolbar
      key={articleIdRef.current || 'new'}
      articleDataRef={articleDataRef}
      itemArticleRef={itemArticleRef}
      publishArticle={publishArticle}
      removeArticle={removeArticle}
      goBack={goBack}
      saveState={saveState}
      setRolePermissions={setRolePermissions}
      unpublishArticle={unpublishArticle}
      scheduleArticle={scheduleArticle}
      sentAsNewsletter={!!sentAsNewsletter}
    />
    <div className="article-management-container">
      <Scrollable innerClassName="article-management-inner" positionCallback={positionCallback}>
        {showBannerDiv && <div className="grid grid-flow-row gap-2 article-management-banners cg-text-main pb-4">
          {commContext.state === 'loaded' && commContext.community.enablePersonalNewsletter && !hideNewsletterBanner && isPublished && !markedAsNewsletter && <div className="cg-content-stack cg-border-xxl grid grid-flow-row p-4 gap-4 relative">
            <Button
              className="absolute top-2 right-2"
              onClick={() => setHideNewsletterBanner(true)}
              iconLeft={<XMarkIcon className="w-6 h-6" />}
              role="secondary"
            />
            <span className="cg-text-lg-500">Send as Newsletter</span>
            <div className="grid grid-flow-row gap-2">
              <span className="cg-text-md-400 cg-text-secondary">Increase the reach of this post by sending it as an email. It will be sent to Roles to the visibility setting of the post.</span>
              <div className='flex flex-wrap gap-0.5'>
                {relevantRolesForNewsletter.map(rr => <div className='py-0.5 px-2 cg-circular cg-bg-subtle cg-text-sm-400' key={rr}>
                  {rr}
                </div>)}
              </div>
            </div>
            <Tag
              variant='info'
              label={canSendNewsletter ? 'You can only send 1 newsletter per week' : `You can send your next newsletter in ${nextSendDate}`}
              largeFont
            />
            <Button
              className="w-full"
              role="secondary"
              text='Send as Newsletter'
              onClick={async () => {
                sendItemAsNewsletter?.(articleIdRef.current);
                setIsSendPostAsEmailModalOpen(false);
                setHideNewsletterBanner(true);
              }}
              disabled={!canSendNewsletter}
            />
          </div>}

          {isCurrentlyScheduled && <Tag
            className="w-full"
            iconLeft={<Clock weight="duotone" className="w-5 h-5" />}
            variant="info"
            label={`This post is scheduled to be published on ${formatDateForInfoTags(dayjs(itemArticleRef.current.published))}`}
          />}

          {!!sentAsNewsletter && <Tag
            className="w-full"
            iconLeft={<Clock weight="duotone" className="w-5 h-5" />}
            variant="info"
            label={`This post was sent in a Newsletter on ${formatDateForInfoTags(dayjs(sentAsNewsletter))}.`}
          />}

          {markedAsNewsletter && !sentAsNewsletter && <Tag
            className="w-full"
            iconLeft={<Clock weight="duotone" className="w-5 h-5" />}
            variant="info"
            label={'This post is being processed to be sent in a Newsletter.'}
          />}
        </div>}
        <HeaderImageUpload
          imageURL={imageUrl}
          onChange={handleImageChange}
          onRemove={handleImageRemove}
          showGuidelines
        />
        <div className="article-input-dialog">
          <TextAreaField
            value={title}
            onChange={setTitle}
            placeholder={`Title`}
            labelClassName="title-label"
            inputClassName="title-input"
            maxLetters={100}
            rows={title.length > 60 ? 3 : 2}
            autoGrow
            tabIndex={1}
            onKeyPress={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                editFieldRef.current?.focus();
              }
            }}
          />
          <div className="cg-bg-subtle p-4 cg-border-xl">
            <TagInputField
              tags={tags}
              onTagsChange={setTags}
              placeholder={"Add tags like Sports, Games, Music, Business"}
            // subLabel="Select up to 4 tags to represent your community"
            />
          </div>
          <EditFieldThree
            ref={editFieldRef}
            overrideClassName="content-input"
            placeholder={`Write something...`}
            overridePlaceholderClassName="message-field-placeholder"
            onChange={setContentText}
            richTextMode
            tabIndex={1}
          />
        </div>
      </Scrollable>
    </div>
    <ArticleBackupModal
      updatedAt={updatedAtRef.current}
      articleBackup={articleBackup}
      articleId={props.articleId}
      onRestoreBackup={onRestoreBackup}
    />
    <PostPublishedModal
      isOpen={isSendPostAsEmailModalOpen}
      onClose={() => setIsSendPostAsEmailModalOpen(false)}
      onSendNewsletter={async () => sendItemAsNewsletter?.(articleIdRef.current)}
      roles={itemArticleRef.current.rolePermissions || []}
      sentAsNewsletter={markedAsNewsletter || false}
    />
  </div>
}

export default GenericArticleManagement;