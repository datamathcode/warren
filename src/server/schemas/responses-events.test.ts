import { afterEach, describe, test } from "bun:test";
import { request as httpRequest } from "node:http";
import type { ZodType } from "zod";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { LifecycleStreamBroker } from "../../runs/lifecycle-stream.ts";
import { NO_AUTH } from "../auth.ts";
import { createDbSeams } from "../db-seams.ts";
import {
	depsFor,
	makeSdSpawn,
	setupPlanRunFixture,
	silentLogger,
	tcpUrl,
} from "../handlers/plan-runs.test-helpers.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { eventRouteContracts } from "./routes-events.ts";

const contracts = new Map(eventRouteContracts.map((contract) => [contract.key, contract]));

describe("event route response schemas", () => {
	let db: WarrenDb;
	let handle: ServeHandle | null = null;

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("event handlers return bodies the published schemas accept", async () => {
		const fixture = await setupPlanRunFixture();
		db = fixture.db;
		const repos: Repos = fixture.repos;
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId: fixture.projectId,
			prompt: "emit",
			renderedAgentJson: { name: "claude-code" },
			trigger: "manual",
		});
		await repos.events.append({
			runId: run.id,
			sandboxEventSeq: 1,
			ts: "2026-05-08T12:00:00.000Z",
			kind: "note",
			stream: "system",
			payload: { ok: true },
		});
		const plan = await repos.planRuns.create({
			planId: "pl-events",
			projectId: fixture.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		await repos.planRuns.updateChild({
			planRunId: plan.planRun.id,
			seq: 1,
			patch: { runId: run.id },
		});
		const lifecycle = new LifecycleStreamBroker();
		handle = startServer(
			{
				...(await depsFor({ repos, sdSpawn: makeSdSpawn([], []) })),
				...createDbSeams(db),
				lifecycleStream: lifecycle,
			},
			{
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: NO_AUTH,
				logger: silentLogger,
			},
		);
		const base = tcpUrl(handle);
		const list = contracts.get("GET /events");
		const runLine = contracts.get("GET /runs/:id/events");
		const planLine = contracts.get("GET /plan-runs/:id/events");
		const lifeLine = contracts.get("GET /events/stream");
		if (
			list === undefined ||
			runLine === undefined ||
			planLine === undefined ||
			lifeLine === undefined
		) {
			throw new Error("missing event contract");
		}

		await expectJson(await fetch(`${base}/events`), list.response);
		await expectLines(await fetch(`${base}/runs/${run.id}/events?follow=0`), runLine.response);
		await expectLines(
			await fetch(`${base}/plan-runs/${plan.planRun.id}/events?follow=0`),
			planLine.response,
		);
		const closed = await fetch(`${base}/events/stream?follow=0`);
		if (closed.status !== 200) {
			throw new Error(`status ${closed.status} expected 200 code ${await errorCode(closed)}`);
		}
		if ((await closed.text()).length !== 0)
			throw new Error("a closed lifecycle probe should be empty");
		// Bun does not send response headers until the stream produces a
		// chunk, and a publish before subscribe is dropped. Publish on a
		// short interval, then close the socket at the first line.
		const line = await readOneNdjsonLine(`${base}/events/stream`, () => {
			lifecycle.publish({
				runId: run.id,
				hook: "run_started",
				state: "running",
				ts: "2026-05-08T12:00:01.000Z",
			});
		});
		parseLine(line, lifeLine.response);
	});
});

function readOneNdjsonLine(url: string, publish: () => void): Promise<string> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		let settled = false;
		const finish = (err?: Error, line?: string): void => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			if (err !== undefined) reject(err);
			else resolve(line ?? "");
		};
		const req = httpRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: `${parsed.pathname}${parsed.search}`,
				method: "GET",
			},
			(res) => {
				if (res.statusCode !== 200) {
					finish(new Error(`status ${res.statusCode ?? 0}`));
					res.resume();
					return;
				}
				let buf = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					buf += chunk;
					const nl = buf.indexOf("\n");
					if (nl < 0) return;
					req.destroy();
					finish(undefined, buf.slice(0, nl));
				});
			},
		);
		const timer = setInterval(publish, 20);
		req.on("error", (err) => finish(err));
		req.end();
	});
}

function parseLine(line: string, schema: ZodType): void {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new Error("ndjson line was not json");
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`response failed schema: ${issueSummary(parsed.error.issues)}`);
	}
}

async function expectJson(res: Response, schema: ZodType): Promise<void> {
	if (res.status !== 200)
		throw new Error(`status ${res.status} expected 200 code ${await errorCode(res)}`);
	const parsed = schema.safeParse(await res.json());
	if (!parsed.success)
		throw new Error(`response failed schema: ${issueSummary(parsed.error.issues)}`);
}

async function expectLines(res: Response, schema: ZodType): Promise<void> {
	if (res.status !== 200)
		throw new Error(`status ${res.status} expected 200 code ${await errorCode(res)}`);
	const text = await res.text();
	const lines = text.split("\n").filter((line) => line.length > 0);
	if (lines.length === 0) throw new Error("expected at least one ndjson line");
	for (const line of lines) parseLine(line, schema);
}

function issueSummary(issues: readonly { path: PropertyKey[]; code: string }[]): string {
	return issues.map((issue) => `${issue.path.join(".")}:${issue.code}`).join(", ");
}

async function errorCode(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: { code?: unknown } };
		return typeof body.error?.code === "string" ? body.error.code : "";
	} catch {
		return "";
	}
}
