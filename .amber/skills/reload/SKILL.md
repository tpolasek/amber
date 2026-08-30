---
name: reload
description: Rebuild the project and restart the Amber server, detaching the launcher so it survives the old server shutting down.
allowed-tools: Bash
---

Hot-reload the Amber server: rebuild, stop the previous run, and start a fresh server.

1. Run exactly this from the repository root:

   ```
   setsid ./run.sh >/tmp/amber-restart.log 2>&1 </dev/null & disown; echo "run.sh launched detached"
   ```

2. The command returns immediately; the detached script builds, SIGINTs the server on port 3000 (escalating to SIGTERM if needed), and starts the new one.

IMPORTANT: the server being stopped hosts this agent session, so this run is terminated mid-flight when the reload lands. That is expected — do not treat it as a failure. Tell the user the reload is underway and that they may need to reconnect or reload the page; the session persists server-side and resumes from disk. Do not attempt to verify the new server from this run.
