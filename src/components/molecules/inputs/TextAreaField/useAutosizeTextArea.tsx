// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useEffect, useRef } from "react";

// Updates the height of a <textarea> when the value changes.
const useAutosizeTextArea = (
  textAreaRef: React.RefObject<HTMLTextAreaElement | null> | null,
  value: string
) => {
  const textArea = textAreaRef?.current;
  const initialized = useRef(false);

  const resetHeight = useCallback((textAreaRef: HTMLTextAreaElement) => {
    // We need to reset the height momentarily to get the correct scrollHeight for the textarea
    textAreaRef.style.height = "0px";
    const scrollHeight = textAreaRef.scrollHeight;

    // We then set the height directly, outside of the render loop
    // Trying to set this with state or a ref will product an incorrect value.
    textAreaRef.style.height = scrollHeight + "px";
  }, []);

  // First adaptation to value
  if (!initialized.current) {
    setTimeout(() => {
      const textArea = textAreaRef?.current;
      if (textArea) {
        resetHeight(textArea);
        initialized.current = true;
      }
    }, 10);
  }

  useEffect(() => {
    if (textArea) {
      resetHeight(textArea);
    }
  }, [resetHeight, textArea, value]);
};

export default useAutosizeTextArea;
