import { AssetBuilder, type AssetBuilderOptions } from "./core.ts";

type FetchHandler = (req: Request) => Response | Promise<Response>;

/** Wraps a plain `Bun.serve` fetch handler to serve and rewrite local asset references in HTML responses. */
export function withAssets(
	fetch: FetchHandler,
	options?: AssetBuilderOptions
): FetchHandler {
	const builder = new AssetBuilder(options);
	return async (req) => {
		const served = builder.serveAsset(req);
		if (served) return served;

		const res = await fetch(req);
		if (res.headers.get("Content-Type")?.startsWith("text/html")) {
			return builder.transformHtml(res);
		}
		return res;
	};
}
