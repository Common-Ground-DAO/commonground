// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Route, Routes } from "react-router-dom";

import SpinnerIcon from '../../components/atoms/icons/16/Spinner.svg?react';

import config from "common/config";
import { useSafeProfileContext } from "context/ProfileProvider";
import ProfileView from "views/ProfileView/ProfileView";
import BlogView from "views/BlogView/BlogView";
import EditBlogView from "views/EditBlogView/EditBlogView";

type Props = {

}

export default function ProfileRouter(props: Props) {
  const safeCtx = useSafeProfileContext();

  if (safeCtx.state === "loading") {
    return (
      <div className="content-full global-caption group-caption">
        <div className='flex justify-center w-full pt-12'>
          <div className='spinner'>
            <SpinnerIcon />
          </div>
        </div>
      </div>
    );
  } else if (safeCtx.state === "loaded") {
    return (
      <Routes>
        <Route path={`${config.URL_ARTICLE}/:articleUri/edit`} element={<EditBlogView />} />
        <Route path={`${config.URL_ARTICLE}/:articleUri`} element={<BlogView />} />
        <Route path='*' element={<ProfileView />} />
      </Routes>
    )
  } else {
    console.error("Unknown state", safeCtx);
    throw new Error("Unknown state");
  }
}