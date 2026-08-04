// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import Button, { ButtonRole } from '../../../components/atoms/Button/Button';
import urlConfig from '../../../data/util/urls';

import { LinkIcon } from '@heroicons/react/20/solid';

import './ShareButton.css';
import { useSnackbarContext } from 'context/SnackbarContext';
import ListItem from '../ListItem/ListItem';

type Props = {
  buttonText: string;
  contentTitle: string;
  contentText: string;
  relativeUrl: string;

  role?: ButtonRole;
  iconLeft?: React.JSX.Element;
  className?: string;
  shareLinkOnly?: boolean;
}

const ShareButton: React.FC<Props> = (props) => {
  const { buttonText, contentTitle, contentText, relativeUrl, shareLinkOnly } = props;
  const { showSnackbar } = useSnackbarContext();
  const canShare = !!(navigator as any).share;
  const shareableUrl = `${urlConfig.APP_URL}${relativeUrl}`;

  const onClickShare = React.useCallback(() => {
    // if (canShare) {
    //   const shareData = {
    //     title: contentTitle,
    //     text: `${contentText}!`,
    //     url: shareableUrl,
    //   }

    //   navigator.share(shareData);
    // } else {
    //   if (shareLinkOnly) {
    //     navigator.clipboard.writeText(shareableUrl);
    //   }
    //   else {
    //     navigator.clipboard.writeText(`${contentText}: ${shareableUrl}`);
    //   }
    //   showSnackbar({type: 'info', text: 'Link copied to clipboard'});
    // }

    navigator.clipboard.writeText(shareableUrl);
    showSnackbar({type: 'info', text: 'Link copied to clipboard'});
  }, [shareableUrl, showSnackbar]);

  const btnClassname = `${props.className || ''}`;
  return <Button className={btnClassname} role={props.role} iconLeft={props.iconLeft || <LinkIcon className='w-5 h-5' />} text={buttonText} onClick={onClickShare} />
}

type ShareListItemProps = {
  title: string;
  contentTitle: string;
  contentText: string;
  relativeUrl: string;
  onClick?: () => void;
  icon?: React.JSX.Element | null;
}

export const ShareListItem: React.FC<ShareListItemProps> = React.memo((props) => {
  const { title, relativeUrl, onClick, icon } = props;
  const { showSnackbar } = useSnackbarContext();
  const shareableUrl = `${urlConfig.APP_URL}${relativeUrl}`;

  const onClickShare = React.useCallback(() => {
    navigator.clipboard.writeText(shareableUrl);
    showSnackbar({type: 'info', text: 'Link copied to clipboard'});
    onClick?.();
  }, [onClick, shareableUrl, showSnackbar]);

  return <ListItem title={title} onClick={onClickShare} iconRight={icon} className='font-medium' />
});

export default React.memo(ShareButton);