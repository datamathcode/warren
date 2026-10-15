#!/usr/bin/env bun
/**
 * Automated OpenAPI 3.1 schema generator for warren's HTTP API
 * (warren-b46b, plan pl-7b06 step 21).
 *
 * Like `generate-docs.ts`, this derives its output directly from the
 * `ROUTE_TABLE` constant in `src/server/handlers/route-table.ts` so the published
 * schema can't drift from the running router. Where `generate-docs.ts`
 * produces a human-readable Markdown route table, this script emits a
 * machine-readable OpenAPI 3.1 document (`docs/openapi.yaml`) suitable
 * for client codegen, spec linting, and contract tooling.
 *
 * Scope (intentional V1 floor):
 * - Paths, methods, path parameters, and operationIds derived from the
 *   handler symbol name are covered. The route ordering caveats encoded
 *   as `//` comments in `ROUTE_TABLE` (e.g. "must precede `/plots/:id`")
 *   are surfaced as the operation's `description`.
 * - `components.schemas` and the operation bodies come from the Zod
 *   schemas in `src/server/schemas/`. Zod 4's JSON Schema export is the
 *   only translator. A route with no published schema stays a permissive
 *   success response until its batch lands.
 *
 * Modes:
 *   bun run gen:openapi          # write docs/openapi.yaml
 *   bun run gen:openapi:check    # exit 1 if docs/openapi.yaml is stale
 *
 * The check mode is wired into `bun run check:all`; CI fails when the
 * route table changes but the schema isn't regenerated. Fix by running
 * `bun run gen:openapi` and committing the result. `bun run check:openapi`
 * then lints the generated file with Redocly (`redocly.yaml`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dump } from "js-yaml";
import { DEFAULT_WARREN_BASE_URL } from "../src/client/config.ts";
import {
	componentRef,
	type JsonSchema,
	openApiComponents,
	routeContract,
} from "../src/server/schemas/index.ts";
import { extractRoutes, type Route } from "./generate-docs.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const HANDLERS_PATH = resolve(REPO_ROOT, "src/server/handlers/route-table.ts");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");
const OUTPUT_PATH = resolve(REPO_ROOT, "docs/openapi.yaml");

const PATH_PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

type OpenApiParameter = {
	name: string;
	in: "path";
	required: true;
	schema: { type: "string" };
};

type OpenApiMedia = { schema: JsonSchema };

type OpenApiResponse = {
	description: string;
	content?: Record<string, OpenApiMedia>;
};

type OpenApiRequestBody = {
	required: boolean;
	description?: string;
	content: { "application/json": OpenApiMedia };
};

/** One security requirement. An empty array on an operation means anonymous. */
type OpenApiSecurityRequirement = Record<string, string[]>;

type OpenApiOperation = {
	operationId: string;
	tags: string[];
	summary: string;
	description?: string;
	parameters?: OpenApiParameter[];
	requestBody?: OpenApiRequestBody;
	security?: OpenApiSecurityRequirement[];
	responses: Record<string, OpenApiResponse>;
};

type OpenApiPathItem = Partial<Record<Lowercase<Route["method"]>, OpenApiOperation>>;

type OpenApiDocument = {
	openapi: "3.1.0";
	info: {
		title: string;
		version: string;
		description: string;
		license: { name: string; identifier: string };
	};
	servers: { url: string; description: string }[];
	security: OpenApiSecurityRequirement[];
	tags: { name: string; description: string }[];
	paths: Record<string, OpenApiPathItem>;
	components: {
		securitySchemes: {
			bearerAuth: { type: "http"; scheme: "bearer"; description: string };
		};
		schemas: Record<string, JsonSchema>;
	};
};

function jsonContent(schema: JsonSchema): OpenApiResponse["content"] {
	return { "application/json": { schema } };
}

/**
 * Convert a warren route pattern like `/runs/:id/preview/login` into
 * the OpenAPI-canonical `/runs/{id}/preview/login` form plus the list
 * of declared path parameters.
 */
export function convertPattern(pattern: string): {
	openapiPath: string;
	parameters: OpenApiParameter[];
} {
	const parameters: OpenApiParameter[] = [];
	const seen = new Set<string>();
	const openapiPath = pattern.replace(PATH_PARAM_RE, (_, name: string) => {
		if (!seen.has(name)) {
			seen.add(name);
			parameters.push({
				name,
				in: "path",
				required: true,
				schema: { type: "string" },
			});
		}
		return `{${name}}`;
	});
	return { openapiPath, parameters };
}

/**
 * First path segment is used as both the OpenAPI tag and (with the
 * handler name) the operation's summary. Root-level routes (`/healthz`,
 * `/version`, …) collapse under a shared `meta` tag.
 */
export function tagFor(pattern: string): string {
	const segment = pattern.split("/")[1] ?? "";
	if (!segment) return "meta";
	if (segment.startsWith(":")) return "meta";
	if (segment === "healthz" || segment === "readyz" || segment === "version") {
		return "meta";
	}
	return segment;
}

function errorResponse(description: string): OpenApiResponse {
	return { description, content: jsonContent(componentRef("ErrorEnvelope")) };
}

