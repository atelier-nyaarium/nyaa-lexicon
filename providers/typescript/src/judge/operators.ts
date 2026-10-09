// Operators: their operands converted as the language does, then what each folds to.

import ts from "typescript";
import { converts, toPrimitive } from "./conversions.js";
import { can, canNullish, canOther, canPresent, EITHER, eitherPresent, eitherWay } from "./domains.js";
import { writeMember } from "./members.js";
import { inOperator, instanceOf } from "./membership.js";
import {
	EXACT,
	type Flow,
	type Frame,
	isNullish,
	isObject,
	joinValues,
	literal,
	MAX_BITS,
	MAX_TEXT,
	provOf,
	strictEquals,
	truthiness,
	UNKNOWN,
	underGuards,
	VARIES,
	type Value,
	withPresence,
	withProv,
	withTruthiness,
} from "./model.js";
import { isStrict, unwrapExpression } from "./symbols.js";
import type { Step, Walker } from "./walker.js";

////////////////////////////////
//  Constants

const ARITHMETIC = new Set([
	ts.SyntaxKind.PlusToken,
	ts.SyntaxKind.MinusToken,
	ts.SyntaxKind.AsteriskToken,
	ts.SyntaxKind.SlashToken,
	ts.SyntaxKind.PercentToken,
	ts.SyntaxKind.AsteriskAsteriskToken,
	ts.SyntaxKind.LessThanToken,
	ts.SyntaxKind.GreaterThanToken,
	ts.SyntaxKind.LessThanEqualsToken,
	ts.SyntaxKind.GreaterThanEqualsToken,
	ts.SyntaxKind.AmpersandToken,
	ts.SyntaxKind.BarToken,
	ts.SyntaxKind.CaretToken,
	ts.SyntaxKind.LessThanLessThanToken,
	ts.SyntaxKind.GreaterThanGreaterThanToken,
	ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
]);

const STRICT = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);

/** Compound assignments and the operator each applies. */
const COMPOUND = new Map<ts.SyntaxKind, ts.SyntaxKind>([
	[ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.PlusToken],
	[ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.MinusToken],
	[ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.AsteriskToken],
	[ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.SlashToken],
	[ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.PercentToken],
	[ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.AsteriskAsteriskToken],
	[ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.AmpersandToken],
	[ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.BarToken],
	[ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.CaretToken],
	[ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.LessThanLessThanToken],
	[ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanToken],
	[ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken],
]);

const LOGICAL = new Set([
	ts.SyntaxKind.AmpersandAmpersandToken,
	ts.SyntaxKind.BarBarToken,
	ts.SyntaxKind.QuestionQuestionToken,
]);

const LOGICAL_ASSIGNMENT = new Map<ts.SyntaxKind, ts.SyntaxKind>([
	[ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.AmpersandAmpersandToken],
	[ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.BarBarToken],
	[ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.QuestionQuestionToken],
]);

////////////////////////////////
//  Functions & Helpers

/** Whether a value is known not to be null or undefined. */
function present(value: Value): boolean | undefined {
	if (value.kind !== "unknown") return !isNullish(value);
	if (value.truthy === true) return true;
	// A domain all of one presence decides it.
	if (value.domain === undefined || canNullish(value.domain) === canPresent(value.domain)) return undefined;
	return canPresent(value.domain);
}

/** Equality operators, and whether each answers true on equal operands. */
const EQUALITY = new Map<ts.SyntaxKind, boolean>([
	[ts.SyntaxKind.EqualsEqualsEqualsToken, true],
	[ts.SyntaxKind.ExclamationEqualsEqualsToken, false],
	[ts.SyntaxKind.EqualsEqualsToken, true],
	[ts.SyntaxKind.ExclamationEqualsToken, false],
]);

/**
 * A binary operator as the language computes it, or "throws" where it throws. Objects compare by
 * identity; a result the walk cannot compute varies with an unknown operand, else is unknown.
 */
