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
import { withAssets } from "./bun.ts";

const TMP_ROOT = path.join(import.meta.dir, "..", ".test-tmp");

let root: string;

beforeEach(() => {
	mkdirSync(TMP_ROOT, { recursive: true });
	root = mkdtempSync(path.join(TMP_ROOT, "bun-"));
});

afterAll(() => {
	rmSync(TMP_ROOT, { recursive: true, force: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("bun adapter", () => {
	test("serveAsset hit is served directly, bypassing the wrapped fetch handler", async () => {
		writeFileSync(path.join(root, "client.ts"), `console.log("hi");\n`);

		let appCalls = 0;
		const fetch = withAssets(
			(req) => {
				appCalls++;
				const { pathname } = new URL(req.url);
				if (pathname === "/") {
					return new Response(
						`<script src="/client.ts" type="module"></script>`,
						{ headers: { "Content-Type": "text/html" } }
					);
				}
				return new Response("app");
			},
			{ root, publicPath: "/assets" }
		);

		// first request renders + registers the asset, going through the app
		const html = await (await fetch(new Request("http://x/"))).text();
		const url = /<script[^>]*\ssrc="([^"]+)"/.exec(html)![1]!;
		expect(appCalls).toBe(1);

		const res = await fetch(new Request(`http://x${url}`));
		expect(appCalls).toBe(1); // still 1: serveAsset short-circuited before reaching the app
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('console.log("hi")');
	});

	test("transforms an html response from the wrapped fetch handler", async () => {
		writeFileSync(
			path.join(root, "logo.png"),
			Buffer.from([0x89, 0x50, 0x4e, 0x47])
		);

		const fetch = withAssets(
			() =>
				new Response(`<!doctype html><img src="/logo.png" alt="" />`, {
					headers: { "Content-Type": "text/html" },
				}),
			{ root, publicPath: "/assets" }
		);

		const res = await fetch(new Request("http://x/"));
		const html = await res.text();
		const url = /<img[^>]*\ssrc="([^"]+)"/.exec(html)![1]!;
		expect(url).toMatch(/^\/assets\/logo-[0-9a-f]{8}\.png$/);

		const assetRes = await fetch(new Request(`http://x${url}`));
		expect(assetRes.status).toBe(200);
		expect(assetRes.headers.get("Content-Type")).toMatch(/image\/png/);
	});

	test("leaves a non-html response from the wrapped fetch handler untouched", async () => {
		const fetch = withAssets(() => Response.json({ ok: true }), {
			root,
			publicPath: "/assets",
		});

		const res = await fetch(new Request("http://x/data.json"));
		expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
		expect(await res.json()).toEqual({ ok: true });
	});
});
