import { withAssets } from "asset-oven/bun";

function page(title: string): string {
	return `<!doctype html>
<html>
	<head>
		<link rel="stylesheet" href="/styles.css" />
		<script src="/client.ts" type="module"></script>
	</head>
	<body>
		<h1>${title}</h1>
	</body>
</html>`;
}

const fetch = withAssets(
	(req) => {
		const { pathname } = new URL(req.url);
		if (pathname === "/") {
			return new Response(page("Plain Bun.serve + withAssets"), {
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
