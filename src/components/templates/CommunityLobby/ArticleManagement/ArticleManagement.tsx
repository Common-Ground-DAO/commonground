// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./ArticleManagement.css";

import { useNavigate } from "react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLoadedCommunityContext } from "../../../../context/CommunityProvider";
import { getUrl } from 'common/util';
import communityArticleManager from "data/managers/communityArticleManager";
import { PredefinedRole } from "common/enums";
import { useSnackbarContext } from "context/SnackbarContext";
import GenericArticleManagement from "components/organisms/GenericArticleManagement/GenericArticleManagement";

type Props = {
    community: Models.Community.DetailView;
    articleId?: string; // for editing existing article
}

function formatCommunityArticleForUpdate(
    data: Pick<Models.Community.CommunityArticle, "communityId" | "rolePermissions" | "url" | 'published' | 'sentAsNewsletter' | 'markAsNewsletter' | 'articleId'>
): API.Community.updateArticle.Request['communityArticle'] {
    const { sentAsNewsletter, markAsNewsletter, ...actualData } = data;
    return actualData;
}

function formatCommunityArticleForCreate(
    data: Pick<Models.Community.CommunityArticle, "communityId" | "rolePermissions" | "url" | 'published' | 'sentAsNewsletter' | 'markAsNewsletter'>
): Omit<API.Community.createArticle.Request['communityArticle'], 'articleId'> {
    const { sentAsNewsletter, markAsNewsletter, ...actualData } = data;
    return actualData;
}

export default function ArticleManagement(props: Props) {
    const { community, articleId } = props;
    const { showSnackbar } = useSnackbarContext();
    const { communityPermissions, roles } = useLoadedCommunityContext();
    const navigate = useNavigate();

    const emptyCommunityArticle: Pick<Models.Community.CommunityArticle, "communityId" | "rolePermissions" | "url" | 'published' | 'sentAsNewsletter' | 'markAsNewsletter'> = useMemo(() => {
        const publicRole = roles.find(role => role.title === PredefinedRole.Public);
        const rolePermissions: Models.Community.CommunityArticlePermission[] = [];
        if (publicRole) {
            rolePermissions.push({
                permissions: ['ARTICLE_PREVIEW', 'ARTICLE_READ'],
                roleId: publicRole.id,
                roleTitle: publicRole.title
            });
        }
        return {
            communityId: community.id,
            rolePermissions,
            url: null,
            published: null,
            sentAsNewsletter: null,
            markAsNewsletter: false,
        };
    }, [community.id, roles]);

    const communityArticleRef = useRef<typeof emptyCommunityArticle>(emptyCommunityArticle);

    const isEditor = useMemo(() => {
        return communityPermissions.has('COMMUNITY_MANAGE_ARTICLES');
    }, [communityPermissions]);

    useEffect(() => {
        if (!isEditor) {
            navigate(getUrl({ type: 'community-lobby', community }));
        }
    }, [isEditor, navigate, community]);

    const sendArticleAsEmail = useCallback(async (articleId: string) => {
        const communityId = community.id;
        if (articleId) {
            try {
                await communityArticleManager.sendArticleAsEmail({ communityId, articleId });
                communityArticleRef.current.markAsNewsletter = true;
                showSnackbar({ type: 'success', text: 'Email newsletter sent successfully' });
            } catch (e) {
                showSnackbar({ type: 'warning', text: 'Newsletter limit exceeded' });
            }
        }
    }, [community.id, showSnackbar]);

    return <GenericArticleManagement
        articleId={articleId}
        itemArticleRef={communityArticleRef}
        createArticleCall={async (_article, communityArticle) => {
            if ('communityId' in communityArticle) {
                const { channelId, commentCount, latestCommentTimestamp, ...article } = _article;
                const response = await communityArticleManager.createArticle({
                    article,
                    communityArticle: formatCommunityArticleForCreate({ ...communityArticle, rolePermissions: communityArticle.rolePermissions || [] } as Models.Community.CommunityArticle ),
                });
                return { articleId: response.communityArticle.articleId };
            }
            return { articleId: '' };
        }}
        updateArticleCall={async (_article, communityArticle) => {
            if ('communityId' in communityArticle) {
                const { channelId, commentCount, latestCommentTimestamp, ...article } = _article;
                await communityArticleManager.updateArticle({
                    article,
                    communityArticle: formatCommunityArticleForUpdate({ ...communityArticle, rolePermissions: communityArticle.rolePermissions || [] } as Models.Community.CommunityArticle),
                });
            }
        }}
        removeArticleCall={async (articleId) => {
            await communityArticleManager.deleteArticle({ communityId: communityArticleRef.current.communityId, articleId });
        }}
        loadItem={async (articleId) => {
            const result = await communityArticleManager.getArticle({
                communityId: community.id,
                articleId,
            });

            return {
                article: result.article,
                itemArticle: result.communityArticle,
            }
        }}
        goBack={() => navigate(getUrl({ type: 'community-lobby', community }))}
        markedAsNewsletter={communityArticleRef.current.markAsNewsletter}
        sentAsNewsletter={communityArticleRef.current.sentAsNewsletter || undefined}
        sendItemAsNewsletter={sendArticleAsEmail}
    />;
}
