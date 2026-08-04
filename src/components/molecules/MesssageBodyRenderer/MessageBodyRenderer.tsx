// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useState } from 'react';
import './MessageBodyRenderer.css';
import emojiRegex from 'emoji-regex';

import SimpleLink, { isLocalUrl } from '../../../components/atoms/SimpleLink/SimpleLink';
import FullscreenImageModal from '../../../components/atoms/FullscreenImageModal/FullscreenImageModal';
import { useSignedUrl } from '../../../hooks/useSignedUrl';

import { linkRegexGenerator } from "../../../common/validators";
import { getDisplayNameString } from "../../../util";
import UserTooltip from "../../organisms/UserTooltip/UserTooltip";
import { useOwnUser } from 'context/OwnDataProvider';
import { useMultipleUserData } from 'context/UserDataProvider';
import MessageTimestamp from '../Message/MessageTimestamp/MessageTimestamp';
import MiniLoginBanner from '../LoginBanner/MiniLoginBanner';
import LinkPreviewLoader from '../LinkPreview/LinkPreviewLoader';
import YoutubeIframe from 'components/atoms/YoutubeIframe/YoutubeIframe';
import MarkdownContent, { toMarkdownSource } from './MarkdownContent';

type RenderableElement = Models.BaseArticle.ContentElementV2 | Models.Message.BodyContentV1 | Common.Content.ModerationSpecial;

/** Synthetic element produced by groupMarkdownRuns, never part of stored content. */
type MarkdownRun = { type: 'markdownRun'; value: string };

function isPlainText(element: RenderableElement): element is Common.Content.Text {
  if (element.type !== 'text') return false;
  const text = element as Common.Content.Text;
  return !text.bold && !text.italic && !text.className && !text.divClassname;
}

function isPlainLink(element: RenderableElement): element is Common.Content.Link {
  return element.type === 'link' && !element.bold && !element.italic;
}

function elementToMarkdown(element: RenderableElement): string {
  if (isPlainLink(element)) {
    // The composer turns bare URLs into link elements; emit them as markdown
    // links so the rest of the line keeps its markdown formatting. The
    // angle-bracket destination tolerates parentheses in URLs.
    const url = element.value.startsWith('http') ? element.value : 'https://' + element.value;
    const label = element.value.replace(/([\\[\]])/g, '\\$1');
    return `[${label}](<${url.replace(/([<>\\])/g, '\\$1')}>)`;
  }
  return (element as Common.Content.Text).value;
}

/**
 * Collapses maximal runs of lines that consist only of plain text elements
 * into single markdown elements, so their content renders as markdown.
 * Lines containing mentions, parsed links/tags/tickers, toolbar formatting
 * (bold/italic/className) or media keep the classic element rendering.
 */
function groupMarkdownRuns(content: RenderableElement[]): (RenderableElement | MarkdownRun)[] {
  type Line = { elements: RenderableElement[]; hasNewline: boolean };
  const lines: Line[] = [];
  let currentLine: RenderableElement[] = [];
  for (const element of content) {
    if (element.type === 'newline') {
      lines.push({ elements: currentLine, hasNewline: true });
      currentLine = [];
    } else {
      currentLine.push(element);
    }
  }
  lines.push({ elements: currentLine, hasNewline: false });

  const isMarkdownLine = (line: Line) => line.elements.every(element => isPlainText(element) || isPlainLink(element));

  const result: (RenderableElement | MarkdownRun)[] = [];
  const pushRaw = (line: Line) => {
    result.push(...line.elements);
    if (line.hasNewline) result.push({ type: 'newline' });
  };

  let i = 0;
  while (i < lines.length) {
    if (!isMarkdownLine(lines[i])) {
      pushRaw(lines[i]);
      i++;
      continue;
    }
    const textLines: string[] = [];
    let j = i;
    while (j < lines.length && isMarkdownLine(lines[j])) {
      textLines.push(lines[j].elements.map(elementToMarkdown).join(''));
      j++;
    }
    const source = toMarkdownSource(textLines);
    if (source.trim().length === 0) {
      // A run of only blank lines: keep the classic empty-line rendering.
      for (let k = i; k < j; k++) pushRaw(lines[k]);
    } else {
      result.push({ type: 'markdownRun', value: source });
      if (lines[j - 1].hasNewline) result.push({ type: 'newline' });
    }
    i = j;
  }
  return result;
}

