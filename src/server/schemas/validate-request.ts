/**
 * Request-body check for routes that publish a Zod schema.
 *
 * A mismatch is logged and answered with HTTP 400. The handler does not
 * run. The field value, the raw body, and unknown key names are never
 * logged — a client-chosen key name can itself be a secret. An unknown
 * key is recorded only as a count. A record key is logged as `*`.
 */

import type * as z from "zod";
import { MAX_REQUEST_BODY_BYTES } from "../request-body-limit.ts";
import { jsonResponse } from "../response.ts";
import type { Logger } from "../types.ts";
import { routeContract } from "./registry.ts";

/** `"log"` records mismatches. `"reject"` answers 400 and does not call the handler. */
export const REQUEST_BODY_VALIDATION_MODE: "log" | "reject" = "reject";

export interface FieldIssue {
	readonly field: string;
	readonly errorType: string;
	/** Set for `unrecognized_keys`. The key names are not stored. */
	readonly unknownKeyCount?: number;
}

/**
 * Returns a 400 response when the body does not match. Routes with no
 * published body schema are skipped. `"log"` mode records the mismatch
 * and returns null so the handler still runs. The mode argument defaults
 * to the shipped setting; tests pass `"log"` to cover both.
 */
export async function enforceRequestBody(
	route: { readonly method: string; readonly pattern: string },
	request: Request,
	logger: Logger,
	mode: "log" | "reject" = REQUEST_BODY_VALIDATION_MODE,
): Promise<Response | null> {
	const contract = routeContract(route.method, route.pattern);
	if (contract?.body === undefined) return null;
	const issues = await collectIssues(contract.body, request, contract.bodyRequired !== false);
	if (issues.length === 0) return null;
	const routeLabel = `${route.method} ${route.pattern}`;
	for (const issue of issues) {
		logger.warn(
			{
				route: routeLabel,
				field: issue.field,
				errorType: issue.errorType,
				...(issue.unknownKeyCount !== undefined ? { unknownKeyCount: issue.unknownKeyCount } : {}),
			},
			"request body failed schema check",
		);
	}
	if (mode === "reject") return rejectionResponse(issues);
	return null;
}

async function collectIssues(
	body: z.ZodType | "none",
	request: Request,
	bodyRequired: boolean,
): Promise<FieldIssue[]> {
	if (declaresOversizedBody(request)) return [{ field: "$", errorType: "too_big" }];
	let raw: string;
	try {
		raw = await request.clone().text();
	} catch {
		return [{ field: "$", errorType: "validator_error" }];
	}
	if (body === "none") return issuesForAbsentBody(raw);
	// Handlers that call `readJsonBodyOrEmpty` treat a missing body as `{}`.
	if (raw.length === 0)
		return bodyRequired ? [{ field: "$", errorType: "invalid_type" }] : parseBody(body, {});
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [{ field: "$", errorType: "invalid_json" }];
	}
	if (!isJsonObject(parsed)) return [{ field: "$", errorType: "invalid_type" }];
	return parseBody(body, parsed);
}

function parseBody(body: z.ZodType, value: unknown): FieldIssue[] {
	const result = body.safeParse(value);
	if (result.success) return [];
	return issuesFromZod(body, result.error);
}

function issuesForAbsentBody(raw: string): FieldIssue[] {
	if (raw.trim().length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [{ field: "$", errorType: "invalid_json" }];
	}
	if (!isJsonObject(parsed)) return [{ field: "$", errorType: "invalid_type" }];
	const count = Object.keys(parsed).length;
	if (count === 0) return [];
	return [{ field: "$", errorType: "unrecognized_keys", unknownKeyCount: count }];
}

/** True when Content-Length is over the server cap or is not a safe byte count. */
function declaresOversizedBody(request: Request): boolean {
	const raw = request.headers.get("content-length");
	if (raw === null) return false;
	if (!/^\d+$/.test(raw)) return true;
	const n = Number(raw);
	return !Number.isSafeInteger(n) || n > MAX_REQUEST_BODY_BYTES;
}

