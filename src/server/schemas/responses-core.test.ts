import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZodType } from "zod";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
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
import {
	makeSandboxClient,
	depsFor as runDepsFor,
	tcpUrl as runTcpUrl,
} from "../handlers/runs.test-helpers.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	cancelPlanRunContract,
	createPlanRunContract,
	createRunContract,
	getPlanRunContract,
	getProjectContract,
	getRunContract,
	listAgentsContract,
	listPlanRunsContract,
	listProjectsContract,
	listRunsContract,
} from "./routes-core.ts";

describe("core route response schemas", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId = "";
	let seedyProjectId = "";

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
		const plan = await repos.planRuns.create({
			planId: "pl-read",
			projectId: seedyProjectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		handle = startServer(await planDepsFor({ repos, sdSpawn: makeSdSpawn([], []) }), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const base = tcpUrl(handle);
		await expectJson(base, "/projects", listProjectsContract.response);
		await expectJson(base, `/projects/${projectId}`, getProjectContract.response);
		await expectJson(base, "/agents", listAgentsContract.response);
		await expectJson(base, "/runs", listRunsContract.response);
		await expectJson(base, `/runs/${run.id}`, getRunContract.response);
		await expectJson(base, "/plan-runs", listPlanRunsContract.response);
		await expectJson(base, `/plan-runs/${plan.planRun.id}`, getPlanRunContract.response);
	});

	test("POST /plan-runs and cancel return bodies the published schemas accept", async () => {
		const calls: SdCall[] = [];
		const sdSpawn = makeSdSpawn(calls, [
			{
				match: (cmd) => cmd[1] === "plan" && cmd[2] === "show",
				result: planShowResult("pl-acc", "active", ["wa-a"]),
			},
			{
				match: (cmd) => cmd[1] === "show" && cmd[2] === "wa-a",
				result: seedShowResult("wa-a", "open"),
			},
		]);
		handle = startServer(await planDepsFor({ repos, sdSpawn }), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const created = await fetch(`${tcpUrl(handle)}/plan-runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project: seedyProjectId, planId: "pl-acc", agent: "claude-code" }),
		});
		expect(created.status).toBe(201);
		const payload = await created.json();
		expectSchema(createPlanRunContract.response, payload);
		const body = payload as { planRun: { id: string } };
		const cancelled = await fetch(`${tcpUrl(handle)}/plan-runs/${body.planRun.id}/cancel`, {
			method: "POST",
		});
		expect(cancelled.status).toBe(200);
		expectSchema(cancelPlanRunContract.response, await cancelled.json());
	});

	test("POST /runs returns a body the published schema accepts", async () => {
		const projectPath = await mkdtemp(join(tmpdir(), "warren-schema-proj-"));
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/dispatch.git",
			localPath: projectPath,
			defaultBranch: "main",
		});
		const workspace = await mkdtemp(join(tmpdir(), "warren-schema-ws-"));
		const provider = makeSandboxClient(
			{ sandboxId: "sbx_schema", sandboxRunId: "prn_schema", workspacePath: workspace },
			[],
		);
		handle = startServer(await runDepsFor(repos, provider), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${runTcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "claude-code",
				project: project.id,
				prompt: "do the thing",
			}),
		});
		expect(res.status).toBe(201);
		expectSchema(createRunContract.response, await res.json());
	});
});

async function expectJson(base: string, path: string, schema: ZodType): Promise<void> {
	const res = await fetch(`${base}${path}`);
	expect(res.status).toBe(200);
	expectSchema(schema, await res.json());
}

function expectSchema(schema: ZodType, value: unknown): void {
	const parsed = schema.safeParse(value);
	if (parsed.success) return;
	const summary = parsed.error.issues
		.map((issue) => `${issue.path.join(".") || "$"}:${issue.code}`)
		.join(", ");
	throw new Error(`response failed schema: ${summary}`);
}