function fold(operator: ts.SyntaxKind, left: Value, right: Value): Value | "throws" {
	if (left.kind !== "literal" || right.kind !== "literal") {
		const equal = EQUALITY.get(operator);
		const same = equal === undefined ? undefined : strictEquals(left, right);
		if (same !== undefined) return literal(same === equal);
		return left.kind === "unknown" || right.kind === "unknown" ? VARIES : UNKNOWN;
	}
	const a = left.value as never;
	const b = right.value as never;
	if (costly(operator, left.value, right.value)) return UNKNOWN;
	try {
		switch (operator) {
			case ts.SyntaxKind.EqualsEqualsEqualsToken:
				return literal(a === b);
			case ts.SyntaxKind.ExclamationEqualsEqualsToken:
				return literal(a !== b);
			case ts.SyntaxKind.EqualsEqualsToken:
				// biome-ignore lint/suspicious/noDoubleEquals: folding the language's own loose equality
				return literal(a == b);
			case ts.SyntaxKind.ExclamationEqualsToken:
				// biome-ignore lint/suspicious/noDoubleEquals: folding the language's own loose equality
				return literal(a != b);
			case ts.SyntaxKind.PlusToken:
				return literal((a as string) + (b as string));
			case ts.SyntaxKind.MinusToken:
				return literal((a as number) - (b as number));
			case ts.SyntaxKind.AsteriskToken:
				return literal((a as number) * (b as number));
			case ts.SyntaxKind.SlashToken:
				return literal((a as number) / (b as number));
			case ts.SyntaxKind.PercentToken:
				return literal((a as number) % (b as number));
			case ts.SyntaxKind.AsteriskAsteriskToken:
				return literal((a as number) ** (b as number));
			case ts.SyntaxKind.AmpersandToken:
				return literal((a as number) & (b as number));
			case ts.SyntaxKind.BarToken:
				return literal((a as number) | (b as number));
			case ts.SyntaxKind.CaretToken:
				return literal((a as number) ^ (b as number));
			case ts.SyntaxKind.LessThanLessThanToken:
				return literal((a as number) << (b as number));
			case ts.SyntaxKind.GreaterThanGreaterThanToken:
				return literal((a as number) >> (b as number));
			case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
				return literal((a as number) >>> (b as number));
			case ts.SyntaxKind.LessThanToken:
				return literal(a < b);
			case ts.SyntaxKind.GreaterThanToken:
				return literal(a > b);
			case ts.SyntaxKind.LessThanEqualsToken:
				return literal(a <= b);
			case ts.SyntaxKind.GreaterThanEqualsToken:
				return literal(a >= b);
			default:
				return UNKNOWN;
		}
	} catch (error) {
		// Mixing a bigint with a number, a bigint division by zero or a negative bigint exponent. Any
		// other range error is the host's size limit, which the language does not set.
		const divides = operator === ts.SyntaxKind.SlashToken || operator === ts.SyntaxKind.PercentToken;
		const power = operator === ts.SyntaxKind.AsteriskAsteriskToken;
		const spec =
			!(error instanceof RangeError) || (divides && b === 0n) || (power && typeof b === "bigint" && b < 0n);
		return spec ? "throws" : UNKNOWN;
	}
}

type Literal = string | number | boolean | bigint | null | undefined;

/** Whether a fold's result would outgrow what the walk computes: a long string or a large bigint. */
function costly(operator: ts.SyntaxKind, a: Literal, b: Literal): boolean {
	if (operator === ts.SyntaxKind.PlusToken && (typeof a === "string" || typeof b === "string"))
		return String(a).length + String(b).length > MAX_TEXT;
	if (typeof a !== "bigint" || typeof b !== "bigint") return false;
	const bits = (value: bigint) => (value < 0n ? -value : value).toString(2).length;
	switch (operator) {
		case ts.SyntaxKind.AsteriskAsteriskToken:
			return b > 0n && bits(a) > 1 && BigInt(bits(a)) * b > BigInt(MAX_BITS);
		case ts.SyntaxKind.AsteriskToken:
			return bits(a) + bits(b) > MAX_BITS;
		case ts.SyntaxKind.LessThanLessThanToken:
			return b > 0n && BigInt(bits(a)) + b > BigInt(MAX_BITS);
		default:
			return false;
	}
}

