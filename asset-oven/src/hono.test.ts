import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { builder } from "./hono.ts";

const TMP_ROOT = path.join(import.meta.dir, "..", ".test-tmp");

let root: string;

beforeEach(() => {
	mkdirSync(TMP_ROOT, { recursive: true });
	root = mkdtempSync(path.join(TMP_ROOT, "hono-"));
});

afterAll(() => {
	rmSync(TMP_ROOT, { recursive: true, force: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function appWithHtml(html: string) {
	const app = new Hono();
	app.use(builder({ root, publicPath: "/assets" }));
	app.get("/", (c) =>
		c.html(`<!doctype html><html><body>${html}</body></html>`)
	);
	return app;
}

describe("hono adapter", () => {
	test("rewrites a local asset tag and serves the built asset", async () => {
		writeFileSync(path.join(root, "client.ts"), `console.log("hi");\n`);
		const app = appWithHtml(
			`<script src="/client.ts" type="module"></script>`
		);

		const html = await (await app.request("/")).text();
		const match = /<script[^>]*\ssrc="([^"]+)"/.exec(html);
		expect(match?.[1]).toMatch(/^\/assets\/client-[0-9a-z]+\.js$/);

		const res = await app.request(match![1]!);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('console.log("hi")');
	});

	test("leaves non-html responses alone", async () => {
		const app = new Hono();
		app.use(builder({ root, publicPath: "/assets" }));
		app.get("/data.json", (c) => c.json({ ok: true }));

		const res = await app.request("/data.json");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
		expect(await res.json()).toEqual({ ok: true });
	});

	test("a POST to a hashed asset url falls through to the app instead of serving the asset", async () => {
		writeFileSync(
			path.join(root, "logo.png"),
			Buffer.from([0x89, 0x50, 0x4e, 0x47])
		);
		const app = appWithHtml(`<img src="/logo.png" alt="" />`);
		app.post("*", (c) => c.text("fallback", 201));

		const html = await (await app.request("/")).text();
		const url = /<img[^>]*\ssrc="([^"]+)"/.exec(html)![1]!;

		const res = await app.request(url, { method: "POST" });
		expect(res.status).toBe(201);
		expect(await res.text()).toBe("fallback");
	});
});
