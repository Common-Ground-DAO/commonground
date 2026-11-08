// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Metric } from 'web-vitals';

// web-vitals renamed every getter to `on*` in v3 (`getCLS` -> `onCLS`, …) and
// dropped FID entirely in v5 — the metric was retired in favour of INP, which
// became a Core Web Vital in 2024. `ReportHandler` went away with the getters;
// the callback type is `(metric: Metric) => void`.
const reportWebVitals = (onPerfEntry?: (metric: Metric) => void) => {
  if (onPerfEntry && onPerfEntry instanceof Function) {
    import('web-vitals').then(({ onCLS, onINP, onFCP, onLCP, onTTFB }) => {
      onCLS(onPerfEntry);
      onINP(onPerfEntry);
      onFCP(onPerfEntry);
      onLCP(onPerfEntry);
      onTTFB(onPerfEntry);
    });
  }
};

export default reportWebVitals;
