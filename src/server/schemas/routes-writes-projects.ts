/**
 * Batch 3 — project write routes and the heal alert intake.
 * Optional bodies (`bodyRequired: false`) match `readJsonBodyOrEmpty`:
 * an empty body parses as `{}`.
 */

import * as z from "zod";
import { projectSchema } from "./components.ts";
import { defineRoute, type RouteContract } from "./registry.ts";
import { createRunContract } from "./routes-core.ts";

const healSource = z.enum(["sentry", "grafana"]);

const healAlert = defineRoute("POST", "/alerts/heal", {
	response: z.discriminatedUnion("status", [
		z.strictObject({
			status: z.literal("skipped"),
			reason: z.string(),
			fingerprint: z.string(),
			source: healSource,
		}),
		z.strictObject({
			status: z.literal("dispatched"),
			runId: z.string(),
			fingerprint: z.string(),
			projectId: z.string(),
			source: healSource,
		}),
	]),
	responseComponent: "HealAlertResponse",
	responseDescription:
		"200 when the alert is skipped. 202 when a healer run is dispatched. Both use this body.",
	alsoSuccessStatuses: [202],
	body: z.looseObject({}),
	bodyComponent: "HealAlertRequest",
	bodyDescription: "Webhook JSON. The source query parameter selects sentry or grafana.",
});

const runProjectTrigger = defineRoute("POST", "/projects/:id/triggers/:triggerId/run", {
	successStatus: 201,
	response: createRunContract.response,
	responseComponent: "CreateRunResponse",
	reuseResponse: true,
	body: "none",
});

const refreshProject = defineRoute("POST", "/projects/:id/refresh", {
	response: z.strictObject({
		project: projectSchema,
		headSha: z.string(),
		ref: z.string(),
	}),
	responseComponent: "RefreshProjectResponse",
	body: z.strictObject({ ref: z.string().optional() }),
	bodyComponent: "RefreshProjectRequest",
	bodyDescription: "Optional. `ref` overrides the project's default branch.",
	bodyRequired: false,
});

const initProject = defineRoute("POST", "/projects/:id/init", {
	successStatus: 201,
	response: z.strictObject({
		projectId: z.string(),
		scaffolded: z.strictObject({
			files: z.array(z.string()),
			defaultRole: z.string().nullable(),
		}),
	}),
	responseComponent: "InitProjectResponse",
	body: z.strictObject({
		defaultRole: z.string().optional(),
		defaultPrompt: z.string().optional(),
		defaultProvider: z.string().optional(),
		defaultModel: z.string().optional(),
		defaultBranch: z.string().optional(),
		runBranchPrefix: z.string().optional(),
		overwrite: z.boolean().optional(),
	}),
	bodyComponent: "InitProjectRequest",
	bodyDescription: "Optional scaffold defaults. An empty body writes an empty defaults block.",
	bodyRequired: false,
});

const configMigrate = defineRoute("POST", "/projects/:id/config-migrate", {
	response: z.strictObject({
		projectId: z.string(),
		migrated: z.strictObject({
			written: z.array(z.string()),
			previewHoisted: z.boolean(),
		}),
	}),
	responseComponent: "ConfigMigrateResponse",
	body: "none",
});

const deleteProject = defineRoute("DELETE", "/projects/:id", {
	response: projectSchema,
	responseComponent: "Project",
	reuseResponse: true,
	body: "none",
});

export const projectWriteContracts: readonly RouteContract[] = [
	healAlert,
	runProjectTrigger,
	refreshProject,
	initProject,
	configMigrate,
	deleteProject,
];
