export function compileSearchRegex(source: string): RegExp {
	const match = /^\/((?:\\.|[^/])*)\/([a-z]*)$/.exec(source);
	if (match === null || match[1] === undefined || match[2] === undefined) {
		throw new Error(`Regex failed to compile: expected /pattern/flags.`);
	}

	try {
		return new RegExp(match[1], match[2]);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Regex failed to compile: ${detail}`);
	}
}
