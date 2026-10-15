/**
 * Unit tests for the warren-f074 capture-and-attach path: when a booted
 * child fails to reach healthz, the timeout error must carry the child's
 * buffered output and exit status instead of discarding it.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { AcceptanceError } from "./assert.ts";
import {
	type BootHandle,
	bootInProc,
	spawnCaptured,
	waitForHealthzWithDiagnostics,
} from "./inproc.ts";

// Port 1 on loopback refuses connections instantly, so the healthz loop
// runs its full backoff against a guaranteed-unreachable URL.
const UNREACHABLE_URL = "http://127.0.0.1:1";

async function expectTimeout(
	child: Awaited<ReturnType<typeof spawnCaptured>>,
	timeoutMs = 500,
): Promise<AcceptanceError> {
	let err: unknown;
	try {
		await waitForHealthzWithDiagnostics(UNREACHABLE_URL, timeoutMs, child);
	} catch (caught) {
		err = caught;
	}
	expect(err).toBeInstanceOf(AcceptanceError);
	return err as AcceptanceError;
}

describe("waitForHealthzWithDiagnostics", () => {
	test("attaches buffered stderr and the exit code when healthz times out", async () => {
		const child = spawnCaptured([
			"bun",
			"-e",
			"console.error('boot exploded on purpose'); process.exit(3)",
		]);
		await child.exited;
		await child.drained;
		const err = await expectTimeout(child);
		expect(err.message).toContain("healthz did not reach a terminal state");
		expect(err.message).toContain("boot exploded on purpose");
		expect(err.message).toContain("child exited with code 3");
		expect(err.message).toContain("child stderr tail");
	});

	test("attaches buffered stdout alongside stderr", async () => {
		const child = spawnCaptured([
			"bun",
			"-e",
			"console.log('stdout line'); console.error('stderr line'); process.exit(1)",
		]);
		await child.exited;
		await child.drained;
		const err = await expectTimeout(child);
		expect(err.message).toContain("stdout line");
		expect(err.message).toContain("stderr line");
		expect(err.message).toContain("child stdout tail");
	});

	test("keeps the live-streaming env vars working (no capture, no crash)", async () => {
		process.env.WARREN_ACCEPTANCE_WARREN_STDOUT = "1";
		process.env.WARREN_ACCEPTANCE_WARREN_STDERR = "1";
		try {
			const child = spawnCaptured(["bun", "-e", "console.error('live only'); process.exit(0)"]);
			await child.exited;
			await child.drained;
			const err = await expectTimeout(child);
			expect(err.message).toContain("no captured output");
			expect(err.message).not.toContain("live only");
		} finally {
			delete process.env.WARREN_ACCEPTANCE_WARREN_STDOUT;
			delete process.env.WARREN_ACCEPTANCE_WARREN_STDERR;
		}
	});

	test("reports a signal kill when the child never exits on its own", async () => {
		const child = spawnCaptured([
			"bun",
			"-e",
			"process.stdin.on('data', () => {}); setInterval(() => {}, 1000)",
		]);
		const err = await expectTimeout(child, 300);
		expect(err.message).toContain("no captured output");
		// Kill only after the assertion captured the still-running state.
		child.proc.kill("SIGKILL");
		await child.exited;
	});
});

const HOLD_PORT = `
const port = Number(process.env.WARREN_BIND_PORT);
Bun.serve({
	hostname: process.env.WARREN_BIND_HOST ?? "127.0.0.1",
	port,
	fetch() {
		return new Response("ok");
	},
});
setInterval(() => {}, 1000);
`;

function shimScript(real: string): string {
	return `#!/bin/sh
# Package-manager bun shim. The real binary is a child. SIGTERM exits
# this shell and does not forward the signal.
"${real}" "$@" &
child=$!
trap 'exit 0' TERM INT
wait "$child"
`;
}

function freshPortAccepts(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		let settled = false;
		const finish = (accepts: boolean): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(accepts);
		};
		socket.setTimeout(250);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
	});
}

describe("bootInProc stop", () => {
	test("a bun shim on PATH does not keep the port after stop", async () => {
		const root = await mkdtemp(join(tmpdir(), "warren-bun-shim-"));
		const shimDir = join(root, "bin");
		await mkdir(shimDir);
		const server = join(root, "hold-port.ts");
		await writeFile(server, HOLD_PORT);
		await writeFile(join(shimDir, "bun"), shimScript(process.execPath), { mode: 0o755 });
		const previous = process.env.PATH;
		process.env.PATH = `${shimDir}${delimiter}${previous ?? ""}`;
		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(root, "work"),
				token: "shim-token",
				canopyRepoUrl: "https://example.invalid/canopy.git",
				serverEntry: server,
			});
			const port = Number(new URL(handle.warrenUrl).port);
			expect((await fetch(`${handle.warrenUrl}/healthz`)).status).toBe(200);
			await handle.stop();
			handle = undefined;
			await expect(
				fetch(`http://127.0.0.1:${port}/healthz`, { headers: { connection: "close" } }),
			).rejects.toThrow();
			expect(await freshPortAccepts(port)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
			await handle?.stop();
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
