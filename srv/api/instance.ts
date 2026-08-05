// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import { buildInstanceConfig } from "../util/instanceConfig";

const instanceRouter = express.Router();

// The instance's public identity (the same object the web app receives as
// window.__CG_INSTANCE__ via HTML injection), served as plain JSON for
// clients that never load index.html: native apps, bots, the reference SDK.
// The web keeps the injection as its fast path. Public and unauthenticated —
// it is the first thing a client calls, before any account exists. Shape:
// InstanceConfig in src/common/instance.ts.
instanceRouter.get("/config", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json(buildInstanceConfig());
});

export default instanceRouter;
