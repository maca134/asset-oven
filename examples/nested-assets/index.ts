import { withAssets } from "asset-oven/bun";

const html = `<!doctype html>
<html>
	<head>
		<link rel="stylesheet" href="/styles.css" />
		<script src="/client.ts" type="module"></script>
	</head>
	<body>
		<h1>Nested assets</h1>
		<p>
			<code>client.ts</code> imports <code>./logo.png</code> and sets it as
			an <code>&lt;img&gt;</code> src; <code>styles.css</code> references
			the same file via <code>url()</code> for the box below.
		</p>
		<div id="banner"></div>
	</body>
</html>`;

const fetch = withAssets(
	(req) => {
		const { pathname } = new URL(req.url);
		if (pathname === "/") {
			return new Response(html, {
				headers: { "Content-Type": "text/html" },
			});
		}
		return new Response("Not Found", { status: 404 });
	},
	{
		root: import.meta.dir,
		publicPath: "/assets",
	}
);

Bun.serve({ fetch });
