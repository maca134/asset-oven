import type { MiddlewareHandler } from "hono";
import { AssetBuilder, type AssetBuilderOptions } from "./core.ts";

/** Hono middleware that serves and rewrites local asset references in server-rendered HTML. */
export function builder(options?: AssetBuilderOptions): MiddlewareHandler {
	const assets = new AssetBuilder(options);
	return async (c, next) => {
		const served = assets.serveAsset(c.req.raw);
		if (served) return served;

		await next();

		if (c.res.headers.get("Content-Type")?.startsWith("text/html")) {
			c.res = await assets.transformHtml(c.res);
		}
	};
}
