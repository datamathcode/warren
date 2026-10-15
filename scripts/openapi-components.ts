/**
 * OpenAPI component schemas for the generated warren HTTP document.
 *
 * Split out of `generate-openapi.ts` so that file stays under the line
 * budget. Every enum is derived from `src/core/wire.ts`. Document shapes
 * mirror the SDK row types in `src/client/types*.ts`.
 */

import {
	AGENT_SOURCES,
	CLONE_KINDS,
	EVENT_STREAMS,
	PLAN_RUN_CHILD_STATES,
	PLAN_RUN_SOURCES,
	PLAN_RUN_STATES,
	PREVIEW_STATES,
	PULL_REQUEST_LIFECYCLES,
	RUN_COST_BASES,
	RUN_FAILURE_REASONS,
	RUN_MODES,
	RUN_STATES,
} from "../src/core/wire.ts";

export type JsonSchema = Record<string, unknown>;

/** String enum schema derived from a wire.ts `as const` tuple. */
function enumSchema(values: readonly string[]): JsonSchema {
	return { type: "string", enum: [...values] };
}

export function refSchema(name: string): JsonSchema {
	return { $ref: `#/components/schemas/${name}` };
}

/**
 * A named schema or JSON null. OpenAPI 3.1 has no `nullable` keyword, so
 * this is `anyOf` plus a null type. Referencing the named enum keeps the
 * component in use (Redocly `no-unused-components`).
 */
function nullableRef(name: string): JsonSchema {
	return { anyOf: [refSchema(name), { type: "null" }] };
}

export function arrayOf(item: JsonSchema): JsonSchema {
	return { type: "array", items: item };
}

export const STRING = { type: "string" } as const;
const NULLABLE_STRING = { type: ["string", "null"] } as const;
export const NULLABLE_NUMBER = { type: ["number", "null"] } as const;
const NULLABLE_INTEGER = { type: ["integer", "null"] } as const;

/** Required-everywhere object envelope: `{ <key>: <schema>, ... }`. */
export function envelope(properties: Record<string, JsonSchema>): JsonSchema {
	return { type: "object", properties, required: Object.keys(properties) };
}

export function buildComponentSchemas(): Record<string, JsonSchema> {
	return {
		RunState: enumSchema(RUN_STATES),
		RunFailureReason: enumSchema(RUN_FAILURE_REASONS),
		RunMode: enumSchema(RUN_MODES),
		RunCostBasis: enumSchema(RUN_COST_BASES),
		CloneKind: enumSchema(CLONE_KINDS),
		PreviewState: enumSchema(PREVIEW_STATES),
		EventStream: enumSchema(EVENT_STREAMS),
		PlanRunState: enumSchema(PLAN_RUN_STATES),
		PlanRunChildState: enumSchema(PLAN_RUN_CHILD_STATES),
		AgentSource: enumSchema(AGENT_SOURCES),
		PullRequestLifecycle: enumSchema(PULL_REQUEST_LIFECYCLES),
		ErrorEnvelope: envelope({
			error: {
				type: "object",
				properties: { code: STRING, message: STRING, hint: STRING },
				required: ["code", "message"],
			},
		}),
		Project: {
			type: "object",
			properties: {
				id: STRING,
				gitUrl: STRING,
				localPath: STRING,
				defaultBranch: STRING,
				addedAt: STRING,
				lastFetchedAt: NULLABLE_STRING,
				lastHeadSha: NULLABLE_STRING,
				hasSeeds: { type: "boolean" },
			},
			required: [
				"id",
				"gitUrl",
				"localPath",
				"defaultBranch",
				"addedAt",
				"lastFetchedAt",
				"lastHeadSha",
				"hasSeeds",
			],
		},
		Agent: {
			type: "object",
			properties: {
				name: STRING,
				renderedJson: {},
				registeredAt: STRING,
				lastRefreshed: STRING,
				description: NULLABLE_STRING,
				provider: NULLABLE_STRING,
				model: NULLABLE_STRING,
				source: refSchema("AgentSource"),
			},
			required: ["name", "registeredAt", "lastRefreshed", "description", "provider", "model"],
		},
		Run: {
			type: "object",
			properties: {
				id: STRING,
				agentName: STRING,
				projectId: NULLABLE_STRING,
				sandboxId: NULLABLE_STRING,
				sandboxRunId: NULLABLE_STRING,
				seedId: NULLABLE_STRING,
				parentRunId: NULLABLE_STRING,
				cloneKind: nullableRef("CloneKind"),
				mode: refSchema("RunMode"),
				provider: NULLABLE_STRING,
				model: NULLABLE_STRING,
				renderedAgentJson: {},
				state: refSchema("RunState"),
				failureReason: nullableRef("RunFailureReason"),
				createdAt: NULLABLE_NUMBER,
				startedAt: NULLABLE_STRING,
				endedAt: NULLABLE_STRING,
				commitsAhead: NULLABLE_INTEGER,
				filesChanged: NULLABLE_INTEGER,
				insertions: NULLABLE_INTEGER,
				deletions: NULLABLE_INTEGER,
				prompt: STRING,
				trigger: STRING,
				prUrl: NULLABLE_STRING,
				prState: nullableRef("PullRequestLifecycle"),
				prMergedAt: NULLABLE_STRING,
				targetBranch: NULLABLE_STRING,
				ref: NULLABLE_STRING,
				salvageRef: NULLABLE_STRING,
				salvagePath: NULLABLE_STRING,
				costUsd: NULLABLE_NUMBER,
				tokensInput: NULLABLE_INTEGER,
				tokensOutput: NULLABLE_INTEGER,
				tokensCacheRead: NULLABLE_INTEGER,
				tokensCacheWrite: NULLABLE_INTEGER,
				previewState: nullableRef("PreviewState"),
				previewPort: NULLABLE_INTEGER,
				previewStartedAt: NULLABLE_STRING,
				previewLastHitAt: NULLABLE_STRING,
				previewFailureMessage: NULLABLE_STRING,
				costBasis: refSchema("RunCostBasis"),
			},
			required: ["id", "agentName", "mode", "state", "prompt", "trigger", "costBasis"],
		},
		PlanRun: {
			type: "object",
			properties: {
				id: STRING,
				planId: NULLABLE_STRING,
				source: enumSchema(PLAN_RUN_SOURCES),
				projectId: STRING,
				agentName: STRING,
				promptTemplate: STRING,
				ref: NULLABLE_STRING,
				providerOverride: NULLABLE_STRING,
				modelOverride: NULLABLE_STRING,
				maxCostUsd: NULLABLE_NUMBER,
				dispatcherHandle: STRING,
				trigger: STRING,
				state: refSchema("PlanRunState"),
				failureReason: NULLABLE_STRING,
				createdAt: STRING,
				startedAt: NULLABLE_STRING,
				endedAt: NULLABLE_STRING,
			},
			required: [
				"id",
				"source",
				"projectId",
				"agentName",
				"promptTemplate",
				"dispatcherHandle",
				"trigger",
				"state",
				"createdAt",
			],
		},
		PlanRunChild: {
			type: "object",
			properties: {
				planRunId: STRING,
				seq: { type: "integer" },
				seedId: STRING,
				runId: NULLABLE_STRING,
				state: refSchema("PlanRunChildState"),
				createdAt: STRING,
				updatedAt: STRING,
				startedAt: NULLABLE_STRING,
				endedAt: NULLABLE_STRING,
				prMergedAt: NULLABLE_STRING,
				failureReason: NULLABLE_STRING,
			},
			required: ["planRunId", "seq", "seedId", "runId", "state", "createdAt", "updatedAt"],
		},
	};
}
