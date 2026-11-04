# gelson.dev

Personal site of Gelson Mariano Rodrigues, Senior Frontend Engineer. Live at [gelson.dev](https://gelson.dev).

Plain semantic HTML on purpose: no framework, no JavaScript, no external fonts. The goal is a page that is accessible, fast and easy to read before any design work starts.

## Structure

- `public/index.html`: the whole site
- `public/gelson-rodrigues-resume.pdf`: resume, linked from the site
- `wrangler.jsonc`: Cloudflare Workers static assets config

## Deploy

Every push to `main` is deployed by Cloudflare Workers Builds, connected to this repository. `gelson.dev` and `www.gelson.dev` are attached as custom domains, and `gelsonrodrigues.com` redirects here.

To preview locally:

```sh
npx wrangler dev
```
