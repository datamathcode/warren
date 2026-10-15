/**
 * Unit tests for the warren-f074 capture-and-attach path: when a booted
 * child fails to reach healthz, the timeout error must carry the child's
 * buffered output and exit status instead of discarding it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { AcceptanceError } from "./assert.ts";
import {
	type BootHandle,
	bootInProc,
	spawnCaptured,
	stopSpawned,
	waitForHealthzWithDiagnostics,
} from "./inproc.ts";

// Port 1 on loopback refuses connections instantly, so the healthz loop
// runs its full backoff against a guaranteed-unreachable URL.
const UNREACHABLE_URL = "http://127.0.0.1:1";

const watchedPids = new Set<number>();
const watchedGroups = new Set<number>();

function errorCode(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
	return typeof err.code === "string" ? err.code : undefined;
}

function pgrpOf(pid: number): number | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const rest = stat.slice(stat.lastIndexOf(")") + 2);
		const pgrp = Number(rest.split(" ")[2]);
		return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : undefined;
	} catch {
		return undefined;
	}
}

function childrenOf(pid: number): number[] {
	try {
		const text = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
		if (text === "") return [];
		return text
			.split(/\s+/)
			.map((part) => Number(part))
			.filter((child) => Number.isInteger(child) && child > 0);
	} catch {
		return [];
	}
}

function pidAlive(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
		if (state === "Z") return false;
	} catch {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return errorCode(err) === "EPERM";
	}
}

function groupAlive(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (err) {
		return errorCode(err) === "EPERM";
	}
}

function cmdline(pid: number): string {
	try {
		return readFileSync(`/proc/${pid}/cmdline`).toString().replaceAll("\0", " ").trim();
	} catch {
		return "";
	}
}

/** Record a pid, its group, and every descendant currently in /proc. */
function rememberTree(pid: number): void {
	const selfGroup = pgrpOf(process.pid);
	const seen = new Set<number>();
	const stack = [pid];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined || seen.has(current)) continue;
		seen.add(current);
		watchedPids.add(current);
		const group = pgrpOf(current);
		if (group !== undefined && group !== selfGroup) watchedGroups.add(group);
		for (const child of childrenOf(current)) stack.push(child);
	}
}

function spawnTracked(cmd: readonly string[]): ReturnType<typeof spawnCaptured> {
	const child = spawnCaptured(cmd);
	rememberTree(child.proc.pid);
	return child;
}

afterEach(() => {
	const alive: string[] = [];
	for (const pid of watchedPids) {
		if (pidAlive(pid)) alive.push(`pid ${pid} ${cmdline(pid)}`);
	}
	for (const group of watchedGroups) {
		if (groupAlive(group)) alive.push(`group ${group}`);
	}
	try {
		expect(alive).toEqual([]);
	} finally {
		for (const group of watchedGroups) {
			try {
				process.kill(-group, "SIGKILL");
			} catch {
				// Group already gone.
			}
		}
		for (const pid of watchedPids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already gone.
			}
		}
		watchedPids.clear();
		watchedGroups.clear();
	}
});

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
		const child = spawnTracked([
			process.execPath,
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
		const child = spawnTracked([
			process.execPath,
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
			const child = spawnTracked([
				process.execPath,
				"-e",
				"console.error('live only'); process.exit(0)",
			]);
			await child.exited;
			await child.drained;
			const err = await expectTimeout(child);
			expect(err.message).toContain("no captured output");
			expect(err.message).not.toContain("live only");
			await stopSpawned(child);
		} finally {
			delete process.env.WARREN_ACCEPTANCE_WARREN_STDOUT;
			delete process.env.WARREN_ACCEPTANCE_WARREN_STDERR;
		}
	});

	test("reports a signal kill when the child never exits on its own", async () => {
		const child = spawnTracked([
			process.execPath,
			"-e",
			"process.stdin.on('data', () => {}); setInterval(() => {}, 1000)",
		]);
		const err = await expectTimeout(child, 300);
		expect(err.message).toContain("no captured output");
		// Snapshot descendants while the process is still up, then kill the group.
		rememberTree(child.proc.pid);
		await stopSpawned(child);
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
