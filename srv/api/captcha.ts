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

export default captchaRouter;
