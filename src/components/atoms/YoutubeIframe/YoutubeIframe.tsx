// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useIsolationMode } from "context/IsolationModeProvider";
import Button from "../Button/Button";
import { YoutubeLogo } from "@phosphor-icons/react/dist/ssr";
import { useLayoutEffect, useRef } from "react";

type YoutubeIframeProps = {
    divClassName: string;
    embedId: string;
}

function supportsCredentiallessIframe() {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('credentialless', '');
    // Check if the attribute is reflected as a property
    // The property 'credentialless' on HTMLIFrameElement exists in supporting browsers
    return typeof (iframe as any).credentialless === 'boolean';
}
const supportsCredentialless = supportsCredentiallessIframe();

export default function YoutubeIframe({ embedId, divClassName }: YoutubeIframeProps) {
    const { isolationEnabled, toggleIsolationMode } = useIsolationMode();
    const iframeRef = useRef<HTMLIFrameElement>(null);

    useLayoutEffect(() => {
        const iframe = iframeRef.current;
        if (iframe) {
            if (supportsCredentialless && isolationEnabled) {
                iframe.setAttribute('credentialless', 'true');
            }
            iframe.src = `https://www.youtube.com/embed/${embedId}`;
        }
    }, [embedId, divClassName, isolationEnabled, toggleIsolationMode]);

    if (!isolationEnabled || supportsCredentialless) {
        return (
            <div className={divClassName}>
                <iframe
                    id={`embed-yt-${embedId}`}
                    ref={iframeRef}
                    title="YouTube video player"
                    frameBorder="0"
                    allowFullScreen
                    sandbox="allow-forms allow-scripts allow-same-origin"
                />
            </div>
        );
    } else {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center cg-text-main cg-bg-subtle cg-border-xl p-6">
                <div className="text-lg text-center flex items-center mb-2">
                    <YoutubeLogo weight="duotone" className="w-6 h-6" /> YouTube
                </div>
                <div className="text-sm text-center mb-4">
                    To view this video, {window.location.host} needs to switch embedding mode. Click below to switch mode and reload.
                </div>
                <Button
                    role="primary"
                    text="Switch and reload"
                    onClick={() => toggleIsolationMode()}
                />
            </div>
        );
    }
}