/** A unary operator on a literal, as the language computes it, or "throws" where it throws. */
function foldUnary(operator: ts.SyntaxKind, operand: Value): Value | "throws" {
	if (operand.kind !== "literal") return VARIES;
	const value = operand.value as never;
	try {
		switch (operator) {
			case ts.SyntaxKind.PlusToken:
				return literal(+value);
			case ts.SyntaxKind.MinusToken:
				return literal(-value);
			case ts.SyntaxKind.TildeToken:
				return literal(~value);
			default:
				return UNKNOWN;
		}
	} catch {
		// `+` on a bigint.
		return "throws";
	}
}

/** A folded result, or a throw completion where the operation throws. */
function settle(w: Walker, folded: Value | "throws", flow: Flow): Value {
	if (folded !== "throws") return folded;
	w.throwExit(flow, false);
	return UNKNOWN;
}

////////////////////////////////
//  Operators

function isLoose(operator: ts.SyntaxKind): boolean {
	return operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken;
}

/** The operands as an arithmetic operator or a loose comparison converts them, left first. */
function* convertOperands(
	w: Walker,
	operator: ts.SyntaxKind,
	left: Value,
	right: Value,
	node: ts.BinaryExpression,
	frame: Frame,
	flow: Flow,
): Step<[Value, Value]> {
	if (isLoose(operator)) {
		// `==` converts an object only beside a primitive other than null or undefined.
		const a = isObject(left);
		const b = isObject(right);
		if (isNullish(left) || isNullish(right) || (a === true && b === true)) return [left, right];
		if (a === true && b === false) return [yield* toPrimitive(w, left, "default", node.left, frame, flow), right];
		if (b === true && a === false) return [left, yield* toPrimitive(w, right, "default", node.right, frame, flow)];
		// Whether a side converts depends on what an unknown one turns out to be.
		if (converts(w, left, node.left) || converts(w, right, node.right)) w.unseen(node);
		return [left, right];
	}
	const hint = operator === ts.SyntaxKind.PlusToken ? "default" : "number";
	const a = yield* toPrimitive(w, left, hint, node.left, frame, flow);
	if (!flow.alive) return [a, right];
	return [a, yield* toPrimitive(w, right, hint, node.right, frame, flow)];
}

/** A folded result, depending on everything its operands and their conversions came from. */
function folded(w: Walker, operator: ts.SyntaxKind, operands: readonly Value[], flow: Flow): Value {
	const [a = UNKNOWN, b = UNKNOWN] = operands.slice(-2);
	const value = settle(w, fold(operator, a, b), flow);
	return tested(
		operator,
		a,
		b,
		operands.reduce((result, operand) => withProv(result, provOf(operand)), value),
	);
}

/**
 * `x === literal`, `x !== literal` or `x == null` on an input: a simple test. Where the input's
 * domain admits one outcome it decides it; where both, it goes either way. Any other result stays as
 * unknown as it was.
 */
function tested(operator: ts.SyntaxKind, left: Value, right: Value, result: Value): Value {
	const equal = EQUALITY.get(operator);
	if (result.kind !== "unknown" || equal === undefined) return result;
	const [operand, other] = left.kind === "literal" ? [right, left] : [left, right];
	if (operand.kind !== "unknown" || operand.domain === undefined || other.kind !== "literal") return result;
	if (isLoose(operator) && !isNullish(other)) return result;
	const same = isLoose(operator) ? canNullish(operand.domain) : can(operand.domain, other.value);
	const differs = isLoose(operator) ? canPresent(operand.domain) : canOther(operand.domain, other.value);
	if (same && differs) return { ...result, domain: EITHER };
	return same === differs ? result : withProv(literal(same === equal), provOf(result));
}

