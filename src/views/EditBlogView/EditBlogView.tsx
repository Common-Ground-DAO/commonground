// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./EditBlogView.css";
import { useNavigate, useParams } from "react-router-dom";
import { useWindowSizeContext } from "../../context/WindowSizeProvider";
import BlogManagement from "../../components/organisms/BlogManagement/BlogManagement";
import Scrollable from "../../components/molecules/Scrollable/Scrollable";
import { useLoadedProfileContext } from 'context/ProfileProvider';
import { getUrl } from "common/util";
import { shortUuidRegex } from "views/ArticleView/ArticleView";
import { createTranslator } from "short-uuid";
import UserProfileDetails from "components/organisms/UserProfileDetails/UserProfileDetails";

const t = createTranslator();

export default function EditBlogView() {
    const navigate = useNavigate();
    const { articleUri } = useParams<'articleUri'>();
    const articleIdShort = articleUri?.match(shortUuidRegex)?.[1];
    if (!articleIdShort) {
        throw new Error("Article uri invalid");
    }
    
    const articleId = t.toUUID(articleIdShort);
    const { isMobile } = useWindowSizeContext();
    const { isSelf, user } = useLoadedProfileContext();

    if (!isSelf) {
        navigate(getUrl ({ type: 'user', user }), { replace: true });
    }

    const maincontent = !!articleId ? (
        <div className="edit-blog-view-inner">
            <BlogManagement articleId={articleId} />
        </div>
    ) : null;

    if (isMobile) {
        return (
            <div className="edit-blog-view">
                <Scrollable>
                    {maincontent}
                </Scrollable>
            </div>
        );
    } else {
        return (
            <div className="edit-blog-view">
                {maincontent}
            </div>
        );
    }
}