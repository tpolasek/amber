---
name: reload
description: Rebuild the project and restart the Amber systemd user service. Only run when the user explicitly requests it.
allowed-tools: Bash
---

Hot-reload the Amber server: rebuild, then restart the `amber` systemd user service.

Only run this when the user explicitly requests it (/reload, or asks to restart/reload the server). Never invoke it proactively — a reload terminates the user's active session mid-run.

1. Build first, so a failed build cannot take the running server down:

   ```
   npm run build
   ```

   If the build fails, stop and report it; the running server is untouched.

2. Restart the service detached (setsid keeps the restart alive when this session's server is torn down):

   ```
   setsid systemctl --user restart amber.service >/tmp/amber-restart.log 2>&1 </dev/null & disown; echo "restart issued"
   ```

   If the unit is not installed yet (`systemctl --user cat amber.service` fails), install it with `./install_service.sh` — or, if the user just wants the legacy flow, fall back to `nohup ./run.sh >/tmp/amber-restart.log 2>&1 </dev/null & disown`.

IMPORTANT: the server being restarted hosts this agent session, so this run is terminated mid-flight when the restart lands. That is expected — do not treat it as a failure. Tell the user the reload is underway and that they may need to reconnect or reload the page; the session persists server-side and resumes from disk. Do not attempt to verify the new server from this run. After a restart, logs are in `journalctl --user -t amber`.