const MediaImageRenderer: React.FC<Common.Content.ArticleImage> = (props) => {
  const [showModal, setShowModal] = React.useState(false);
  const imageUrl = useSignedUrl(props.imageId);

  return <div className={`media-content-image ${props.size}`}>
    <FullscreenImageModal open={showModal} images={[{ id: props.largeImageId }]} close={() => setShowModal(false)} />
    <img src={imageUrl} alt={imageUrl} onClick={() => setShowModal(true)} />
    {props.caption && <span>{props.caption}</span>}
  </div>;
};

const MediaEmbedRenderer: React.FC<Common.Content.ArticleEmbed> = (props) => {
  return <div className={`mediaEmbedVideoContainer ${props.size}`}>
    {/** Note: https://www.youtube.com is the only allowed frame-src, configured in nginx.conf */}
    {/** Also note: Iframes always need sandbox="allow-forms allow-scripts" for security reasons */}
    <YoutubeIframe
      embedId={props.embedId}
      divClassName='mediaEmbedVideo'
    />
  </div>;
};

function extractMentionedUserIds(content: (Models.BaseArticle.ContentElementV2 | Models.Message.BodyContentV1 | Common.Content.ModerationSpecial)[]) {
  return Array.from(content.reduce<Set<string>>((agg, val) => {
    if (val.type === "mention") {
      agg.add(val.userId);
    }
    else if (val.type === "special") {
      agg.add(val.userId);
    }
    return agg;
  }, new Set<string>()))
}