export function* binary(w: Walker, node: ts.BinaryExpression, frame: Frame, flow: Flow): Step<Value> {
	const operator = node.operatorToken.kind;
	if (operator === ts.SyntaxKind.EqualsToken) return yield* assign(w, node, frame, flow);
	const compound = COMPOUND.get(operator);
	if (compound !== undefined) {
		const left = yield* w.expr(node.left, frame, flow);
		const right = yield* w.expr(node.right, frame, flow);
		if (!flow.alive) return UNKNOWN;
		const [a, b] = yield* convertOperands(w, compound, left, right, node, frame, flow);
		if (!flow.alive) return UNKNOWN;
		if (a.kind !== "literal" || b.kind !== "literal") w.mayThrow(flow);
		const value = folded(w, compound, [left, right, a, b], flow);
		if (flow.alive) yield* w.assignTo(node.left, value, frame, flow);
		return value;
	}
	const logicalAssignment = LOGICAL_ASSIGNMENT.get(operator);
	if (logicalAssignment !== undefined) return yield* logical(w, node, logicalAssignment, frame, flow, true);
	if (LOGICAL.has(operator)) return yield* logical(w, node, operator, frame, flow, false);
	// `#field in object` tests a private brand; its left side is no expression.
	const left = ts.isPrivateIdentifier(node.left) ? UNKNOWN : yield* w.expr(node.left, frame, flow);
	if (operator === ts.SyntaxKind.CommaToken) return yield* w.expr(node.right, frame, flow);
	const right = yield* w.expr(node.right, frame, flow);
	if (!flow.alive) return UNKNOWN;
	if (STRICT.has(operator)) return tested(operator, left, right, settle(w, fold(operator, left, right), flow));
	if (operator === ts.SyntaxKind.InstanceOfKeyword) return yield* instanceOf(w, node, left, right, frame, flow);
	if (operator === ts.SyntaxKind.InKeyword) return yield* inOperator(w, node, left, right, frame, flow);
	if (!ARITHMETIC.has(operator)) return settle(w, fold(operator, left, right), flow);
	const [a, b] = yield* convertOperands(w, operator, left, right, node, frame, flow);
	if (!flow.alive) return UNKNOWN;
	// A conversion may throw: a symbol, or a bigint beside a number.
	if (!isLoose(operator) && (a.kind !== "literal" || b.kind !== "literal")) w.mayThrow(flow);
	return folded(w, operator, [a, b], flow);
}

/** `&&`, `||` and `??`, and their assignments: the right side runs only on one outcome of the left. */
function* logical(
	w: Walker,
	node: ts.BinaryExpression,
	operator: ts.SyntaxKind,
	frame: Frame,
	flow: Flow,
	assigns: boolean,
): Step<Value> {
	const left = yield* w.expr(node.left, frame, flow);
	if (!flow.alive) return UNKNOWN;
	const decided =
		operator === ts.SyntaxKind.QuestionQuestionToken
			? present(left) === undefined
				? undefined
				: !present(left)
			: truthiness(left) === undefined
				? undefined
				: operator === ts.SyntaxKind.AmpersandAmpersandToken
					? truthiness(left)
					: !truthiness(left);
	if (decided === false) return left;
	if (decided === true) {
		const right = yield* w.expr(node.right, frame, flow);
		if (assigns && flow.alive) yield* w.assignTo(node.left, right, frame, flow);
		return right;
	}
	const base = [...flow.guards];
	const nullish = operator === ts.SyntaxKind.QuestionQuestionToken;
	const guard = w.guard(left, node.left, flow, nullish ? eitherPresent : eitherWay);
	const inner = w.branch(flow, guard);
	const right = yield* w.expr(node.right, frame, inner);
	if (assigns && inner.alive) yield* w.assignTo(node.left, right, frame, inner);
	w.join(flow, base, [inner], true);
	// The left is the value only where it skipped the right: present for `??`, falsy for `&&`, truthy for `||`.
	const kept = nullish ? withPresence(left) : withTruthiness(left, operator === ts.SyntaxKind.BarBarToken);
	if (!inner.alive) return kept;
	return joinValues(kept, underGuards(right, [guard]));
}

