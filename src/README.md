# src

This directory is reserved for future frontend/module extraction.

The current production app intentionally keeps the static entry files in the project root:

- `index.html`
- `styles.css`
- `app.js`

Do not move them into `src/` until a real build step or migration plan is introduced, because Cloudflare Pages currently serves the root static structure directly.
