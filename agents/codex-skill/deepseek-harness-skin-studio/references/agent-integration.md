# Generic local Agent integration

The portable integration surface is the STDIO MCP server. Configure the Agent
to launch Node.js with this entrypoint inside the installed Skill:

`<skill-root>/runtime/node_modules/@dsh-skin/mcp-server/dist/index.js`

Set `DSH_SKIN_CONTROLLER_ENTRY` to the bundled Controller `dist/index.js` and
`DSH_SKIN_PLUGIN_SOURCE` to the bundled `runtime/plugin` directory. Each
must be a canonical absolute path. Set `DSH_SKIN_URL` only when an explicit
Controller URL is required; otherwise the client uses the verified local
discovery record. The MCP process may start the Controller, but it cannot mint
browser confirmations or declare a pending restart successful.

All Agents share one DesignSession. Every edit must use `baseRevision` and a
stable `patchId`; on conflict, reload and reconcile. Applying and restoring are
visible-Studio operations. Agents can request a plan and observe an operation,
but the human confirmation capability never crosses the browser boundary.