function buildOperation(route: Route, parameters: OpenApiParameter[]): OpenApiOperation {
	const contract = routeContract(route.method, route.pattern);
	const ok: OpenApiResponse = { description: "Successful response." };
	if (contract) {
		const media = contract.contentType ?? "application/json";
		ok.content = { [media]: { schema: componentRef(contract.responseComponent) } };
	}
	const successStatus = String(contract?.successStatus ?? 200);
	const responses: Record<string, OpenApiResponse> = { [successStatus]: ok };
	for (const status of contract?.alsoSuccessStatuses ?? []) {
		responses[String(status)] = { ...ok };
	}
	// Range response: the route table does not list a status per
	// failure. `src/server/errors.ts` maps client failures onto
	// these codes, and every one of them uses the error envelope.
	responses["4XX"] = errorResponse(
		"Client error (400, 401, 403, 404, 409, 422, or 429). The body is the error envelope.",
	);
	responses.default = errorResponse(
		"Any other error, including a 500 internal error. The body is the error envelope.",
	);
	const op: OpenApiOperation = {
		operationId: route.handler,
		tags: [tagFor(route.pattern)],
		summary: `${route.method} ${route.pattern}`,
		responses,
	};
	if (route.comment) op.description = route.comment;
	if (contract?.body === "none") {
		const note = "This operation takes no JSON body.";
		op.description = op.description === undefined ? note : `${op.description} ${note}`;
		op.requestBody = {
			required: false,
			description: note,
			content: { "application/json": { schema: componentRef("NoRequestBody") } },
		};
	}
	if (parameters.length > 0) op.parameters = parameters;
	if (contract?.bodyComponent !== undefined) {
		const optional = contract.bodyRequired === false;
		op.requestBody = {
			required: !optional,
			...(optional ? { description: "The JSON body is optional. An empty body is valid." } : {}),
			content: { "application/json": { schema: componentRef(contract.bodyComponent) } },
		};
	}
	// Root security requires a bearer token. Anonymous routes opt out.
	if (route.policy === "anonymous") op.security = [];
	return op;
}

export function buildDocument(routes: readonly Route[], version: string): OpenApiDocument {
	const paths: Record<string, OpenApiPathItem> = {};
	const tagSet = new Set<string>();

	for (const route of routes) {
		const { openapiPath, parameters } = convertPattern(route.pattern);
		const item: OpenApiPathItem = paths[openapiPath] ?? {};
		const method = route.method.toLowerCase() as Lowercase<Route["method"]>;
		item[method] = buildOperation(route, parameters);
		paths[openapiPath] = item;
		tagSet.add(tagFor(route.pattern));
	}

	const tags = [...tagSet].sort().map((name) => ({
		name,
		description: name === "meta" ? "Liveness, readiness, and version." : `\`/${name}\` routes.`,
	}));

	// Sort paths alphabetically for stable output.
	const sortedPaths: Record<string, OpenApiPathItem> = {};
	for (const key of Object.keys(paths).sort()) {
		const value = paths[key];
		if (value !== undefined) sortedPaths[key] = value;
	}

	const license = readPackageLicense();
	return {
		openapi: "3.1.0",
		info: {
			title: "warren HTTP API",
			version,
			description:
				"Auto-generated from `src/server/handlers/route-table.ts`'s `ROUTE_TABLE` " +
				"and the Zod schemas in `src/server/schemas/`. Run `bun run gen:openapi` " +
				"to refresh; CI fails if this schema drifts. Enum vocabulary comes " +
				"from `src/core/wire.ts`. A route with no published schema keeps a " +
				"permissive success response. Operations require bearerAuth unless " +
				"the route policy is anonymous.",
			license: { name: license, identifier: license },
		},
		servers: [
			{
				url: DEFAULT_WARREN_BASE_URL,
				description: "Default warren base URL. Point a client at the instance you are calling.",
			},
		],
		security: [{ bearerAuth: [] }],
		tags,
		paths: sortedPaths,
		components: {
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
					description:
						"Operator bearer token (WARREN_API_TOKEN). Anonymous routes set security to an empty array.",
				},
			},
			schemas: openApiComponents(),
		},
	};
}

function readPackageField(field: "version" | "license"): string {
	const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as Record<string, unknown>;
	const value = pkg[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`package.json is missing a string \`${field}\` field.`);
	}
	return value;
}

function readPackageVersion(): string {
	return readPackageField("version");
}

function readPackageLicense(): string {
	return readPackageField("license");
}

export function generate(): { content: string; routeCount: number } {
	const source = readFileSync(HANDLERS_PATH, "utf8");
	const routes = extractRoutes(source);
	if (routes.length === 0) {
		throw new Error("Extractor found zero routes — refusing to overwrite docs/openapi.yaml.");
	}
	const doc = buildDocument(routes, readPackageVersion());
	const body = dump(doc, { lineWidth: 100, noRefs: true, sortKeys: false });
	const header = [
		"# AUTO-GENERATED by `bun run gen:openapi` from `src/server/handlers/route-table.ts`.",
		"# Do not edit by hand. CI fails if this file is out of sync.",
		"",
	].join("\n");
	return { content: `${header}${body}`, routeCount: routes.length };
}

function readExisting(): string | null {
	try {
		return readFileSync(OUTPUT_PATH, "utf8");
	} catch {
		return null;
	}
}

function main(): void {
	const checkMode = process.argv.includes("--check");
	const { content, routeCount } = generate();
	const existing = readExisting();

	if (checkMode) {
		if (existing === null) {
			console.error(
				"docs/openapi.yaml is missing. Run `bun run gen:openapi` and commit the result.",
			);
			process.exit(1);
		}
		if (existing !== content) {
			console.error("docs/openapi.yaml is stale relative to src/server/handlers/route-table.ts.");
			console.error("Run `bun run gen:openapi` and commit the result.");
			process.exit(1);
		}
		console.log(`gen:openapi ok (${routeCount} routes).`);
		return;
	}

	writeFileSync(OUTPUT_PATH, content);
	console.log(`Wrote docs/openapi.yaml (${routeCount} routes).`);
}

if (import.meta.main) main();