function* assign(w: Walker, node: ts.BinaryExpression, frame: Frame, flow: Flow): Step<Value> {
	const target = unwrapExpression(node.left);
	if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target) || ts.isIdentifier(target)) {
		const value = yield* w.expr(node.right, frame, flow);
		if (flow.alive) yield* w.assignTo(target, value, frame, flow);
		return value;
	}
	if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
		const receiver = yield* w.expr(target.expression, frame, flow);
		const key = ts.isPropertyAccessExpression(target)
			? target.name.text
			: yield* w.keyOf(target.argumentExpression, frame, flow);
		const value = yield* w.expr(node.right, frame, flow);
		if (flow.alive) yield* writeMember(w, receiver, key, value, target, frame, flow);
		return value;
	}
	w.note(node);
	return yield* w.expr(node.right, frame, flow);
}

export function* unary(
	w: Walker,
	node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
	frame: Frame,
	flow: Flow,
): Step<Value> {
	const value = yield* w.expr(node.operand, frame, flow);
	if (!flow.alive) return UNKNOWN;
	switch (node.operator) {
		case ts.SyntaxKind.ExclamationToken: {
			const truth = truthiness(value);
			if (truth !== undefined) return literal(!truth);
			// Negating a simple test of an input is one too.
			const either = value.kind === "unknown" && value.domain !== undefined && eitherWay(value.domain);
			return either ? { kind: "unknown", prov: EXACT, domain: EITHER } : VARIES;
		}
		case ts.SyntaxKind.PlusPlusToken:
		case ts.SyntaxKind.MinusMinusToken: {
			const number = yield* toPrimitive(w, value, "number", node.operand, frame, flow);
			if (!flow.alive) return UNKNOWN;
			if (number.kind !== "literal") w.mayThrow(flow);
			const [before, after] = stepped(number, node.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1);
			const next = withProv(withProv(after, provOf(value)), provOf(number));
			yield* w.assignTo(node.operand, next, frame, flow);
			return ts.isPrefixUnaryExpression(node) ? next : withProv(before, provOf(next));
		}
		case ts.SyntaxKind.PlusToken:
		case ts.SyntaxKind.MinusToken:
		case ts.SyntaxKind.TildeToken: {
			const number = yield* toPrimitive(w, value, "number", node.operand, frame, flow);
			if (!flow.alive) return UNKNOWN;
			if (number.kind !== "literal") w.mayThrow(flow);
			return withProv(settle(w, foldUnary(node.operator, number), flow), provOf(number));
		}
		default:
			return UNKNOWN;
	}
}

/** `++` and `--` on a primitive: its numeric value, and that value stepped. */
function stepped(value: Value, by: 1 | -1): [Value, Value] {
	if (value.kind !== "literal") return [VARIES, VARIES];
	const numeric = typeof value.value === "bigint" ? value.value : Number(value.value);
	return [literal(numeric), literal(typeof numeric === "bigint" ? numeric + BigInt(by) : numeric + by)];
}

