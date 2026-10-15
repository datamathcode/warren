/**
 * Batch 1 — the routes whose success bodies were already named in the
 * generated spec, plus request bodies for the four POST routes in that set.
 * `POST /plan-runs/:id/cancel` takes no JSON body; the client sends none.
 */

import * as z from "zod";
import { MULCH_ARM_VALUES } from "../../runtime/adapters/mulch-arm.ts";
import {
	agentSchema,
	planRunChildSchema,
	planRunSchema,
	projectSchema,
	runSchema,
	sandboxSchema,
} from "./components.ts";
import { defineRoute, type RouteContract } from "./registry.ts";

const optString = z.string().nullish();
const positive = z.number().positive().nullish();

const createRunBody = z
	.strictObject({
		agent: optString,
		project: optString,
		prompt: optString,
		ref: optString,
		baseCommit: optString,
		targetBranch: optString,
		existingBranch: optString,
		providerOverride: optString,
		modelOverride: optString,
		trigger: optString,
		seedId: optString,
		dispatcherHandle: optString,
		continueFromRunId: optString,
		parentRunId: optString,
		cloneFromRunId: optString,
		rescueFromRunId: optString,
		maxCostUsd: positive,
		mulch: z.enum(MULCH_ARM_VALUES).nullish(),
		metadata: z.looseObject({}).nullish(),
	})
	.superRefine((body, ctx) => {
		if (nonEmpty(body.cloneFromRunId) || nonEmpty(body.rescueFromRunId)) return;
		for (const key of ["agent", "project", "prompt"] as const) {
			if (!nonEmpty(body[key])) {
				ctx.addIssue({ code: "custom", path: [key], message: "required" });
			}
		}
	});

const createProjectBody = z.strictObject({
	gitUrl: z.string().min(1),
	defaultBranch: optString,
});

const createPlanRunBody = z
	.strictObject({
		project: z.string().min(1),
		agent: z.string().min(1),
		planId: optString,
		issues: z.array(z.string()).nullish(),
		promptTemplate: optString,
		ref: optString,
		providerOverride: optString,
		modelOverride: optString,
		maxCostUsd: positive,
		dispatcherHandle: optString,
	})
	.superRefine((body, ctx) => {
		const hasPlan = nonEmpty(body.planId);
		const hasIssues = Array.isArray(body.issues);
		if (hasPlan === hasIssues) {
			ctx.addIssue({
				code: "custom",
				path: ["planId"],
				message: "exactly one of planId or issues",
			});
		}
	});

const listRunsResponse = z.strictObject({
	runs: z.array(runSchema),
	total: z.number().int(),
	limit: z.number().int(),
	offset: z.number().int(),
	costTotalUsd: z.number().nullable().optional(),
	costPricedCount: z.number().int(),
});

const runEnvelope = z.strictObject({ run: runSchema });
const createRunResponse = z.strictObject({ run: runSchema, sandbox: sandboxSchema });
const projectListResponse = z.strictObject({ projects: z.array(projectSchema) });
const agentListResponse = z.strictObject({ agents: z.array(agentSchema) });
const planRunListResponse = z.strictObject({ planRuns: z.array(planRunSchema) });
const planRunCreateResponse = z.strictObject({
	planRun: planRunSchema,
	children: z.array(planRunChildSchema),
});
const planRunDetailResponse = z.strictObject({
	planRun: planRunSchema,
	children: z.array(planRunChildSchema),
	runs: z.array(runSchema),
});
const cancelPlanRunResponse = z.strictObject({
	planRun: planRunSchema,
	cancelledChild: z.strictObject({ childSeq: z.number().int(), runId: z.string() }).nullable(),
	alreadyTerminal: z.boolean(),
});

export const listRunsContract = defineRoute("GET", "/runs", {
	response: listRunsResponse,
	responseComponent: "ListRunsResponse",
});

export const createRunContract = defineRoute("POST", "/runs", {
	successStatus: 201,
	response: createRunResponse,
	responseComponent: "CreateRunResponse",
	body: createRunBody,
	bodyComponent: "CreateRunRequest",
	bodyDescription:
		"Dispatch a run. `agent`, `project`, and `prompt` are required unless `cloneFromRunId` or `rescueFromRunId` is set.",
});

export const getRunContract = defineRoute("GET", "/runs/:id", {
	response: runEnvelope,
	responseComponent: "GetRunResponse",
});

export const listProjectsContract = defineRoute("GET", "/projects", {
	response: projectListResponse,
	responseComponent: "ListProjectsResponse",
});

export const createProjectContract = defineRoute("POST", "/projects", {
	successStatus: 201,
	response: projectSchema,
	responseComponent: "Project",
	reuseResponse: true,
	body: createProjectBody,
	bodyComponent: "CreateProjectRequest",
});

export const getProjectContract = defineRoute("GET", "/projects/:id", {
	response: projectSchema,
	responseComponent: "Project",
	reuseResponse: true,
});

export const listAgentsContract = defineRoute("GET", "/agents", {
	response: agentListResponse,
	responseComponent: "ListAgentsResponse",
});

export const listPlanRunsContract = defineRoute("GET", "/plan-runs", {
	response: planRunListResponse,
	responseComponent: "ListPlanRunsResponse",
});

export const createPlanRunContract = defineRoute("POST", "/plan-runs", {
	successStatus: 201,
	response: planRunCreateResponse,
	responseComponent: "CreatePlanRunResponse",
	body: createPlanRunBody,
	bodyComponent: "CreatePlanRunRequest",
	bodyDescription: "Exactly one of `planId` or `issues` is required.",
});

export const getPlanRunContract = defineRoute("GET", "/plan-runs/:id", {
	response: planRunDetailResponse,
	responseComponent: "GetPlanRunDetailResponse",
});

export const cancelPlanRunContract = defineRoute("POST", "/plan-runs/:id/cancel", {
	response: cancelPlanRunResponse,
	responseComponent: "CancelPlanRunResponse",
	body: "none",
});

export const coreRouteContracts: readonly RouteContract[] = [
	listRunsContract,
	createRunContract,
	getRunContract,
	listProjectsContract,
	createProjectContract,
	getProjectContract,
	listAgentsContract,
	listPlanRunsContract,
	createPlanRunContract,
	getPlanRunContract,
	cancelPlanRunContract,
];

function nonEmpty(value: string | null | undefined): boolean {
	return typeof value === "string" && value.length > 0;
}
