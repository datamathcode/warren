/**
 * Zod schemas that own the OpenAPI document and the request-body check.
 *
 * A schema is published once, under a component name. `z.toJSONSchema`
 * then emits `$ref: #/components/schemas/<name>` for every reuse, which
 * is the OpenAPI 3.1 shape. Route modules call `defineRoute` at import
 * time; `src/server/schemas/index.ts` imports those modules so the
 * registry is full before the generator or the request gate reads it.
 */

import * as z from "zod";

export type JsonSchema = Record<string, unknown>;

const componentRegistry = z.registry<{ id: string; description?: string }>();

const routes = new Map<string, RouteContract>();

export interface RouteContract {
	readonly key: string;
	readonly successStatus: number;
	readonly response: z.ZodType;
	readonly responseComponent: string;
	/** A Zod schema, `"none"` when the route takes no JSON body, or omitted for reads. */
	readonly body?: z.ZodType | "none";
	readonly bodyComponent?: string;
	/** Success media type. JSON when omitted. */
	readonly contentType?: string;
}

/** Publish `schema` as a named component. Returns the tagged schema to compose with. */
export function publish(id: string, schema: z.ZodType, description?: string): z.ZodType {
	const meta = description === undefined ? { id } : { id, description };
	const tagged = schema.meta(meta);
	componentRegistry.add(tagged, meta);
	return tagged;
}

export function defineRoute(
	method: string,
	pattern: string,
	input: {
		readonly successStatus?: number;
		readonly response: z.ZodType;
		readonly responseComponent: string;
		readonly responseDescription?: string;
		/** The response schema is already a published component (for example `Project`). */
		readonly reuseResponse?: boolean;
		readonly body?: z.ZodType | "none";
		readonly bodyComponent?: string;
		readonly bodyDescription?: string;
		readonly contentType?: string;
	},
): RouteContract {
	const key = `${method} ${pattern}`;
	if (routes.has(key)) {
		throw new Error(`duplicate route schema for ${key}`);
	}
	const response = input.reuseResponse
		? input.response
		: publish(input.responseComponent, input.response, input.responseDescription);
	let body = input.body;
	let bodyComponent: string | undefined;
	if (body !== undefined && body !== "none") {
		if (input.bodyComponent === undefined) {
			throw new Error(`missing body component for ${key}`);
		}
		bodyComponent = input.bodyComponent;
		body = publish(bodyComponent, body, input.bodyDescription);
	}
	const contract: RouteContract = {
		key,
		successStatus: input.successStatus ?? 200,
		response,
		responseComponent: input.responseComponent,
		...(body !== undefined ? { body } : {}),
		...(bodyComponent !== undefined ? { bodyComponent } : {}),
		...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
	};
	routes.set(key, contract);
	return contract;
}

export function routeContract(method: string, pattern: string): RouteContract | undefined {
	return routes.get(`${method} ${pattern}`);
}

export function definedRouteContracts(): readonly RouteContract[] {
	return [...routes.values()];
}

export function componentRef(name: string): JsonSchema {
	return { $ref: `#/components/schemas/${name}` };
}

/** Component schemas for `docs/openapi.yaml`, keyed by component name. */
export function openApiComponents(): Record<string, JsonSchema> {
	const generated = z.toJSONSchema(componentRegistry, {
		target: "draft-2020-12",
		unrepresentable: "any",
		uri: (id) => `#/components/schemas/${id}`,
	});
	const out: Record<string, JsonSchema> = {};
	for (const name of Object.keys(generated.schemas).sort()) {
		const schema = generated.schemas[name];
		if (schema !== undefined) out[name] = sanitizeJsonSchema(schema);
	}
	return out;
}

const SAFE_INT_MIN = -9007199254740991;
const SAFE_INT_MAX = 9007199254740991;

/**
 * Drop Zod's JSON Schema bookkeeping so the document stays OpenAPI 3.1.
 * The safe-integer bounds Zod adds to every `integer` are noise next to
 * the previous hand-written schemas and do not change the contract.
 */
export function sanitizeJsonSchema(value: unknown): JsonSchema {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (key === "~standard" || key === "$schema" || key === "$id") continue;
		out[key] = sanitizeNode(child);
	}
	if (out.type === "integer" && out.minimum === SAFE_INT_MIN && out.maximum === SAFE_INT_MAX) {
		delete out.minimum;
		delete out.maximum;
	}
	return out;
}

function sanitizeNode(child: unknown): unknown {
	if (Array.isArray(child)) return child.map((item) => sanitizeNode(item));
	if (child !== null && typeof child === "object") return sanitizeJsonSchema(child);
	return child;
}
