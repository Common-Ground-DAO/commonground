// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useState } from 'react'
import './SimpleLink.css';
import { useNavigate } from 'react-router-dom';
import { useExternalModalContext } from 'context/ExternalModalProvider';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import { fetchInternalLinkData } from 'components/molecules/LinkPreview/LinkPreview.helper';
import GatedDialogModal, { calculatePermissions } from 'components/organisms/GatedDialogModal/GatedDialogModal';

export function isLocalUrl(url: string) {
  if (!url) return undefined;
  const currentHost = window.location.host;
  const protocol = window.location.protocol;
  const testRegex = new RegExp(`^(?:${protocol}//)?${currentHost.replace('.', '\\.')}(/.*)?$`);
  const result = url.match(testRegex);
  if (!!result) return result[1] || "/";
}

type Props = {
  className?: string;
  href: string;
  modalContentRef?: React.RefObject<HTMLDivElement | null>;
  inlineLink?: boolean;
  skipInternalLinkProcessing?: boolean;
}

const SimpleLink: React.FC<React.PropsWithChildren<Props>> = ({ className, href, modalContentRef, children, inlineLink, skipInternalLinkProcessing }) => {
  const { showModal } = useExternalModalContext();
  const navigate = useNavigate();
  const targetLocalPath = isLocalUrl(href);
  const [showGatedDialog, setShowGatedDialog] = useState(false);
  const gatedState = useAsyncMemo(async () => {
    if (skipInternalLinkProcessing) return null;

    if (targetLocalPath) {
      const internalData = await fetchInternalLinkData(targetLocalPath);
      if (internalData?.type === 'article' && 'communityArticle' in internalData?.article) {
        return calculatePermissions(internalData.article);
      }
    }
    return null;
  }, [targetLocalPath]);

  if (!href) {
    return null;
  }

  const handleLinkClick = (e: React.MouseEvent) => {
    e.preventDefault();
    
    if (gatedState) {
      setShowGatedDialog(true);
    } else if (targetLocalPath) {
      navigate(targetLocalPath);
    } else {
      showModal(href);
    }
  }

  const linkClassName = [
    'message-link-container',
    targetLocalPath ? "message-link-container-internal" : "message-link-container-external",
    inlineLink ? "inline" : ""
  ].join(' ');

  return (
    <div className={linkClassName}>
      <a className={className} target="_blank" rel="noreferrer" href={href} onClick={handleLinkClick}>{children}</a>
      {gatedState && <GatedDialogModal
        isOpen={showGatedDialog}
        requiredPermissions={gatedState}
        onClose={(redirect) => {
          setShowGatedDialog(false);
          if (redirect && targetLocalPath) navigate(targetLocalPath);
        }}
      />}
    </div>
  );
}

export default React.memo(SimpleLink);