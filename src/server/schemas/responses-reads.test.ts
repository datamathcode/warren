import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import type { ZodType } from "zod";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { createDbSeams } from "../db-seams.ts";
import {
	makeSdSpawn,
	depsFor as planDepsFor,
	planShowResult,
	type SdCall,
	seedShowResult,
	setupPlanRunFixture,
	silentLogger,
	tcpUrl,
} from "../handlers/plan-runs.test-helpers.ts";
import { startServer } from "../server.ts";
import { SetupHandoffStore } from "../setup-handoff.ts";
import type { ServeHandle } from "../types.ts";
import { readRouteContracts } from "./routes-reads.ts";
import { analyticsRouteContracts } from "./routes-reads-analytics.ts";

const contracts = new Map(
	[...readRouteContracts, ...analyticsRouteContracts].map((contract) => [contract.key, contract]),
);

describe("read route response schemas", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let upstream: ReturnType<typeof Bun.serve> | null = null;
	let projectId = "";
	let seedyProjectId = "";
	const previousJudgeUrl = process.env.WARREN_JUDGE_BASE_URL;
	const previousJudgeToken = process.env.WARREN_JUDGE_EXPORT_TOKEN;

	beforeEach(async () => {
		const fixture = await setupPlanRunFixture();
		db = fixture.db;
		repos = fixture.repos;
		projectId = fixture.projectId;
		seedyProjectId = fixture.seedyProjectId;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		if (upstream) {
			upstream.stop(true);
			upstream = null;
		}
		if (previousJudgeUrl === undefined) delete process.env.WARREN_JUDGE_BASE_URL;
		else process.env.WARREN_JUDGE_BASE_URL = previousJudgeUrl;
		if (previousJudgeToken === undefined) delete process.env.WARREN_JUDGE_EXPORT_TOKEN;
		else process.env.WARREN_JUDGE_EXPORT_TOKEN = previousJudgeToken;
		await db.close();
	});

	test("GET handlers return bodies the published schemas accept", async () => {
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "say hello",
			renderedAgentJson: { name: "claude-code" },
			trigger: "manual",
		});
		const calls: SdCall[] = [];
		const sdSpawn = makeSdSpawn(calls, [
			{
				match: (cmd) => cmd[1] === "plan" && cmd[2] === "list",
				result: {
					stdout: JSON.stringify({
						plans: [{ id: "pl-ready", status: "approved", children: ["wa-a"] }],
					}),
					stderr: "",
					exitCode: 0,
				},
			},
			{
				match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
				result: planShowResult("pl-ready", "approved", ["wa-a"]),
			},
			{
				match: (cmd) => cmd[1] === "show",
				result: seedShowResult("wa-a", "open"),
			},
			{
				match: (cmd) => cmd[1] === "list",
				result: {
					stdout: JSON.stringify({
						success: true,
						issues: [{ id: "wa-a", status: "open", title: "open child" }],
					}),
					stderr: "",
					exitCode: 0,
				},
			},
		]);
		const store = new SetupHandoffStore();
		const code = store.mint("setup-handoff-test-token");
		upstream = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () =>
				new Response('{"id":"v1"}\n', {
					headers: { "content-type": "application/x-ndjson" },
				}),
		});
		process.env.WARREN_JUDGE_BASE_URL = `http://127.0.0.1:${upstream.port}`;
		process.env.WARREN_JUDGE_EXPORT_TOKEN = "judge-export-test";
		const deps = await planDepsFor({ repos, sdSpawn });
		handle = startServer(
			{ ...deps, db, ...createDbSeams(db), setupHandoff: store },
			{
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: NO_AUTH,
				logger: silentLogger,
			},
		);
		const base = tcpUrl(handle);
		await mkdir("/tmp/bare", { recursive: true });
		await mkdir("/tmp/seedy", { recursive: true });
		await expectJson(base, "/healthz", "GET /healthz");
		await expectJson(base, "/version", "GET /version");
		await expectJson(base, "/whoami", "GET /whoami");
		await expectJson(base, "/preview/config", "GET /preview/config");
		await expectJson(base, "/instance", "GET /instance");
		await expectJson(base, "/forge/repos", "GET /forge/repos");
		await expectJson(base, "/ops/overview", "GET /ops/overview");
		await expectJson(base, "/agents/claude-code", "GET /agents/:name");
		await expectJson(
			base,
			`/projects/${projectId}/warren-config`,
			"GET /projects/:id/warren-config",
		);
		await expectJson(base, `/projects/${projectId}/triggers`, "GET /projects/:id/triggers");
		await expectJson(
			base,
			`/projects/${seedyProjectId}/seeds/plans`,
			"GET /projects/:id/seeds/plans",
		);
		await expectJson(
			base,
			`/projects/${seedyProjectId}/ready-plans`,
			"GET /projects/:id/ready-plans",
		);
		await expectJson(
			base,
			`/projects/${seedyProjectId}/seeds/wa-a`,
			"GET /projects/:id/seeds/:seedId",
		);
		await expectJson(base, "/analytics/cost", "GET /analytics/cost");
		await expectJson(base, "/analytics/runs", "GET /analytics/runs");
		await expectJson(base, "/analytics/behavior", "GET /analytics/behavior");
		await expectJson(base, "/analytics/dispatch", "GET /analytics/dispatch");
		await expectJson(base, `/runs/${run.id}/inbox?peek=1`, "GET /runs/:id/inbox");
		await expectJson(base, `/runs/${run.id}/finalize-intent`, "GET /runs/:id/finalize-intent");
		await expectText(base, "/metrics", "GET /metrics");
		await expectText(base, "/github-app/register", "GET /github-app/register");
		await expectText(base, `/setup?code=${encodeURIComponent(code)}`, "GET /setup");
		await expectText(
			base,
			"/extensions/judge/verdicts.jsonl",
			"GET /extensions/judge/verdicts.jsonl",
		);

		const readyz = await fetch(`${base}/readyz`);
		expect([200, 503]).toContain(readyz.status);
		expectSchema(schema("GET /readyz"), await readyz.json());
	});
});

function schema(key: string): ZodType {
	const found = contracts.get(key);
	if (found === undefined) throw new Error(`missing contract ${key}`);
	return found.response;
}

async function expectJson(base: string, path: string, key: string): Promise<void> {
	const res = await fetch(`${base}${path}`);
	expect(res.status).toBe(200);
	expectSchema(schema(key), await res.json());
}

async function expectText(base: string, path: string, key: string): Promise<void> {
	const res = await fetch(`${base}${path}`);
	expect(res.status).toBe(200);
	const text = await res.text();
	expectSchema(schema(key), text);
	if (key !== "GET /metrics" && key !== "GET /extensions/judge/verdicts.jsonl") {
		expect(text.toLowerCase()).toContain("<!doctype html");
	}
}

function expectSchema(responseSchema: ZodType, value: unknown): void {
	const parsed = responseSchema.safeParse(value);
	if (parsed.success) return;
	const summary = parsed.error.issues
		.map((issue) => `${issue.path.join(".") || "$"}:${issue.code}`)
		.join(", ");
	throw new Error(`response failed schema: ${summary}`);
}