export function* conditionalExpression(
	w: Walker,
	node: ts.ConditionalExpression,
	frame: Frame,
	flow: Flow,
): Step<Value> {
	const condition = yield* w.expr(node.condition, frame, flow);
	if (!flow.alive) return UNKNOWN;
	const truth = truthiness(condition);
	if (truth === true) return yield* w.expr(node.whenTrue, frame, flow);
	if (truth === false) return yield* w.expr(node.whenFalse, frame, flow);
	const base = [...flow.guards];
	const guard = w.guard(condition, node.condition, flow);
	const whenTrue = w.branch(flow, guard);
	const a = yield* w.expr(node.whenTrue, frame, whenTrue);
	const whenFalse = w.branch(flow, guard);
	const b = yield* w.expr(node.whenFalse, frame, whenFalse);
	w.join(flow, base, [whenTrue, whenFalse], false);
	const values = [...(whenTrue.alive ? [a] : []), ...(whenFalse.alive ? [b] : [])].map((value) =>
		underGuards(value, [guard]),
	);
	return values.length === 0 ? UNKNOWN : values.reduce((x, y) => joinValues(x, y));
}

export function* template(w: Walker, node: ts.TemplateExpression, frame: Frame, flow: Flow): Step<Value> {
	let text: string | undefined = node.head.text;
	let long = false;
	const strings: Value[] = [];
	for (const span of node.templateSpans) {
		const value = yield* w.expr(span.expression, frame, flow);
		if (!flow.alive) return UNKNOWN;
		const string = yield* toPrimitive(w, value, "string", span.expression, frame, flow);
		if (!flow.alive) return UNKNOWN;
		// A symbol throws converted to a string.
		if (string.kind !== "literal") w.mayThrow(flow);
		strings.push(string);
		text =
			text !== undefined && string.kind === "literal"
				? `${text}${String(string.value)}${span.literal.text}`
				: undefined;
		long ||= text !== undefined && text.length > MAX_TEXT;
		if (long) text = undefined;
	}
	return strings.reduce(
		(result, string) => withProv(result, provOf(string)),
		long ? UNKNOWN : text === undefined ? VARIES : literal(text),
	);
}

export function* awaitExpression(w: Walker, node: ts.AwaitExpression, frame: Frame, flow: Flow): Step<Value> {
	yield* w.expr(node.expression, frame, flow);
	if (!flow.alive) return UNKNOWN;
	if (frame.fn === null) {
		w.halt(node);
		return UNKNOWN;
	}
	// What follows the first `await` runs after the current job.
	flow.exits.push({ kind: "await", guards: [...flow.guards], maybe: false });
	flow.alive = false;
	return UNKNOWN;
}

/** `delete o[k]` evaluates its receiver and key, then removes the property, throwing on null or undefined. */
export function* deleteExpression(w: Walker, node: ts.DeleteExpression, frame: Frame, flow: Flow): Step<Value> {
	const target = unwrapExpression(node.expression);
	// Deleting a name deletes no value; deleting anything else but a member evaluates it.
	if (ts.isIdentifier(target)) return UNKNOWN;
	if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) {
		yield* w.expr(node.expression, frame, flow);
		return literal(true);
	}
	const receiver = yield* w.expr(target.expression, frame, flow);
	if (!flow.alive) return UNKNOWN;
	if (isNullish(receiver) && target.questionDotToken !== undefined) return literal(true);
	const key = ts.isElementAccessExpression(target)
		? yield* w.keyOf(target.argumentExpression, frame, flow)
		: target.name.text;
	if (!flow.alive) return UNKNOWN;
	if (isNullish(receiver)) {
		w.throwExit(flow, false);
		return UNKNOWN;
	}
	const object = w.objectOf(receiver);
	// Removing a class's `prototype` fails: strict code throws.
	if (receiver.kind === "class" && key === "prototype") {
		if (isStrict(w.pinned, node)) w.throwExit(flow, false);
		return literal(false);
	}
	// What the walk cannot see may refuse it.
	if (object === undefined || object.lost === true) w.mayThrow(flow);
	// A module's own object keeps what it assigned, as far as hazards go.
	else if (key === undefined || object.owner !== undefined) object.open = true;
	// Gone from its place in the key order: assigned again, it comes last.
	else if (!w.conditional(flow, object.base)) object.props.delete(key);
	else if (object.props.has(key)) {
		object.props.set(key, { state: "maybe", value: UNKNOWN });
		object.open = true;
	}
	return literal(true);
}
