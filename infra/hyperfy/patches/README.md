# Hyperfy patches

Patches applied on top of the pinned Hyperfy release when building VLM's Hyperfy world image.

- `0001-script-websockets.patch`: opt-in `WebSocket` for app scripts, limited to the origins in
  `PUBLIC_SCRIPT_WEBSOCKET_ORIGINS` (unset = no WebSocket, stock behaviour). Scripts get a small wrapper, and an
  app's sockets close when it is torn down. Made against hyperfy-xyz/hyperfy main (0.16.0, Dec 2025). Tested end to end
  in a running world (server and browser). Hyperfy's maintainer is open to a clean upstream PR; until it lands, the
  world image applies this patch.
