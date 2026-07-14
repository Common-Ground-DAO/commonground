// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import Markdown from 'react-markdown';
import './MarkdownContent.css';

import SimpleLink from '../../../components/atoms/SimpleLink/SimpleLink';

/**
 * Joins the plain-text lines of a message into a single markdown source
 * string. Single line breaks are turned into markdown hard breaks (trailing
 * double space) so chat line breaks survive rendering — except inside fenced
 * code blocks, where added trailing whitespace would alter the code.
 */
export function toMarkdownSource(lines: string[]): string {
  let insideFence = false;
  return lines.map((line, index) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      insideFence = !insideFence;
      return line;
    }
    if (insideFence || line.trim() === '' || index === lines.length - 1) {
      return line;
    }
    return line + '  ';
  }).join('\n');
}

const MarkdownLink: React.FC<{ href?: string; children?: React.ReactNode }> = ({ href, children }) => {
  if (!href) return <>{children}</>;
  return <SimpleLink inlineLink className="text-link" href={href}>{children}</SimpleLink>;
};

const MarkdownContent: React.FC<{ source: string }> = ({ source }) => {
  return (
    <div className="message-markdown">
      <Markdown
        // Remote inline images would leak reader IPs to arbitrary hosts;
        // unwrapping renders their alt text instead. Image attachments are
        // the supported way to share images.
        disallowedElements={['img']}
        unwrapDisallowed
        components={{
          a: MarkdownLink,
        }}
      >
        {source}
      </Markdown>
    </div>
  );
};

export default React.memo(MarkdownContent);
