import { afterEach, describe, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { createPreviewAuth } from "../../preview/cookie.ts";
import { NO_AUTH } from "../auth.ts";
import { createDbSeams } from "../db-seams.ts";
import { setupPlanRunFixture } from "../handlers/plan-runs.test-helpers.ts";
import {
	depsFor,
	makeSandboxClient,
	silentLogger,
	tcpUrl,
} from "../handlers/projects.test-helpers.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { projectWriteContracts } from "./routes-writes-projects.ts";
import { runWriteContracts } from "./routes-writes-runs.ts";

const contracts = new Map(
	[...projectWriteContracts, ...runWriteContracts].map((contract) => [contract.key, contract]),
);

describe("write route response schemas", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let root = "";
	const scratch: string[] = [];

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
		await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	test("write handlers return bodies the published schemas accept", async () => {
		const fixture = await setupPlanRunFixture();
		db = fixture.db;
		repos = fixture.repos;
		await mkdir("/tmp/bare", { recursive: true });
		await mkdir("/tmp/seedy", { recursive: true });
		root = await mkdtemp(join(tmpdir(), "warren-write-schemas-"));
		scratch.push(root);
		const salvageDir = await mkdtemp(join(tmpdir(), "warren-salvage-"));
		scratch.push(salvageDir);

		const refreshDir = await mkdtemp(join(root, "refresh-"));
		const triggerDir = await mkdtemp(join(root, "trigger-"));
		const initDir = await mkdtemp(join(root, "init-"));
		const migrateDir = await mkdtemp(join(root, "migrate-"));
		const deleteDir = await mkdtemp(join(root, "delete-"));
		await mkdir(join(triggerDir, ".warren"), { recursive: true });
		await writeFile(
			join(triggerDir, ".warren", "triggers.yaml"),
			"- id: nightly\n  kind: cron\n  cron: '0 2 * * *'\n  role: claude-code\n  prompt: 'hand-rolled prompt'\n",
		);
		await mkdir(join(migrateDir, ".warren"), { recursive: true });
		await writeFile(
			join(migrateDir, ".warren", "defaults.json"),
			JSON.stringify({ defaultRole: "claude-code" }),
		);

		const refreshProject = await repos.projects.create({
			gitUrl: "https://github.com/x/refresh.git",
			localPath: refreshDir,
			defaultBranch: "main",
		});
		const triggerProject = await repos.projects.create({
			gitUrl: "https://github.com/x/trigger.git",
			localPath: triggerDir,
			defaultBranch: "main",
		});
		const initProject = await repos.projects.create({
			gitUrl: "https://github.com/x/init.git",
			localPath: initDir,
			defaultBranch: "main",
		});
		const migrateProject = await repos.projects.create({
			gitUrl: "https://github.com/x/migrate.git",
			localPath: migrateDir,
			defaultBranch: "main",
		});
		const deleteProject = await repos.projects.create({
			gitUrl: "https://github.com/x/delete.git",
			localPath: deleteDir,
			defaultBranch: "main",
		});

		const queued = await repos.runs.create({
			agentName: "claude-code",
			projectId: fixture.projectId,
			prompt: "cancel me",
			renderedAgentJson: { name: "claude-code", frontmatter: {} },
			trigger: "manual",
		});
		const live = await repos.runs.create({
			agentName: "claude-code",
			projectId: fixture.projectId,
			prompt: "steer me",
			renderedAgentJson: { name: "claude-code", frontmatter: {} },
			trigger: "manual",
		});
		await repos.runs.attachBurrow(live.id, {
			sandboxId: "sbx_schema",
			sandboxRunId: "prn_schema",
		});

		const plan = await repos.planRuns.create({
			planId: "pl-resume",
			projectId: fixture.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		const now = new Date().toISOString();
		await repos.planRuns.transitionTo(plan.planRun.id, "running", { startedAt: now });
		await repos.planRuns.transitionTo(plan.planRun.id, "failed", {
			failureReason: "child_pr_merge_timeout",
			endedAt: now,
		});
		await repos.planRuns.updateChild({
			planRunId: plan.planRun.id,
			seq: 1,
			patch: { state: "failed", failureReason: "child_pr_merge_timeout" },
		});

		const provider = makeSandboxClient(
			{ sandboxId: "sbx_schema", sandboxRunId: "prn_schema", workspacePath: refreshDir },
			[],
		);
		handle = startServer(
			{
				...(await depsFor(repos, provider)),
				...createDbSeams(db),
				projectsConfig: { root, gitBinary: "git" },
				salvageDir,
				previewAuth: createPreviewAuth("preview-schema-token", {
					secure: false,
					scope: { mode: "path" },
				}),
				previewMode: "path",
			},
			{
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: NO_AUTH,
				logger: silentLogger,
			},
		);
		const base = tcpUrl(handle);

		await expectSchema(
			await post(base, "/alerts/heal?source=sentry", { message: "disk full" }),
			200,
			"POST /alerts/heal",
		);
		await expectSchema(
			await post(base, `/projects/${refreshProject.id}/refresh`),
			200,
			"POST /projects/:id/refresh",
		);
		await expectSchema(
			await post(base, `/projects/${triggerProject.id}/triggers/nightly/run`),
			201,
			"POST /projects/:id/triggers/:triggerId/run",
		);
		await expectSchema(
			await post(base, `/projects/${initProject.id}/init`),
			201,
			"POST /projects/:id/init",
		);
		await expectSchema(
			await post(base, `/projects/${migrateProject.id}/config-migrate`),
			200,
			"POST /projects/:id/config-migrate",
		);
		await expectSchema(
			await post(base, `/runs/${live.id}/finalize-result`, {
				version: 1,
				attemptId: "fin_test",
				result: {
					pushed: false,
					commitsAhead: null,
					emptyPush: false,
					dirty: false,
					events: [],
					stages: [],
				},
			}),
			200,
			"POST /runs/:id/finalize-result",
		);
		await expectSchema(
			await post(base, `/runs/${live.id}/salvage`, {
				version: 1,
				trigger: "no_intent",
				bundleBase64: null,
			}),
			200,
			"POST /runs/:id/salvage",
		);
		await expectSchema(
			await post(base, `/runs/${live.id}/git-credential`),
			200,
			"POST /runs/:id/git-credential",
		);
		await expectSchema(
			await post(base, `/runs/${live.id}/steer`, { body: "hello" }),
			200,
			"POST /runs/:id/steer",
		);
		await expectSchema(await post(base, `/runs/${queued.id}/cancel`), 200, "POST /runs/:id/cancel");
		await expectSchema(
			await post(base, `/runs/${live.id}/preview/login`),
			200,
			"POST /runs/:id/preview/login",
		);
		await expectSchema(
			await post(base, `/runs/${live.id}/preview/teardown`),
			200,
			"POST /runs/:id/preview/teardown",
		);
		await expectSchema(
			await post(base, `/plan-runs/${plan.planRun.id}/resume`),
			200,
			"POST /plan-runs/:id/resume",
		);
		await expectSchema(
			await del(base, `/projects/${deleteProject.id}`),
			200,
			"DELETE /projects/:id",
		);
	});
});

async function post(base: string, path: string, body?: unknown): Promise<Response> {
	if (body === undefined) return fetch(`${base}${path}`, { method: "POST" });
	return fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function del(base: string, path: string): Promise<Response> {
	return fetch(`${base}${path}`, { method: "DELETE" });
}

async function expectSchema(res: Response, status: number, key: string): Promise<void> {
	const contract = contracts.get(key);
	if (contract === undefined) throw new Error(`missing contract ${key}`);
	if (res.status !== status) {
		const code = await errorCode(res);
		throw new Error(`status ${res.status} expected ${status} code ${code} route ${key}`);
	}
	const parsed = contract.response.safeParse(await res.json());
	if (!parsed.success) {
		const summary = parsed.error.issues
			.map((issue) => `${issue.path.join(".")}:${issue.code}`)
			.join(", ");
		throw new Error(`response failed schema: ${summary}`);
	}
}

async function errorCode(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: { code?: unknown } };
		return typeof body.error?.code === "string" ? body.error.code : "";
	} catch {
		return "";
	}
}
