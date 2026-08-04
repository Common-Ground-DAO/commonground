// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useParams } from "react-router-dom";

import { useLoadedCommunityContext } from "../../context/CommunityProvider";
import { useWindowSizeContext } from "../../context/WindowSizeProvider";

import ArticleManagement from "../../components/templates/CommunityLobby/ArticleManagement/ArticleManagement";

import "./EditArticleView.css";
import { createTranslator } from "short-uuid";

const shortUuidRegex = /.*([a-zA-Z0-9]{22})$/;
const t = createTranslator();

type Props = {

}

export default function EditArticleView(props: Props) {
    const { articleUri } = useParams<'articleUri'>();
    const articleIdShort = articleUri?.match(shortUuidRegex)?.[1];
    if (!articleIdShort) {
        throw new Error("Article uri invalid");
    }
    const articleId = t.toUUID(articleIdShort);

    const { isMobile } = useWindowSizeContext();
    const { community, communityPermissions } = useLoadedCommunityContext();

    if (!!community) {
        return (
            <div className='edit-article-view'>
                <ArticleManagement community={community} articleId={articleId} />
            </div>
        );
    } else {
        return null;
    }
}