export function AllContentRenderer(props: {
  content: (Models.BaseArticle.ContentElementV2 | Models.Message.BodyContentV1 | Common.Content.ModerationSpecial)[];
  messageKeyBase?: string;
  messageTimestamp?: string;
  lastUpdateTimestamp?: string;
  hideTimestamp?: boolean;
  isEdited?: boolean;
  showMidwayLoginBanner?: boolean;
  renderInternalLinks?: boolean;
}) {
  const { content, messageKeyBase = '' } = props;
  const ownData = useOwnUser();
  const onlyLinkRegex = linkRegexGenerator();
  const [mentionedUserIds, setMentionedUserIds] = useState<string[]>(extractMentionedUserIds(content));

  useEffect(() => {
    const newMentionedUserIds = extractMentionedUserIds(content);
    if ( // this checks for equality
      newMentionedUserIds.length !== mentionedUserIds.length ||
      !mentionedUserIds.every((id, i) => newMentionedUserIds[i] === id)
    ) {
      setMentionedUserIds(newMentionedUserIds);
    }
  }, [content]);

  const mentionedUsers = useMultipleUserData(mentionedUserIds);

  const resultContent: React.JSX.Element[] = [];
  let currentBlock: React.JSX.Element[] = [];
  let skipNextDivEncasing = true;
  let nextClassName: string[] = [];
  let hasRenderedMidLoginBanner = false;

  let timestamp: React.JSX.Element | null = null
  if (!props.hideTimestamp) {
    timestamp = <MessageTimestamp
      key='message-timestamp'
      isEdited={props.isEdited}
      lastUpdateTimestamp={props.lastUpdateTimestamp}
      messageTimestamp={props.messageTimestamp}
    />;
  }

  // Bypass check for large emoji
  if (content.length === 1) {
    const el = content[0];

    if (el.type === 'text') {
      const regex = emojiRegex();
      const filteredText = el.value.replaceAll(regex, '');
      if (filteredText.length === 0) {

        const regexResult = el.value.match(regex);
        if (regexResult?.length === 1) {
          return <span className='font-large message-big-emoji' >{el.value}{timestamp}</span>;
        } else if (regexResult?.length === 2) {
          return <span className='font-medium message-big-emoji' >{el.value}{timestamp}</span>;
        }
      }
    }
  }

  let links: string[] = [];

  const processedContent = groupMarkdownRuns(content);

  processedContent.forEach((c, index) => {
    const messageKey = `${messageKeyBase}${c.type}-${index}`;
    let currentElement: React.JSX.Element | undefined = undefined;
    switch (c.type) {
      case 'tag':
        currentElement = (<span className="message-content-tag" key={messageKey}>#{c.value}</span>);
        break;
      case 'ticker':
        currentElement = (<span className="message-content-ticker" key={messageKey}>${c.value}</span>);
        break;
      case 'link': {
        let value = c.value;
        if (!(value.startsWith('http'))) {
          value = 'https://' + value;
        }
        if (value.match(onlyLinkRegex)) {
          links.push(value);
          currentElement = (<SimpleLink inlineLink className="text-link" href={value} key={messageKey}>{c.value}</SimpleLink>);
        } else {
          currentElement = (<span className="text-red-700" key={messageKey}>Invalid link</span>);
        }
        break;
      }
      case 'richTextLink': {
        let url = c.url;
        if (!(url.startsWith('http'))) {
          url = 'https://' + url;
        }
        if (url.match(onlyLinkRegex)) {
          links.push(url);
          currentElement = (<SimpleLink inlineLink className={"text-link" + (c.className ? " " + c.className : '')} href={url} key={messageKey}>{c.value}</SimpleLink>);
        } else {
          currentElement = (<span className={"text-red-700" + (c.className ? " " + c.className : '')} key={messageKey}>{c.value} (Invalid link)</span>);
        }
        break;
      }
      case 'header': {
        const headerElements = c.value.map((textEl, index) => {
          const internalMessageKey = 'text-' + index;
          let internalElement: string | React.JSX.Element = textEl.value;
          if (textEl.bold) {
            internalElement = <strong key={internalMessageKey}>{internalElement}</strong>;
          }

          if (textEl.italic) {
            internalElement = <em key={internalMessageKey}>{internalElement}</em>;
          }
          return internalElement;
        });

        currentElement = <h3 key={messageKey}>{headerElements}</h3>;
        skipNextDivEncasing = true;
        break;
      }
      case 'articleImage': {
        currentElement = <MediaImageRenderer key={messageKey} {...c} />;
        nextClassName.push('mediaElement');
        break;
      }
      case 'articleEmbed': {
        currentElement = <MediaEmbedRenderer key={messageKey} {...c} />;
        nextClassName.push('mediaElement');
        break;
      }
      case 'text': {
        currentElement = (<span key={messageKey} className={c.className}>{c.value}</span>);
        if (!!c.divClassname) nextClassName.push(c.divClassname);
        break;
      }
      case 'markdownRun': {
        currentElement = <MarkdownContent key={messageKey} source={c.value} />;
        skipNextDivEncasing = true;
        break;
      }
      case 'newline': {
        if (skipNextDivEncasing) {
          resultContent.push(...currentBlock);
        } else if (currentBlock.length > 0) {
          resultContent.push(<div className={nextClassName.join(' ')} key={messageKey}>{currentBlock}</div>);
        } else {
          resultContent.push(<div className={nextClassName.join(' ')} key={messageKey}><span key={messageKey + '-empty'}> </span></div>);
        }
        skipNextDivEncasing = false;
        nextClassName = [];
        currentBlock = [];

        const filteredLinks = links.filter(isLocalUrl);
        if (filteredLinks.length > 0 && props.renderInternalLinks) {
          resultContent.push(<div className='link-preview-container' key={`attached-links-${resultContent.length}`}>
            {filteredLinks.map((link, index) => {
              return <LinkPreviewLoader key={link + '_' + index} url={link} />;
            })}
          </div>);
        }

        if (props.showMidwayLoginBanner && !hasRenderedMidLoginBanner && resultContent.length > 5) {
          resultContent.push(<MiniLoginBanner key='mini-login-banner' />);
          hasRenderedMidLoginBanner = true;
        }

        links = [];
        break;
      }
      case 'mention': {
        const user = mentionedUsers?.[c.userId];
        currentElement = (
          <UserTooltip
            key={messageKey}
            triggerClassName="inline"
            placement="right"
            userId={c.userId}
            isMessageTooltip={false}
          >
            <span key={messageKey} className="message-body-mention">@{user ? getDisplayNameString(user) : c.alias || c.userId}</span>
          </UserTooltip>
        );
        break;
      }
      case 'special': {
        const user = mentionedUsers?.[c.userId];
        let alias: string = c.userId;
        if (!!ownData && c.userId === ownData.id) {
          alias = getDisplayNameString(ownData);
        } else if (user) {
          alias = getDisplayNameString(user);
        }
        
        switch (c.action) {
          case "warn": {
            let msg: string = "";
            switch (c.reason) {
              case "Behavior": {
                msg = "watch your behavior";
                break;
              }
              case "Breaking rules": {
                msg = "stop breaking the community rules";
                break;
              }
              case "Language": {
                msg = "watch your language";
                break;
              }
              case "Off-topic": {
                msg = "stay on topic";
                break;
              }
              case "Spam": {
                msg = "stop spamming";
                break;
              }
            }
            currentElement = (
              <div key={messageKey} className="message-content-warning">
                <span>
                  ⚠️ {alias}, please {msg}
                </span>
              </div>
            );
            break;
          }
          case "mute":
          case "banned": {
            currentElement = (
              <div key={messageKey} className="message-content-mute-ban">
                <span>
                  ❌️ {alias} has been {c.action === "mute" ? "muted" : "banned"} {c.duration === "permanently" ? "permanently" : `for ${c.duration}`}
                </span>
              </div>
            );
            break;
          }
        }
        break;
      }
      default: {
        currentElement = (<span className="text-red-700" key={messageKey}>Unknown content type</span>);
        break;
      }
    }

    if (currentElement) {
      if ((c as any).bold) {
        currentElement = <strong key={messageKey}>{currentElement}</strong>;
      }

      if ((c as any).italic) {
        currentElement = <em key={messageKey}>{currentElement}</em>;
      }

      currentBlock.push(currentElement);
    }
  });

  // TODO: Remove this to support outside links
  const filteredLinks = links.filter(isLocalUrl);

  if (filteredLinks.length === 0) {
    if (timestamp) {
      currentBlock.push(timestamp);
    }

    if (currentBlock.length > 0) {
      resultContent.push(<div key={`last-${content.length}`}>{currentBlock}</div>);
    }
  } else {
    if (currentBlock.length > 0) {
      resultContent.push(<div key={`last-${content.length}`}>{currentBlock}</div>);
    }

    if (filteredLinks.length > 0 && props.renderInternalLinks) {
      resultContent.push(<div className='link-preview-container' key='attached-links-end'>
        {filteredLinks.map((link, index) => {
          return <LinkPreviewLoader key={link + '_' + index} url={link} />;
        })}
      </div>);
    }

    if (timestamp) {
      resultContent.push(<div key={`last-${content.length}-timestamp`}>{timestamp}</div>);
    }
  }

  if (props.showMidwayLoginBanner && !hasRenderedMidLoginBanner) {
    resultContent.push(<MiniLoginBanner key='mini-login-banner' />);
    hasRenderedMidLoginBanner = true;
  }

  return <>{resultContent}</>;
}

const MessageBodyRenderer = (props: {
  message: Models.Message.Message,
  truncate?: boolean,
  hideTimestamp?: boolean,
}) => {
  const { message, truncate, hideTimestamp } = props;

  const className = [
    truncate ? "message-body-truncated" : "",
  ].join(" ").trim();

  return (
    <div className={className}>
      <AllContentRenderer
        content={message.body.content}
        messageKeyBase={message.id}
        messageTimestamp={message.createdAt.toString()}
        lastUpdateTimestamp={message.updatedAt.toString()}
        isEdited={message.editedAt !== null}
        hideTimestamp={hideTimestamp}
      />
      {message.sendStatus === "error-send" && <span className="text-xs text-red-500">error sending</span>}
      {message.sendStatus === "error-update" && <span className="text-xs text-red-500">error updating</span>}
    </div>
  )
}

export default React.memo(MessageBodyRenderer);