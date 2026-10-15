/**
 * Request-body check for routes that publish a Zod schema.
 *
 * A mismatch is logged and answered with HTTP 400. The handler does not
 * run. The field value, the raw body, and unknown key names are never
 * logged — a client-chosen key name can itself be a secret. An unknown
 * key is recorded only as a count.
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
 * and returns null so the handler still runs.
 */
export async function enforceRequestBody(
	route: { readonly method: string; readonly pattern: string },
	request: Request,
	logger: Logger,
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
	if (REQUEST_BODY_VALIDATION_MODE === "reject") return rejectionResponse(issues);
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
	return issuesFromZod(result.error);
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

function issuesFromZod(error: z.ZodError): FieldIssue[] {
	const issues: FieldIssue[] = [];
	for (const issue of error.issues) {
		if (issue.code === "unrecognized_keys") {
			issues.push({
				field: joinPath(issue.path),
				errorType: issue.code,
				unknownKeyCount: issue.keys.length,
			});
			continue;
		}
		issues.push({ field: joinPath(issue.path), errorType: issue.code });
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

function joinPath(path: readonly PropertyKey[]): string {
	if (path.length === 0) return "$";
	return path.map((part) => String(part)).join(".");
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
