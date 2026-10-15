import { describe, expect, test } from "bun:test";

import { tcpPortAccepts } from "./tcp-port.ts";

describe("tcpPortAccepts", () => {
	test("a fresh dial succeeds while the server is up and fails after stop(true)", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("ok"),
		});
		const port = server.port ?? 0;
		expect(port).toBeGreaterThan(0);
		expect(await tcpPortAccepts("127.0.0.1", port)).toBe(true);
		await server.stop(true);
		expect(await tcpPortAccepts("127.0.0.1", port)).toBe(false);
	});
});
