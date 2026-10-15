/**
 * Batch 3 — run and plan-run write routes.
 *
 * Finalize and salvage bodies are loose objects: the pod parsers ignore
 * unknown keys and default omitted optional fields. A strict object would
 * reject a body the handler accepts.
 */

import * as z from "zod";
import { INBOX_PRIORITIES, SALVAGE_TRIGGERS } from "../../core/wire.ts";
import { RESUMABLE_PLAN_RUN_FAILURE_REASONS } from "../../plan-runs/resume.ts";
import { isFinalizeStage } from "../../runtime/finalize-stages.ts";
import {
	inboxMessageSchema,
	planRunSchema,
	previewStateSchema,
	runStateSchema,
} from "./components.ts";
import { defineRoute, type RouteContract } from "./registry.ts";

const finalizeOutcomes = ["accepted", "duplicate", "stale", "unknown"] as const;
const teardownStatuses = [
	"torn-down",
	"already-torn-down",
	"already-failed",
	"never-launched",
] as const;

const artifactFile = z.looseObject({
	path: z.string().min(1),
	mergedBody: z.string(),
});

const artifactDelta = z.looseObject({
	files: z.array(artifactFile),
	counts: z.record(z.string(), z.number().int().nonnegative()).optional(),
});

const finalizeResult = z.looseObject({
	pushed: z.boolean(),
	commitsAhead: z.number().nullable(),
	commitsAheadBase: z.string().nullable().optional(),
	emptyPush: z.boolean(),
	dirty: z.boolean(),
	dirtyPaths: z.array(z.string()).optional(),
	workspacePlansBody: z.string().nullable().optional(),
	events: z.array(
		z.looseObject({
			kind: z.string().min(1),
			payload: z.unknown().optional(),
		}),
	),
	artifacts: z.record(z.string(), artifactDelta).optional(),
	prBranch: z.string().nullable().optional(),
	stages: z.array(
		z.looseObject({
			stage: z.string().min(1).refine(isFinalizeStage),
			status: z.enum(["ok", "skipped", "failed"]),
			error: z.string().optional(),
		}),
	),
});

const finalizeResultRoute = defineRoute("POST", "/runs/:id/finalize-result", {
	response: z.strictObject({ outcome: z.enum(finalizeOutcomes) }),
	responseComponent: "FinalizeResultResponse",
	body: z.looseObject({
		version: z.literal(1),
		attemptId: z.string().min(1),
		result: finalizeResult,
	}),
	bodyComponent: "FinalizeResultRequest",
	bodyDescription: "In-pod finalize envelope. Unknown keys are ignored. Version is 1.",
});

const salvage = defineRoute("POST", "/runs/:id/salvage", {
	response: z.strictObject({
		stored: z.boolean(),
		rescueRef: z.string().nullable(),
	}),
	responseComponent: "SalvageResponse",
	body: z.looseObject({
		version: z.literal(1),
		trigger: z.enum(SALVAGE_TRIGGERS),
		rescueRef: z.string().nullable().optional(),
		bundleBase64: z.string().nullable().optional(),
		branch: z.string().nullable().optional(),
		baseBranch: z.string().nullable().optional(),
		notes: z.array(z.string()).optional(),
	}),
	bodyComponent: "SalvageRequest",
	bodyDescription: "In-pod salvage envelope. Unknown keys are ignored. Version is 1.",
});

const gitCredential = defineRoute("POST", "/runs/:id/git-credential", {
	response: z.strictObject({ gitToken: z.string().nullable() }),
	responseComponent: "GitCredentialResponse",
	responseDescription: "A freshly minted git credential, or null when the forge mints anonymously.",
	body: "none",
});

const steer = defineRoute("POST", "/runs/:id/steer", {
	response: z.strictObject({ message: inboxMessageSchema }),
	responseComponent: "SteerRunResponse",
	body: z.strictObject({
		body: z.string().min(1),
		priority: z.enum(INBOX_PRIORITIES).optional(),
		fromActor: z.string().optional(),
	}),
	bodyComponent: "SteerRunRequest",
});

const cancelRun = defineRoute("POST", "/runs/:id/cancel", {
	response: z.strictObject({
		state: runStateSchema,
		alreadyTerminal: z.boolean(),
		sandboxRun: z
			.strictObject({
				id: z.string(),
				state: runStateSchema,
			})
			.nullable(),
	}),
	responseComponent: "CancelRunResponse",
	body: z.strictObject({ reason: z.string().optional() }),
	bodyComponent: "CancelRunRequest",
	bodyRequired: false,
});

const previewLogin = defineRoute("POST", "/runs/:id/preview/login", {
	response: z.strictObject({ url: z.string() }),
	responseComponent: "PreviewLoginResponse",
	body: z.strictObject({ redirect: z.string().optional() }),
	bodyComponent: "PreviewLoginRequest",
	bodyRequired: false,
});

const previewTeardown = defineRoute("POST", "/runs/:id/preview/teardown", {
	response: z.strictObject({
		status: z.enum(teardownStatuses),
		tornDown: z.boolean(),
		previousState: previewStateSchema.nullable(),
		port: z.number().int().nullable(),
	}),
	responseComponent: "PreviewTeardownResponse",
	body: z.strictObject({ actor: z.string().optional() }),
	bodyComponent: "PreviewTeardownRequest",
	bodyRequired: false,
});

const resumePlanRun = defineRoute("POST", "/plan-runs/:id/resume", {
	response: z.strictObject({
		planRun: planRunSchema,
		reason: z.enum(RESUMABLE_PLAN_RUN_FAILURE_REASONS),
		resumedChild: z
			.strictObject({
				seq: z.number().int(),
				runId: z.string().nullable(),
			})
			.nullable(),
	}),
	responseComponent: "ResumePlanRunResponse",
	body: "none",
});

export const runWriteContracts: readonly RouteContract[] = [
	finalizeResultRoute,
	salvage,
	gitCredential,
	steer,
	cancelRun,
	previewLogin,
	previewTeardown,
	resumePlanRun,
];
