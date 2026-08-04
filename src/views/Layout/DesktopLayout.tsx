// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { PropsWithChildren, useMemo } from "react";
// import Menu from "../../components/organisms/Menu/Menu";
import ExpandedMenu from "components/organisms/Menu/ExpandedMenu/ExpandedMenu";
import Scrollable from "../../components/molecules/Scrollable/Scrollable";
import UserOnboarding from '../../components/organisms/UserOnboarding/UserOnboarding';
import './DesktopLayout.css';
import config from "common/config";
import { useLocation } from "react-router-dom";

type Props = {
  useScrollbar?: boolean;
  scrollbarInnerId?: string;
}

export default function DesktopLayout(props: PropsWithChildren<Props>) {
  const location = useLocation();

  const isMenuExpanded = useMemo(() => {
    const collapsedRoutes = [config.URL_COMMUNITY, 'create-blog'];
    return !collapsedRoutes.some(route => location.pathname.split('/').includes(route))
  }, [location.pathname]);

  const className = [
    'layout desktop-layout',
    isMenuExpanded ? '' : 'menu-collapsed'
  ].join(' ').trim();

  let content: React.JSX.Element = (
    <div className="content">
      {props.children}
    </div>
  );
  if (props.useScrollbar) {
    content = (
      <Scrollable
        hideOnNoScroll={true}
        hideOnNoScrollDelay={600}
        innerId={props.scrollbarInnerId}
      >
        <div className="content">
          {props.children}
        </div>
      </Scrollable>
    )
  }
  return (
    <>
      <div className="background"/>
      <div className={className}>
        {content}
        {/* <Menu /> */}
        <ExpandedMenu expanded={isMenuExpanded} />
        <UserOnboarding />
      </div>
    </>
  );
}