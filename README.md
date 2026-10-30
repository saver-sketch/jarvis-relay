# jarvis-relay

Tiny reverse tunnel for a personal assistant that runs on a Mac. The Mac dials out to `/agent`
over a WebSocket; a phone hits this service over HTTPS with a secret token (`?k=…`) and every
request is forwarded to the Mac. No storage, no accounts. Env: `RELAY_TOKEN` (≥ 24 chars).
