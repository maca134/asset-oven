<div align="center">
  <img src="asset-oven.png" width="65" height="auto" alt="asset-oven"/>
</div>


**asset-oven** is a lazy, content-hashed asset middleware for [Bun](https://bun.com) — local asset paths written straight into server-rendered HTML just work, no bundler config, no manifest, no build step to remember to run.

```ts
import { Hono } from "hono";
import { builder } from "asset-oven/hono";

const app = new Hono();
app.use(builder({ root: import.meta.dir, publicPath: "/assets" }));

app.get("/", (c) => c.html(`<script src="/client.ts" type="module"></script>`));

export default app;
```

On the first request that renders `/client.ts`, asset-oven bundles it with `Bun.build`, content-hashes the output, rewrites the tag to `/assets/client-a1b2c3d4.js`, and serves it with a long-lived immutable cache header — all inline in the response, no separate build command.

## Quick Start

```bash
bun add asset-oven
```

Pick the adapter for your server:

```ts
// Hono
import { builder } from "asset-oven/hono";
app.use(builder({ root: import.meta.dir, publicPath: "/assets" }));
```

```ts
// plain Bun.serve
import { withAssets } from "asset-oven/bun";
const fetch = withAssets(myFetchHandler, {
	root: import.meta.dir,
	publicPath: "/assets",
});
Bun.serve({ fetch });
```

Then just reference assets by their on-disk path in your HTML — `<script src="/client.ts">`, `<link rel="stylesheet" href="/styles.css">`, `<img src="/logo.png">` — and asset-oven handles the rest.

## Features

- **Zero-config asset paths** 📝 — write `src="/client.ts"` in your JSX/HTML like it's a static file; no imports, no manifest to look up.
- **Lazy build + hash + cache** ⚡ — assets are built on first request, not ahead of time; concurrent requests for the same not-yet-built asset are deduped into a single build.
- **Nested assets just resolve** 🔗 — a JS `import` of an image or a CSS `url()` background produces its own hashed URL automatically, via `Bun.build`'s own dependency graph.
- **Real static-file serving** 📦 — Range requests, `HEAD`, and immutable long-lived caching headers, so video/audio scrubbing and CDN caching work correctly.
- **Two thin adapters** 🔌 — a Hono middleware (`asset-oven/hono`) and a plain `Bun.serve` fetch wrapper (`asset-oven/bun`), both backed by the same framework-agnostic `AssetBuilder` core.
- **Sensible defaults, fully overridable** ⚙️ — `minify`, `sourcemap`, and cache-retry timing default off `NODE_ENV`, and the raw `Bun.build` config (plugins, `define`, etc.) can be passed straight through.

## Examples

This repo is a Bun workspace monorepo — the library lives in [asset-oven/](asset-oven/), with three runnable examples under [examples/](examples/):

- [examples/hono-basic/](examples/hono-basic/) — a Hono app using the `asset-oven/hono` middleware
- [examples/bun-serve/](examples/bun-serve/) — a plain `Bun.serve` app using the `asset-oven/bun` `withAssets` wrapper
- [examples/nested-assets/](examples/nested-assets/) — a JS `import` and a CSS `url()` each resolving to their own hashed asset URL

```bash
bun install
cd examples/hono-basic && bun run dev
```

Swap in `examples/bun-serve` or `examples/nested-assets` for the other two.

## Configuration

`AssetBuilderOptions`, accepted by both adapters and the `AssetBuilder` core:

| Option             | Default                                 | Description                                                    |
| ------------------ | --------------------------------------- | -------------------------------------------------------------- |
| `root`             | `process.cwd()`                         | Directory local asset paths are resolved against.              |
| `publicPath`       | `""`                                    | Prefix prepended to every hashed asset URL.                    |
| `cacheDir`         | a random `os.tmpdir()` subdir           | Output directory for built/copied assets; wiped on boot.       |
| `build`            | `{}`                                    | Merged into every `Bun.build` call (plugins, `define`, etc).   |
| `minify`           | `true` in production, else `false`      | Minify bundled output.                                         |
| `sourcemap`        | `"none"` in production, else `"inline"` | Sourcemap mode for bundled output.                             |
| `negativeCacheTtl` | `60000`ms in production, else `5000`ms  | How long a failed/missing asset lookup is cached before retry. |

## Testing

```bash
cd asset-oven && bun test
```

## License

MIT
