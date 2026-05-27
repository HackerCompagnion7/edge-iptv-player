# EDGE v4.0 - Premium IPTV Web Player

A premium, full-stack HD IPTV web application with a responsive React user interface and a robust Node.js Express streaming backend.

## Features
- **Modern React App**: Gorgeous, high-performance UI using Tailwind CSS and `motion` for beautiful layout transitions.
- **Node.js Express Backend**: High-powered server handling streaming proxy bypasses, DNS-over-HTTPS (DoH) resolution overrides, and caching.
- **Robust Player Integration**: Integrated HLS.js video player with interactive canvas-based live preview frames, fallback streaming proxy, and play/pause visual overlays.
- **Comprehensive EPG/Channel Guide**: Detailed channel lists categorized into Sports, Movies, Kids, news, etc., mapped dynamically.

## Structure
- `server.ts` — High-performance Express server & stream-proxy engine.
- `src/App.tsx` — Main React application containing the modern player interface.
- `src/channels.json` — Static channel playlist mapping.
- `vite.config.ts` — Vite bundling and CSS compiling configuration.

