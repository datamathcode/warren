import { describe, expect, test } from "bun:test";
import * as z from "zod";
import "./index.ts";
import { defineRoute, sanitizeJsonSchema } from "./registry.ts";

describe("defineRoute", () => {
	test("rejects a second schema for a route that already has one", () => {
		expect(() =>
			defineRoute("GET", "/projects", {
				response: z.object({}),
				responseComponent: "Project",
				reuseResponse: true,
			}),
		).toThrow("duplicate route schema for GET /projects");
	});

	test("rejects a body schema that has no component name", () => {
		expect(() =>
			defineRoute("POST", "/schemas-missing-body", {
				response: z.object({}),
				responseComponent: "Unused",
				reuseResponse: true,
				body: z.object({}),
			}),
		).toThrow("missing body component for POST /schemas-missing-body");
	});
});

describe("sanitizeJsonSchema", () => {
	test("turns a non-object into an empty schema and strips integer bounds", () => {
		expect(sanitizeJsonSchema(null)).toEqual({});
		expect(sanitizeJsonSchema([1])).toEqual({});
		expect(
			sanitizeJsonSchema({
				type: "integer",
				minimum: -9007199254740991,
				maximum: 9007199254740991,
				$id: "drop-me",
			}),
		).toEqual({ type: "integer" });
	});
});
