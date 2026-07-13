# asset-oven

Lazy, content-hashed asset middleware for Bun — local asset paths in server-rendered HTML just work.

This is a Bun workspace monorepo:

- [asset-oven/](asset-oven/) — the library (`AssetBuilder` core, plus `asset-oven/hono` and `asset-oven/bun` adapters)
- [examples/hono-basic/](examples/hono-basic/) — Hono app using the `asset-oven/hono` middleware
- [examples/bun-serve/](examples/bun-serve/) — plain `Bun.serve` app using the `asset-oven/bun` `withAssets` wrapper
- [examples/nested-assets/](examples/nested-assets/) — demonstrates a JS `import` and a CSS `url()` resolving to their own hashed asset URLs

## Setup

```bash
bun install
```

## Running an example

```bash
cd examples/hono-basic && bun run dev
```

Swap in `examples/bun-serve` or `examples/nested-assets` for the other two.

## Testing the library

```bash
cd asset-oven && bun test
```
