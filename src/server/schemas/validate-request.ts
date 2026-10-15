/**
 * Request-body check for routes that publish a Zod schema.
 *
 * Starts in log-only mode: a mismatch is recorded and the handler still
 * runs. The field value and the raw body are never logged — bodies can
 * carry tokens and keys. The switch to HTTP 400 is `REQUEST_BODY_VALIDATION_MODE`.
 */

import type * as z from "zod";
import { jsonResponse } from "../response.ts";
import type { Logger } from "../types.ts";
import { routeContract } from "./registry.ts";

/** `"log"` records mismatches. `"reject"` answers 400 and does not call the handler. */
export const REQUEST_BODY_VALIDATION_MODE: "log" | "reject" = "log";

export interface FieldIssue {
	readonly field: string;
	readonly errorType: string;
}

/**
 * Returns a 400 response when validation mode is `"reject"` and the body
 * does not match. Log-only mode always returns null after recording the
 * mismatch. Routes with no published body schema are skipped.
 */
export async function enforceRequestBody(
	route: { readonly method: string; readonly pattern: string },
	request: Request,
	logger: Logger,
): Promise<Response | null> {
	const contract = routeContract(route.method, route.pattern);
	if (contract?.body === undefined) return null;
	const issues = await collectIssues(contract.body, request);
	if (issues.length === 0) return null;
	const routeLabel = `${route.method} ${route.pattern}`;
	for (const issue of issues) {
		logger.warn(
			{ route: routeLabel, field: issue.field, errorType: issue.errorType },
			"request body failed schema check",
		);
	}
	if (REQUEST_BODY_VALIDATION_MODE === "reject") return rejectionResponse(issues);
	return null;
}

async function collectIssues(body: z.ZodType | "none", request: Request): Promise<FieldIssue[]> {
	let raw: string;
	try {
		raw = await request.clone().text();
	} catch {
		return [{ field: "$", errorType: "validator_error" }];
	}
	if (body === "none") return issuesForAbsentBody(raw);
	if (raw.length === 0) return [{ field: "$", errorType: "invalid_type" }];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [{ field: "$", errorType: "invalid_json" }];
	}
	if (!isJsonObject(parsed)) return [{ field: "$", errorType: "invalid_type" }];
	const result = body.safeParse(parsed);
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
	return Object.keys(parsed).map((key) => ({ field: key, errorType: "unrecognized_keys" }));
}

function issuesFromZod(error: z.ZodError): FieldIssue[] {
	const issues: FieldIssue[] = [];
	for (const issue of error.issues) {
		if (issue.code === "unrecognized_keys") {
			for (const key of issue.keys) {
				issues.push({ field: joinPath([...issue.path, key]), errorType: issue.code });
			}
			continue;
		}
		issues.push({ field: joinPath(issue.path), errorType: issue.code });
	}
	return issues;
}

function rejectionResponse(issues: readonly FieldIssue[]): Response {
	const summary = issues
		.slice(0, 20)
		.map((issue) => `${issue.field} (${issue.errorType})`)
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
