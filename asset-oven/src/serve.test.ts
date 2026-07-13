import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveFile } from "./serve.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "serve-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function write(name: string, bytes: Buffer): string {
	const filePath = path.join(root, name);
	writeFileSync(filePath, bytes);
	return filePath;
}

describe("range requests", () => {
	test("serves a byte range with 206, Content-Range, Content-Length, Accept-Ranges", async () => {
		const bytes = Buffer.from(
			Array.from({ length: 1000 }, (_, i) => i % 256)
		);
		const filePath = write("video.bin", bytes);

		const res = serveFile(
			new Request("http://x/video.bin", {
				headers: { Range: "bytes=10-19" },
			}),
			filePath,
			"video/mp4"
		);

		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Range")).toBe("bytes 10-19/1000");
		expect(res.headers.get("Content-Length")).toBe("10");
		expect(res.headers.get("Accept-Ranges")).toBe("bytes");
		expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([
			...bytes.subarray(10, 20),
		]);
	});

	test("clamps a range that extends past the end of the file", async () => {
		const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
		const filePath = write("video.bin", bytes);

		const res = serveFile(
			new Request("http://x/video.bin", {
				headers: { Range: "bytes=90-500" },
			}),
			filePath,
			"video/mp4"
		);
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Range")).toBe("bytes 90-99/100");
		expect(res.headers.get("Content-Length")).toBe("10");
	});

	test("resolves a suffix range (bytes=-N) to the last N bytes", async () => {
		const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
		const filePath = write("video.bin", bytes);

		const res = serveFile(
			new Request("http://x/video.bin", {
				headers: { Range: "bytes=-10" },
			}),
			filePath,
			"video/mp4"
		);
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Range")).toBe("bytes 90-99/100");
	});

	test("treats a backwards range as absent and serves a full 200", async () => {
		const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
		const filePath = write("video.bin", bytes);

		const res = serveFile(
			new Request("http://x/video.bin", {
				headers: { Range: "bytes=50-10" },
			}),
			filePath,
			"video/mp4"
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Length")).toBe("100");
	});

	test("returns 416 with Content-Range: */size for an unsatisfiable range", async () => {
		const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
		const filePath = write("video.bin", bytes);

		const res = serveFile(
			new Request("http://x/video.bin", {
				headers: { Range: "bytes=200-300" },
			}),
			filePath,
			"video/mp4"
		);
		expect(res.status).toBe(416);
		expect(res.headers.get("Content-Range")).toBe("bytes */100");
	});

	test("serves the full body with Content-Length and Accept-Ranges when no Range is given", async () => {
		const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
		const filePath = write("video.bin", bytes);

		const res = serveFile(
			new Request("http://x/video.bin"),
			filePath,
			"video/mp4"
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Length")).toBe("100");
		expect(res.headers.get("Accept-Ranges")).toBe("bytes");
	});
});

describe("HEAD requests", () => {
	test("HEAD returns headers with no body on a full request", () => {
		const bytes = Buffer.from([1, 2, 3, 4]);
		const filePath = write("f.bin", bytes);

		const res = serveFile(
			new Request("http://x/f.bin", { method: "HEAD" }),
			filePath,
			"application/octet-stream"
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Length")).toBe("4");
		expect(res.body).toBeNull();
	});

	test("HEAD returns 206 headers with no body on a ranged request", () => {
		const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
		const filePath = write("f.bin", bytes);

		const res = serveFile(
			new Request("http://x/f.bin", {
				method: "HEAD",
				headers: { Range: "bytes=0-9" },
			}),
			filePath,
			"application/octet-stream"
		);
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Length")).toBe("10");
		expect(res.body).toBeNull();
	});
});

describe("headers", () => {
	test("sets Content-Type from the given type and immutable caching headers", () => {
		const filePath = write("f.txt", Buffer.from("hi"));
		const res = serveFile(
			new Request("http://x/f.txt"),
			filePath,
			"text/plain"
		);
		expect(res.headers.get("Content-Type")).toBe("text/plain");
		expect(res.headers.get("Cache-Control")).toBe(
			"public, max-age=31536000, immutable"
		);
	});
});
