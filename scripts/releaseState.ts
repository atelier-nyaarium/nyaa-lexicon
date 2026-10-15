import { DIST_DIR } from "./dist";

const PATH_FIELD_OFFSET: Record<string, number> = { "1": 8, "2": 9, u: 10 };

function isDistPath(file: string): boolean {
	return file.split("/").includes(DIST_DIR);
}

export function dirtyTrackedFiles(porcelainV2: string): string[] {
	const dirty: string[] = [];
	for (const line of porcelainV2.split("\n")) {
		const offset = PATH_FIELD_OFFSET[line[0] ?? ""];
		if (offset === undefined || line[1] !== " ") continue;
		let cut = 0;
		for (let seen = 0; seen < offset; seen++) {
			const next = line.indexOf(" ", cut);
			if (next === -1) {
				cut = -1;
				break;
			}
			cut = next + 1;
		}
		if (cut === -1) continue;
		const file = (line.slice(cut).split("\t")[0] ?? "").trim();
		if (file && !isDistPath(file)) dirty.push(file);
	}
	return dirty;
}

export function untrackedFiles(porcelainV2: string): string[] {
	return porcelainV2
		.split("\n")
		.filter((line) => line.startsWith("? "))
		.map((line) => line.slice(2))
		.filter((file) => !isDistPath(file));
}
