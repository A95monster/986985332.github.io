#!/usr/bin/env node
import { startUiServer, getUiUrl } from "./ui-server.js";

const port = Number(process.env.CURSOR_SSH_MCP_UI_PORT || 3847);

startUiServer(port)
  .then((info) => {
    console.log(`SSH UI listening on ${info.url}`);
    if (info.alreadyRunning) {
      console.log("(already running)");
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
