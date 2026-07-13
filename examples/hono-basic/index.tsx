import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { builder } from "asset-oven/hono";

const app = new Hono();

app.use(
	builder({
		root: import.meta.dir,
		publicPath: "/assets",
	})
);

const Layout: FC = (props) => {
	return (
		<html>
			<head>
				<link rel="stylesheet" href="/styles.css" />
				<script src="/client.ts" type="module"></script>
			</head>
			<body>
				<header>
					<a href="/">Home</a>
					{" | "}
					<a href="/about">About</a>
				</header>
				<div>{props.children}</div>
				<div id="app" className="card">
					<div className="title">Card Title</div>
					<div className="content">Card Content</div>
				</div>
			</body>
		</html>
	);
};

app.get("/", (c) =>
	c.html(
		<Layout>
			<h1>Home Page</h1>
			<img src="/image.png" alt="Logo" />
		</Layout>
	)
);

app.get("/about", (c) =>
	c.html(
		<Layout>
			<h1>About Page</h1>
		</Layout>
	)
);

export default app;
