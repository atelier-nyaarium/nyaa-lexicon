// Domains: the values an input may take, as its declared type says, and the outcomes a simple test of it reaches.

import ts from "typescript";

////////////////////////////////
//  Interfaces & Types

export type Primitive = string | number | boolean | bigint | null | undefined;

type Tag = "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function";

/** One kind of value a domain holds. */
type Part =
	/** Anything: only truthy ones with `truthy`, only ones not null or undefined with `present`. */
	| { readonly kind: "any"; readonly truthy?: true; readonly present?: true }
	| { readonly kind: "value"; readonly value: Primitive }
	/** Every value of a primitive type; only its truthy ones with `truthy`. */
	| { readonly kind: "primitive"; readonly tag: "string" | "number" | "bigint"; readonly truthy?: true };

/**
 * Every value something may be, each one possible: an input over its declared type, a test that
 * goes either way, or a choice between such.
 */
export type Domain = readonly Part[];

////////////////////////////////
//  Constants

/** Parts a domain keeps before the walk stops tracking it. */
const MAX_PARTS = 64;

const TAGS: readonly Tag[] = ["string", "number", "bigint", "boolean", "symbol", "undefined", "object", "function"];

/** A test that may come out either way. */
export const EITHER: Domain = [
	{ kind: "value", value: true },
	{ kind: "value", value: false },
];

////////////////////////////////
//  Functions & Helpers

/**
 * A declared type's values, where the type spells them exactly: anything, literals, booleans,
 * unrestricted strings, numbers and bigints, null and undefined, and unions of those. Undefined for
 * any other type, such as an object, a template literal, a string mapping or a branded intersection.
 */
export function domainOf(type: ts.Type, depth = 0): Domain | undefined {
	const flags = type.flags;
	if ((flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return [{ kind: "any" }];
	if (depth > 4) return undefined;
	if (type.isUnion()) {
		const parts: Part[] = [];
		for (const member of type.types) {
			const domain = domainOf(member, depth + 1);
			if (domain === undefined) return undefined;
			parts.push(...domain);
		}
		return parts.length > MAX_PARTS ? undefined : parts;
	}
	if ((flags & ts.TypeFlags.Never) !== 0) return [];
	if (type.isStringLiteral() || type.isNumberLiteral()) return [{ kind: "value", value: type.value }];
	if ((flags & ts.TypeFlags.BigIntLiteral) !== 0) {
		const { negative, base10Value } = (type as ts.BigIntLiteralType).value;
		return [{ kind: "value", value: (negative ? -1n : 1n) * BigInt(base10Value) }];
	}
	if ((flags & ts.TypeFlags.BooleanLiteral) !== 0)
		return [{ kind: "value", value: (type as { intrinsicName?: string }).intrinsicName === "true" }];
	if ((flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return [{ kind: "value", value: undefined }];
	if ((flags & ts.TypeFlags.Null) !== 0) return [{ kind: "value", value: null }];
	if ((flags & ts.TypeFlags.Boolean) !== 0) return EITHER;
	if ((flags & ts.TypeFlags.String) !== 0) return [{ kind: "primitive", tag: "string" }];
	if ((flags & ts.TypeFlags.Number) !== 0) return [{ kind: "primitive", tag: "number" }];
	if ((flags & ts.TypeFlags.BigInt) !== 0) return [{ kind: "primitive", tag: "bigint" }];
	return undefined;
}

/** Whether a value of the domain may be truthy, and may be falsy; undefined where both may. */
export function onlyTruthy(domain: Domain): boolean | undefined {
	const truthy = canTruthy(domain);
	const falsy = canFalsy(domain);
	return truthy === falsy ? undefined : truthy;
}

/** Just one value. */
export function exactly(value: Primitive): Domain {
	return [{ kind: "value", value }];
}

/** Either domain's values; undefined past the size the walk keeps. */
export function union(a: Domain, b: Domain): Domain | undefined {
	return a.length + b.length > MAX_PARTS ? undefined : [...a, ...b];
}

/** Whether the value may be `value`. */
export function can(domain: Domain, value: Primitive): boolean {
	return domain.some((part) => {
		if (part.kind === "value") return part.value === value;
		const kind = part.kind === "any" || typeof value === part.tag;
		const present = part.kind !== "any" || part.present !== true || value != null;
		return kind && present && (part.truthy !== true || Boolean(value));
	});
}

/** Whether the value may be other than `value`. */
export function canOther(domain: Domain, value: Primitive): boolean {
	return canOtherThan(domain, [value]);
}

/** Whether every value in a domain is an explicit literal. */
export function isFiniteDomain(domain: Domain): boolean {
	return domain.every((part) => part.kind === "value");
}

/** A domain after one literal failed to match. */
export function exclude(domain: Domain, value: Primitive): Domain {
	return domain.flatMap((part): Part[] => {
		if (part.kind === "value") return part.value === value ? [] : [part];
		return part.kind === "any" || typeof value === part.tag ? [part] : [part];
	});
}

/** Whether the value may be none of `values`. */
export function canOtherThan(domain: Domain, values: readonly Primitive[]): boolean {
	return domain.some((part) => (part.kind === "value" ? !values.includes(part.value) : true));
}

export function canTruthy(domain: Domain): boolean {
	return domain.some((part) => (part.kind === "value" ? Boolean(part.value) : true));
}

export function canFalsy(domain: Domain): boolean {
	return domain.some((part) => (part.kind === "value" ? !part.value : part.truthy !== true));
}

/** Whether a truthiness test of the value goes either way. */
export function eitherWay(domain: Domain): boolean {
	return canTruthy(domain) && canFalsy(domain);
}

/** Whether a test for null or undefined goes either way. */
export function eitherPresent(domain: Domain): boolean {
	return canNullish(domain) && canPresent(domain);
}

export function canNullish(domain: Domain): boolean {
	return domain.some((part) =>
		part.kind === "any"
			? part.truthy !== true && part.present !== true
			: part.kind === "value" && part.value == null,
	);
}

export function canPresent(domain: Domain): boolean {
	return domain.some((part) => part.kind !== "value" || part.value != null);
}

/** What `typeof` gives on a value of the domain. */
export function tagsOf(domain: Domain): Domain {
	const tags = new Set<Tag>();
	for (const part of domain) {
		if (part.kind === "any") {
			const defined = part.present === true || part.truthy === true;
			for (const tag of TAGS) if (tag !== "undefined" || !defined) tags.add(tag);
		} else if (part.kind === "value") tags.add(part.value === null ? "object" : (typeof part.value as Tag));
		else tags.add(part.tag);
	}
	return [...tags].map((tag) => ({ kind: "value", value: tag }));
}

/** The domain's values a truthiness test let through. */
export function narrowTruthy(domain: Domain, truthy: boolean): Domain {
	return domain.flatMap((part): Part[] => {
		if (part.kind === "value") return Boolean(part.value) === truthy ? [part] : [];
		if (truthy) return [{ ...part, truthy: true }];
		if (part.truthy === true) return [];
		const falsy =
			part.kind === "any"
				? ["", 0, Number.NaN, 0n, false, ...(part.present === true ? [] : [null, undefined])]
				: part.tag === "string"
					? [""]
					: part.tag === "number"
						? [0, Number.NaN]
						: [0n];
		return falsy.map((value) => ({ kind: "value", value }));
	});
}

/** The domain's values other than null and undefined. */
export function narrowPresent(domain: Domain): Domain {
	return domain.flatMap((part): Part[] => {
		if (part.kind === "any") return [{ ...part, present: true }];
		return part.kind === "value" && part.value == null ? [] : [part];
	});
}
