// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from "react";

import CheckmarkIcon from '../../atoms/icons/16/Checkmark.svg?react';
import "./InlineToast.css";
import { Spinner } from "@phosphor-icons/react";

export type InlineToastType = 'loading' | 'done';

type InlineToastProps = {
  type?: InlineToastType;
  successText?: string;
  textAreaToast?: boolean;
  noAbsolute?: boolean;
};

// const DEFAULT_DISTANCE_FROM_TOP = -24; // show right to label for huge textareas to prevent overlapping text
const DEFAULT_DISTANCE_FROM_TOP = 10; // was changed to 10 to show inside textareas at top right, instead of at the right side of label. See https://dev.azure.com/cryptogram/cryptogram/_workitems/edit/693
const MAX_HEIGHT_OF_SINGLE_ROW_INPUT = 24;

const InlineToast: React.FC<InlineToastProps> = ({ type, successText, textAreaToast, noAbsolute }) => {
  const spanRef = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    const current = spanRef.current;
    if (!current || !textAreaToast) return;

    const distanceFromTop = DEFAULT_DISTANCE_FROM_TOP;
    current.style.top = `${distanceFromTop}px`;
  }, [textAreaToast]);

  if (!type) return null;
  const generateContent = () => {
    if (type === 'loading') {
      return <Spinner className="spinner" />;
    } else {
      return (
        <div className="flex items-center gap-1">
          {successText && <div className="text-xs">
            {successText}
          </div>}
          <CheckmarkIcon className="input-toast-success" />
        </div>
      );
    }
  }

  return <span ref={spanRef} className={`input-toast py-1 ${noAbsolute ? '' : 'absolute'}`}>{generateContent()}</span>;
}

export default React.memo(InlineToast);