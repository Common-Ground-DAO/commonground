// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import { CAPTCHA_PROVIDER, createCaptchaChallenge } from "../util/captcha";

const captchaRouter = express.Router();

// Serves a fresh ALTCHA proof-of-work challenge. The ALTCHA widget fetches this
// URL directly and expects the raw challenge JSON (not the {status, data}
// envelope used by the POST API), so this is a plain GET route.
captchaRouter.get("/challenge", async (request, response) => {
  if (CAPTCHA_PROVIDER !== "altcha") {
    response.status(404).json({ error: "captcha_not_altcha" });
    return;
  }
  try {
    const challenge = await createCaptchaChallenge();
    response.setHeader("Cache-Control", "no-store");
    response.json(challenge);
  } catch (e) {
    console.error("Failed to create ALTCHA challenge", e);
    response.status(500).json({ error: "challenge_failed" });
  }
});

// The effective provider, so the frontend can render the widget the backend
// actually verifies against instead of guessing from serve-time config (which
// used to drift apart when only one of site key / secret key was configured).
// Public and always available — it is needed before an account exists, and for
// every provider (unlike /challenge, which is ALTCHA-only).
captchaRouter.get("/config", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ provider: CAPTCHA_PROVIDER });
});

export default captchaRouter;
