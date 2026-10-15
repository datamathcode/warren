/**
 * Fresh TCP probes for "is this listener still up?"
 *
 * Bun's `server.stop()` leaves the socket accepting connections unless
 * `closeActiveConnections` is true, and the returned promise must be
 * awaited. A keep-alive fetch can also reuse a pooled socket and report
 * success against a server that is no longer listening. Dialing with
 * `node:net` opens a new handshake, so it answers only the listen socket.
 */

import { createConnection } from "node:net";

const PROBE_TIMEOUT_MS = 250;

/** Host to dial when the listener is bound to a wildcard address. */
export function probeHost(hostname: string): string {
	if (hostname === "0.0.0.0" || hostname === "::" || hostname === "") return "127.0.0.1";
	return hostname;
}

/**
 * True when a brand-new TCP handshake to `hostname:port` succeeds.
 * Refusal and timeout count as closed.
 */
export function tcpPortAccepts(hostname: string, port: number): Promise<boolean> {
	const host = probeHost(hostname);
	return new Promise((resolve) => {
		const socket = createConnection({ host, port });
		let settled = false;
		const finish = (accepts: boolean): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(accepts);
		};
		socket.setTimeout(PROBE_TIMEOUT_MS);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
	});
}

/** Resolves once `hostname:port` refuses a fresh TCP connection. */
export async function waitUntilPortRefused(
	hostname: string,
	port: number,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!(await tcpPortAccepts(hostname, port))) return;
		if (Date.now() >= deadline) {
			throw new Error(`${probeHost(hostname)}:${port} still accepts connections`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
