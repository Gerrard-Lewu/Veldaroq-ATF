# Veldaroq — sourced starter farm plan

A small South African grower can face a confusing mix of local planting advice, uncertain costs and supplier listings. Veldaroq turns a few plot details into one practical, search-grounded plan for spinach, cabbage or tomatoes—with source links and budget estimates clearly identified.

## What’s here

- `index.html`, `styles.css`, `app.js`, `config.js`: static, responsive GitHub Pages frontend.
- `worker/src/index.js`: Cloudflare Worker API calling Gemini with Google Search grounding.
- No account system, database, saved plans, file uploads, shopping or purchase flow.

## Deploy the frontend

1. In GitHub, open **Settings → Pages** and publish the `main` branch from the repository root.
2. The project site origin is `https://gerrard-lewu.github.io` (the site path includes `/Veldaroq-ATF`). Set the exact origin in the Worker’s `ALLOWED_ORIGIN` variable if your Pages URL differs.
3. Set `apiUrl` in `config.js` to the deployed Worker endpoint, for example `https://veldaroq-farm-plan.<your-subdomain>.workers.dev/`. This URL is public; do not put secrets in this file.

## Configure and deploy the Worker

1. Install Node.js and Wrangler, then authenticate with your Cloudflare account: `npm install --global wrangler` and `wrangler login`.
2. From the repository root, store the Gemini API key as an encrypted Worker secret: `wrangler secret put GEMINI_API_KEY`. Paste the key only into Wrangler’s interactive prompt. Never commit it, put it in `config.js`, or log it.
3. In `wrangler.toml`, set `ALLOWED_ORIGIN` to the exact origin serving the frontend—scheme and host, no path. CORS is not an abuse-prevention mechanism; the Worker also rate-limits requests.
4. Configure the `LIMIT` Cloudflare Workers Rate Limiting binding for your account. The sample `[[unsafe.bindings]]` declaration uses a placeholder namespace ID; follow the current Cloudflare dashboard/Wrangler instructions to create and bind a namespace, replacing `1001` as needed. Do not rely on the in-memory fallback for production: it is per Worker isolate and is only a development safety net.
5. Deploy from the repository root: `wrangler deploy`.
6. Put the resulting HTTPS Worker URL in `config.js`, commit, and push. Check the browser network panel for a successful preflight and POST; the Worker URL must be HTTPS.

Gemini uses the `gemini-2.5-flash` model and the `google_search` grounding tool. The API key is sent to Google from the Worker only. Requests are not persisted by this application; infrastructure providers may process them under their own terms. Set up Cloudflare analytics/alerts and provider spending limits before a public demo.

## Local development

- Open the static frontend through a local HTTP server (for example `python -m http.server 8000`) and set `config.js` to your deployed Worker URL. Update `ALLOWED_ORIGIN` to the exact local origin such as `http://localhost:8000` for local testing, then restore the production origin before deploying.
- Run the Worker locally with Wrangler after configuring its local secret (`wrangler secret put GEMINI_API_KEY`); ensure the frontend origin and Worker origin settings match. Never use a real API key in frontend code.
- The Worker accepts only the listed South African provinces, three crops, bounded text and positive area/budget. It requires Gemini Google Search grounding references before returning a plan.

## Limitations and responsible use

Plans are general guidance, not agricultural advice, soil analysis or guarantees of suitability or yield. Soil remains unknown. Weather, planting windows, supplier stock and prices change. Search results can be incomplete or inaccurate: independently verify recommendations, supplier listings, prices, quantities and budget arithmetic before spending. Missing prices must remain unknown; estimates are labelled. The app does not buy anything or save farm details.

The Worker restricts browser-origin requests, validates input on the server, caps request/output sizes, avoids logging farm details, and enforces a rate limit. Origin checks are not authentication and can be bypassed by non-browser clients; keep provider quotas and rate limits enabled.

## Token-efficiency notes

1. Kept the first journey narrow: one form, one grounded response, one edit-and-regenerate loop.
2. Sent only the validated farm details and a scoped instruction set, with a bounded response size.
3. Used one provider integration and rendered the response safely without extra model calls.

## Competition checkpoint

Runtime AI/search was approved before implementation; provider token-counting details should still be confirmed with organisers if they affect the submission. Record the required Copilot usage screenshot, submission confirmation and demo separately.