/**
 * Never read `issue.message` or `issue.input`. Zod puts the received
 * value in both, and that value can be a secret.
 */
function issuesFromZod(schema: z.ZodType, error: z.ZodError): FieldIssue[] {
	const issues: FieldIssue[] = [];
	for (const issue of error.issues) {
		const field = joinPath(schema, issue.path);
		if (issue.code === "unrecognized_keys") {
			issues.push({ field, errorType: issue.code, unknownKeyCount: issue.keys.length });
			continue;
		}
		issues.push({ field, errorType: issue.code });
	}
	return issues;
}

function rejectionResponse(issues: readonly FieldIssue[]): Response {
	const summary = issues
		.slice(0, 20)
		.map((issue) =>
			issue.unknownKeyCount === undefined
				? `${issue.field} (${issue.errorType})`
				: `${issue.field} (${issue.errorType} count ${issue.unknownKeyCount})`,
		)
		.join(", ");
	return jsonResponse(400, {
		error: {
			code: "validation_error",
			message: `request body does not match the schema: ${summary}`,
		},
	});
}

/**
 * Declared object keys and array indexes stay. A record key is client
 * input, so it becomes `*`. The same replacement is used when the schema
 * walk cannot prove a segment is declared.
 */
function joinPath(schema: z.ZodType, path: readonly PropertyKey[]): string {
	if (path.length === 0) return "$";
	const parts: string[] = [];
	let current: z.ZodType | undefined = schema;
	for (const part of path) {
		if (current === undefined) {
			parts.push("*");
			continue;
		}
		const step = labelFor(current, part);
		parts.push(step.label);
		current = step.next;
	}
	return parts.join(".");
}

const SCHEMA_WRAPPERS = new Set([
	"optional",
	"nullable",
	"default",
	"prefault",
	"nonoptional",
	"readonly",
	"catch",
	"success",
]);

interface SchemaDef {
	readonly type?: string;
	readonly shape?: Readonly<Record<string, z.ZodType>>;
	readonly element?: z.ZodType;
	readonly valueType?: z.ZodType;
	readonly innerType?: z.ZodType;
	readonly in?: z.ZodType;
	readonly out?: z.ZodType;
}

function readDef(schema: z.ZodType): SchemaDef {
	const boxed = schema as { readonly _zod?: { readonly def?: SchemaDef } };
	return boxed._zod?.def ?? {};
}

function unwrap(schema: z.ZodType): SchemaDef {
	let current = schema;
	for (let i = 0; i < 8; i++) {
		const def = readDef(current);
		if (def.type === "pipe") {
			const next = def.in ?? def.out;
			if (next === undefined) return def;
			current = next;
			continue;
		}
		if (def.type !== undefined && SCHEMA_WRAPPERS.has(def.type) && def.innerType !== undefined) {
			current = def.innerType;
			continue;
		}
		return def;
	}
	return readDef(current);
}

function labelFor(schema: z.ZodType, part: PropertyKey): { label: string; next?: z.ZodType } {
	const def = unwrap(schema);
	if (def.type === "record") return { label: "*", next: def.valueType };
	if (def.type === "array") return { label: arrayIndex(part), next: def.element };
	if (def.type === "object") return objectLabel(def, part);
	return { label: "*" };
}

function objectLabel(def: SchemaDef, part: PropertyKey): { label: string; next?: z.ZodType } {
	if (typeof part !== "string" || def.shape === undefined || !Object.hasOwn(def.shape, part)) {
		return { label: "*" };
	}
	const field = def.shape[part];
	if (field === undefined) return { label: "*" };
	return { label: part, next: field };
}

function arrayIndex(part: PropertyKey): string {
	if (typeof part === "number" && Number.isInteger(part) && part >= 0) return String(part);
	return "*";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
