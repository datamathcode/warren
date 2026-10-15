import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { depsFor, makeSdSpawn, silentLogger, tcpUrl } from "../handlers/plan-runs.test-helpers.ts";
import { makeRecordingLogger } from "../handlers/runs.test-helpers.ts";
import { MAX_REQUEST_BODY_BYTES } from "../request-body-limit.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { enforceRequestBody, REQUEST_BODY_VALIDATION_MODE } from "./validate-request.ts";

const KEY_NAME_MARKER = "KEY_NAME_MARKER_do_not_log";

describe("enforceRequestBody", () => {
	let db: WarrenDb | null = null;
	let handle: ServeHandle | null = null;

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db?.close();
		db = null;
	});

	test("rejects a mismatched body and does not run the handler", async () => {
		expect(REQUEST_BODY_VALIDATION_MODE).toBe("reject");
		db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/seedy.git",
			localPath: "/tmp/seedy",
			defaultBranch: "main",
			hasSeeds: true,
		});
		await repos.agents.upsert({
			name: "claude-code",
			renderedJson: { name: "claude-code", version: 1, sections: {}, frontmatter: {} },
		});
		const created = await repos.planRuns.create({
			planId: "pl-log",
			projectId: project.id,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		const { logger, lines } = makeRecordingLogger();
		handle = startServer(
			await depsFor({ repos, sdSpawn: makeSdSpawn([], []), logger: silentLogger }),
			{
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: NO_AUTH,
				logger,
			},
		);
		const secret = "super-secret-token-value";
		const res = await fetch(`${tcpUrl(handle)}/plan-runs/${created.planRun.id}/cancel`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ [KEY_NAME_MARKER]: secret }),
		});
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).not.toContain(secret);
		expect(text).not.toContain(KEY_NAME_MARKER);
		const rejected = JSON.parse(text) as { error: { code: string; message: string } };
		expect(rejected.error.code).toBe("validation_error");
		expect(rejected.error.message).toContain("$ (unrecognized_keys count 1)");
		expect((await repos.planRuns.require(created.planRun.id)).state).toBe("queued");
		const warnings = lines.filter((line) => line.level === "warn");
		expect(warnings.length).toBeGreaterThan(0);
		expect(JSON.stringify(lines)).not.toContain(secret);
		expect(JSON.stringify(lines)).not.toContain(KEY_NAME_MARKER);
		expect(warnings.every((line) => line.obj.errorType === "unrecognized_keys")).toBe(true);
		expect(warnings.every((line) => line.obj.unknownKeyCount === 1)).toBe(true);
		expect(warnings.every((line) => line.obj.field === "$")).toBe(true);
		expect(warnings.every((line) => line.obj.route === "POST /plan-runs/:id/cancel")).toBe(true);
		for (const line of warnings) {
			// The server logger binds request_id. The validator adds the route,
			// the field path, the error type, and a count of unknown keys.
			expect(Object.keys(line.obj).sort()).toEqual([
				"errorType",
				"field",
				"request_id",
				"route",
				"unknownKeyCount",
			]);
		}
	});

	test("logs a type error without the received value and skips a valid body", async () => {
		const secret = "ghp_should_not_appear";
		const { logger, lines } = makeRecordingLogger();
		const route = { method: "POST", pattern: "/projects" };
		const bad = await enforceRequestBody(
			route,
			new Request("http://warren.test/projects", {
				method: "POST",
				body: JSON.stringify({ gitUrl: "", [KEY_NAME_MARKER]: secret }),
			}),
			logger,
		);
		const badMessage = await expectRejection(bad);
		expect(badMessage).not.toContain(secret);
		expect(badMessage).not.toContain(KEY_NAME_MARKER);
		expect(badMessage).toContain("unrecognized_keys count 1");
		expect(JSON.stringify(lines)).not.toContain(secret);
		expect(JSON.stringify(lines)).not.toContain(KEY_NAME_MARKER);
		expect(
			lines.some((line) => line.obj.field === "gitUrl" && line.obj.errorType === "too_small"),
		).toBe(true);
		expect(
			lines.some(
				(line) => line.obj.errorType === "unrecognized_keys" && line.obj.unknownKeyCount === 1,
			),
		).toBe(true);
		const typed = await enforceRequestBody(
			route,
			new Request("http://warren.test/projects", {
				method: "POST",
				body: JSON.stringify({ gitUrl: 12 }),
			}),
			logger,
		);
		const typedMessage = await expectRejection(typed);
		expect(typedMessage).not.toContain("12");
		expect(typedMessage).toContain("gitUrl (invalid_type)");
		expect(
			lines.some((line) => line.obj.field === "gitUrl" && line.obj.errorType === "invalid_type"),
		).toBe(true);
		expect(JSON.stringify(lines)).not.toContain("12");
		const before = lines.length;
		const ok = await enforceRequestBody(
			route,
			new Request("http://warren.test/projects", {
				method: "POST",
				body: JSON.stringify({ gitUrl: "https://github.com/x/y.git" }),
			}),
			logger,
		);
		expect(ok).toBeNull();
		expect(lines.length).toBe(before);
	});

	test("logs invalid json, an empty body, and a non-object without the payload", async () => {
		const { logger, lines } = makeRecordingLogger();
		const route = { method: "POST", pattern: "/projects" };
		for (const body of ["{not-json", "", "[]"]) {
			const result = await enforceRequestBody(
				route,
				new Request("http://warren.test/projects", { method: "POST", body }),
				logger,
			);
			const message = await expectRejection(result);
			expect(message).not.toContain("not-json");
		}
		expect(lines.map((line) => line.obj.errorType)).toEqual([
			"invalid_json",
			"invalid_type",
			"invalid_type",
		]);
		expect(JSON.stringify(lines)).not.toContain("not-json");
	});

	test("accepts an empty cancel body and logs a non-object", async () => {
		const { logger, lines } = makeRecordingLogger();
		const route = { method: "POST", pattern: "/plan-runs/:id/cancel" };
		expect(
			await enforceRequestBody(
				route,
				new Request("http://warren.test/plan-runs/1/cancel", { method: "POST" }),
				logger,
			),
		).toBeNull();
		expect(
			await enforceRequestBody(
				route,
				new Request("http://warren.test/plan-runs/1/cancel", { method: "POST", body: "{}" }),
				logger,
			),
		).toBeNull();
		expect(
			await expectRejection(
				await enforceRequestBody(
					route,
					new Request("http://warren.test/plan-runs/1/cancel", { method: "POST", body: "[]" }),
					logger,
				),
			),
		).toContain("invalid_type");
		expect(lines.map((line) => line.obj.errorType)).toEqual(["invalid_type"]);
		expect(
			await expectRejection(
				await enforceRequestBody(
					route,
					new Request("http://warren.test/plan-runs/1/cancel", {
						method: "POST",
						body: "not-json",
					}),
					logger,
				),
			),
		).not.toContain("not-json");
		expect(lines.at(-1)?.obj.errorType).toBe("invalid_json");
	});

	test("refuses a declared oversized body before parsing it", async () => {
		const request = new Request("http://warren.test/projects", {
			method: "POST",
			body: JSON.stringify({ [KEY_NAME_MARKER]: "present" }),
			headers: { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) },
		});
		const { logger, lines } = makeRecordingLogger();
		const result = await enforceRequestBody(
			{ method: "POST", pattern: "/projects" },
			request,
			logger,
		);
		const message = await expectRejection(result);
		expect(message).toContain("too_big");
		expect(message).not.toContain(KEY_NAME_MARKER);
		expect(lines.map((line) => line.obj.errorType)).toEqual(["too_big"]);
		expect(JSON.stringify(lines)).not.toContain(KEY_NAME_MARKER);
	});

	test("Bun rejects an oversized body before the handler logs anything", async () => {
		db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		const { logger, lines } = makeRecordingLogger();
		handle = startServer(await depsFor({ repos, sdSpawn: makeSdSpawn([], []), logger }), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger,
			maxRequestBodySize: 32,
		});
		const res = await fetch(`${tcpUrl(handle)}/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ [KEY_NAME_MARKER]: "value-over-the-cap" }),
		});
		expect(res.status).toBe(413);
		const text = await res.text();
		if (text.includes(KEY_NAME_MARKER)) throw new Error("response echoed the marker key name");
		expect(JSON.stringify(lines)).not.toContain(KEY_NAME_MARKER);
		expect(lines.some((line) => line.level === "warn")).toBe(false);
	});

	test("an empty optional body matches the schema", async () => {
		const { logger, lines } = makeRecordingLogger();
		const result = await enforceRequestBody(
			{ method: "POST", pattern: "/projects/:id/refresh" },
			new Request("http://warren.test/projects/p1/refresh", { method: "POST" }),
			logger,
		);
		expect(result).toBeNull();
		expect(lines).toEqual([]);
	});

	test("skips routes that have no published body schema", async () => {
		const { logger, lines } = makeRecordingLogger();
		const result = await enforceRequestBody(
			{ method: "GET", pattern: "/no-such-route" },
			new Request("http://warren.test/no-such-route"),
			logger,
		);
		expect(result).toBeNull();
		expect(lines).toEqual([]);
	});
});

async function expectRejection(result: Response | null): Promise<string> {
	expect(result).not.toBeNull();
	if (result === null) return "";
	expect(result.status).toBe(400);
	const body = (await result.json()) as { error?: { code?: string; message?: string } };
	expect(body.error?.code).toBe("validation_error");
	return body.error?.message ?? "";
}
