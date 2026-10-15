import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import {
	AGENT_SOURCES,
	EVENT_STREAMS,
	PLAN_RUN_CHILD_STATES,
	PLAN_RUN_STATES,
	PREVIEW_STATES,
	PULL_REQUEST_LIFECYCLES,
	RUN_FAILURE_REASONS,
	RUN_STATES,
} from "../src/core/wire.ts";
import { extractRoutes } from "./generate-docs.ts";
import { buildDocument, convertPattern, generate, tagFor } from "./generate-openapi.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("generate-openapi", () => {
	test("check:all and CI both run the Redocly lint command", () => {
		const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		const command = "npx @redocly/cli lint docs/openapi.yaml";
		expect(pkg.scripts["check:openapi"]).toBe(command);
		expect(pkg.scripts["check:all"]).toBe("bash scripts/check-all.sh");
		const ci = readFileSync(resolve(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
		expect(ci).toContain(command);
		const entry = readFileSync(resolve(REPO_ROOT, "scripts/check-all.sh"), "utf8");
		expect(entry).toContain("bun run check:openapi");
		expect(entry).toContain('"$@"');
	});

	test("docs/openapi.yaml is in sync with src/server/handlers/index.ts", () => {
		const { content } = generate();
		const onDisk = readFileSync(resolve(REPO_ROOT, "docs/openapi.yaml"), "utf8");
		expect(onDisk).toBe(content);
	});

	test("generated document parses as YAML and looks like OpenAPI 3.1", () => {
		const { content, routeCount } = generate();
		const parsed = load(content) as Record<string, unknown>;
		expect(parsed.openapi).toBe("3.1.0");
		expect(parsed.info).toBeDefined();
		const paths = parsed.paths as Record<string, unknown>;
		expect(Object.keys(paths).length).toBeGreaterThan(0);
		// Path count <= route count (some paths share method-collapsed entries).
		expect(Object.keys(paths).length).toBeLessThanOrEqual(routeCount);
	});

	test("convertPattern rewrites :param to {param} and emits a path parameter", () => {
		const { openapiPath, parameters } = convertPattern("/runs/:id/preview/login");
		expect(openapiPath).toBe("/runs/{id}/preview/login");
		expect(parameters).toEqual([
			{ name: "id", in: "path", required: true, schema: { type: "string" } },
		]);
	});

	test("convertPattern dedupes repeated params and handles multi-param paths", () => {
		const { openapiPath, parameters } = convertPattern("/projects/:id/seeds/:seedId/things/:id");
		expect(openapiPath).toBe("/projects/{id}/seeds/{seedId}/things/{id}");
		expect(parameters.map((p) => p.name)).toEqual(["id", "seedId"]);
	});

	test("convertPattern leaves static paths untouched", () => {
		const { openapiPath, parameters } = convertPattern("/healthz");
		expect(openapiPath).toBe("/healthz");
		expect(parameters).toEqual([]);
	});

	test("tagFor groups meta endpoints and uses first segment elsewhere", () => {
		expect(tagFor("/healthz")).toBe("meta");
		expect(tagFor("/readyz")).toBe("meta");
		expect(tagFor("/version")).toBe("meta");
		expect(tagFor("/runs/:id")).toBe("runs");
		expect(tagFor("/plots/:id/summary")).toBe("plots");
	});

	test("buildDocument collapses methods on the same path into one path item", () => {
		const doc = buildDocument(
			[
				{ method: "GET", pattern: "/runs", handler: "listRunsHandler" },
				{ method: "POST", pattern: "/runs", handler: "createRunHandler" },
			],
			"9.9.9",
		);
		expect(doc.info.version).toBe("9.9.9");
		const item = doc.paths["/runs"];
		expect(item?.get?.operationId).toBe("listRunsHandler");
		expect(item?.post?.operationId).toBe("createRunHandler");
	});

	test("buildDocument carries route comments into the operation description", () => {
		const doc = buildDocument(
			[
				{
					method: "GET",
					pattern: "/plots/needs-attention/count",
					handler: "needsAttentionCountHandler",
					comment: "Static path — must precede `/plots/:id`.",
				},
			],
			"0.0.0",
		);
		const op = doc.paths["/plots/needs-attention/count"]?.get;
		expect(op?.description).toContain("must precede");
	});

	test("buildDocument emits both 200 and default responses for every operation", () => {
		const doc = buildDocument(
			[{ method: "GET", pattern: "/healthz", handler: "healthz" }],
			"0.0.0",
		);
		const op = doc.paths["/healthz"]?.get;
		expect(op?.responses["200"]).toBeDefined();
		expect(op?.responses.default).toBeDefined();
	});

	test("components.schemas derives enum vocabulary from src/core/wire.ts", () => {
		const doc = buildDocument([], "0.0.0");
		const schemas = doc.components.schemas as Record<string, { type?: unknown; enum?: unknown[] }>;
		expect(schemas.RunState?.enum).toEqual([...RUN_STATES]);
		expect(schemas.RunFailureReason?.enum).toEqual([...RUN_FAILURE_REASONS]);
		expect(schemas.PlanRunState?.enum).toEqual([...PLAN_RUN_STATES]);
		expect(schemas.PlanRunChildState?.enum).toEqual([...PLAN_RUN_CHILD_STATES]);
		expect(schemas.PreviewState?.enum).toEqual([...PREVIEW_STATES]);
		expect(schemas.EventStream?.enum).toEqual([...EVENT_STREAMS]);
		expect(schemas.AgentSource?.enum).toEqual([...AGENT_SOURCES]);
		expect(schemas.PullRequestLifecycle?.enum).toEqual([...PULL_REQUEST_LIFECYCLES]);
	});

	test("components.schemas covers the core document shapes", () => {
		const doc = buildDocument([], "0.0.0");
		for (const name of ["Run", "PlanRun", "PlanRunChild", "Project", "Agent", "ErrorEnvelope"]) {
			expect(doc.components.schemas[name]).toBeDefined();
		}
		// The run document carries the dispatch-time ref (warren-afeb / PR #916).
		const run = doc.components.schemas.Run as { properties: Record<string, unknown> };
		expect(run.properties.ref).toBeDefined();
		expect(run.properties.state).toEqual({ $ref: "#/components/schemas/RunState" });
	});

	test("default error response references the ErrorEnvelope schema", () => {
		const doc = buildDocument(
			[{ method: "GET", pattern: "/healthz", handler: "healthz" }],
			"0.0.0",
		);
		const op = doc.paths["/healthz"]?.get;
		expect(op?.responses.default?.content?.["application/json"]?.schema).toEqual({
			$ref: "#/components/schemas/ErrorEnvelope",
		});
	});

	test("known routes wire their 200 response to a component schema", () => {
		const doc = buildDocument(
			[
				{ method: "GET", pattern: "/runs/:id", handler: "getRunHandler" },
				{ method: "GET", pattern: "/agents", handler: "listAgentsHandler" },
			],
			"0.0.0",
		);
		const runBody = doc.paths["/runs/{id}"]?.get?.responses["200"]?.content?.["application/json"]
			?.schema as { properties: Record<string, unknown> };
		expect(runBody.properties.run).toEqual({ $ref: "#/components/schemas/Run" });
		const agentsBody = doc.paths["/agents"]?.get?.responses["200"]?.content?.["application/json"]
			?.schema as { properties: { agents: { items: unknown } } };
		expect(agentsBody.properties.agents.items).toEqual({
			$ref: "#/components/schemas/Agent",
		});
	});

	test("document declares the default server, the MIT license, and bearer auth", () => {
		const doc = buildDocument([], "0.0.0");
		expect(doc.servers[0]?.url).toBe("http://localhost:8080");
		expect(doc.info.license).toEqual({ name: "MIT", identifier: "MIT" });
		expect(doc.security).toEqual([{ bearerAuth: [] }]);
		expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
	});

	test("anonymous routes opt out of bearer auth and every operation lists a 4XX", () => {
		const doc = buildDocument(
			[
				{ method: "GET", pattern: "/healthz", handler: "healthz", policy: "anonymous" },
				{ method: "GET", pattern: "/runs", handler: "listRunsHandler", policy: "readPublic" },
			],
			"0.0.0",
		);
		expect(doc.paths["/healthz"]?.get?.security).toEqual([]);
		expect(doc.paths["/runs"]?.get?.security).toBeUndefined();
		const clientError = doc.paths["/runs"]?.get?.responses["4XX"];
		expect(clientError?.content?.["application/json"]?.schema).toEqual({
			$ref: "#/components/schemas/ErrorEnvelope",
		});
	});

	test("nullable run enums reference the named component schema", () => {
		const doc = buildDocument([], "0.0.0");
		const run = doc.components.schemas.Run as {
			properties: { failureReason: unknown; cloneKind: unknown };
		};
		expect(run.properties.failureReason).toEqual({
			anyOf: [{ $ref: "#/components/schemas/RunFailureReason" }, { type: "null" }],
		});
		expect(run.properties.cloneKind).toEqual({
			anyOf: [{ $ref: "#/components/schemas/CloneKind" }, { type: "null" }],
		});
	});

	test("EventStream is the only component schema the route table does not reference", () => {
		const source = readFileSync(resolve(REPO_ROOT, "src/server/handlers/route-table.ts"), "utf8");
		const doc = buildDocument(extractRoutes(source), "0.0.0");
		const used = new Set<string>();
		collectSchemaRefs(doc, used);
		const unused = Object.keys(doc.components.schemas)
			.filter((name) => !used.has(name))
			.sort();
		expect(unused).toEqual(["EventStream"]);
	});

	test("unknown routes keep a permissive 200 with no body schema", () => {
		const doc = buildDocument(
			[{ method: "POST", pattern: "/runs/:id/steer", handler: "steerRunHandler" }],
			"0.0.0",
		);
		const ok = doc.paths["/runs/{id}/steer"]?.post?.responses["200"];
		expect(ok?.description).toBe("Successful response.");
		expect(ok?.content).toBeUndefined();
	});
});

/** Names of `#/components/schemas/` targets anywhere in the document. */
function collectSchemaRefs(value: unknown, found: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectSchemaRefs(item, found);
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		const schemaPrefix = "#/components/schemas/";
		if (key === "$ref" && typeof child === "string" && child.startsWith(schemaPrefix)) {
			found.add(child.slice(schemaPrefix.length));
			continue;
		}
		collectSchemaRefs(child, found);
	}
}
