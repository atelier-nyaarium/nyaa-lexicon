// Spelling and embedded-name cases for each format.

import type { CorpusName } from "./secretConformance.js";

////////////////////////////////
//  Interfaces & Types

export interface Spelling {
	id: CorpusName;
	name: string;
	text: string;
}

////////////////////////////////
//  Fixtures

type Row = readonly [id: CorpusName, name: string, text: string];

const SPELLED_ROWS: readonly Row[] = [
	["json", "data", '{"data": 1}'],
	["json", "data", "{'data': 1}"],
	["json", "data", "{data: 1}"],
	["json", "data", "{ data /* c */ : 1 }"],
	["json", "data", '{"x":1 "data":2}'],
	["json", "data", '{"d\\u0061ta": 1}'],
	["json", "data", '{"\\u0064\\u0061\\u0074\\u0061": 1}'],
	["json", "data", '{"da\\qta": 1}'],
	["json", "data", '{"x": "\\q"}'],
	["json", "data", '{"data'],
	["json", "data", '{"data\n": 1}'],
	["json", "data", "{d\\u0061ta: 1}"],
	["json", "data", '{b\\"d\\u0061ta": 1}'],
	["json", "a\nb", '{b\\"a\\nb": 1}'],
	["json", 'a"b', '{"a\\"b": 1}'],
	["json", "a/b", '{"a\\/b": 1}'],
	["json", "0", '{"x": [1]}'],
	["yaml", "data", "data: 1"],
	["yaml", "data", "  data: 1"],
	["yaml", "data", "- data: 1"],
	["yaml", "data", "? data\n: 1"],
	["yaml", "data", "{data: 1}"],
	["yaml", "data", "[data: 1]"],
	["yaml", "data", "{a: 1,data: 2}"],
	["yaml", "data", "{a, data}"],
	["yaml", "data", "data :  1"],
	["yaml", "data", "data\t: 1"],
	["yaml", "data", "&a data: 1"],
	["yaml", "data", "!!str data: 1"],
	["yaml", "data", "x: &a,data: 1"],
	["yaml", ",data", "x: &a,data: 1"],
	["yaml", "data", "!t,data: 1"],
	["yaml", "data", '"data": 1'],
	["yaml", "data", "'data': 1"],
	["yaml", "data", '"d\\x61ta": 1'],
	["yaml", "data", '"\\u0064ata": 1'],
	["yaml", "data", '"\\U00000064ata": 1'],
	["yaml", "data", '"da\\\nta": 1'],
	["yaml", "dA", '"\\x64\\u0041": 1'],
	["yaml", "d\u{1f600}", '"\\x64\\U0001F600": 1'],
	["yaml", "d\\q", '"\\x64\\q": 1'],
	["yaml", "d\\xZZ", '"\\x64\\xZZ": 1'],
	["yaml", 'd\\x6"', '"\\x64\\x6": 1'],
	["yaml", "it's", "'it''s': 1"],
	["yaml", "to ken", "to ken: x"],
	["yaml", "to ken", '"to ken": x'],
	["yaml", "to ken", "to\n  ken: x"],
	["yaml", "d a", '"d\n   a": 1'],
	["yaml", "d a", '"d\\x20a": 1'],
	["yaml", "b", '["a"b: 1]'],
	["yaml", "ima", 'x: 1\n"imag'],
	["yaml", "other:$", "data: {token: x, other:${ y}\n"],
	["yaml", 't\\x6"', '"t\\x6": 1'],
	["yaml", "31", "0x1F: x"],
	["yaml", "true", "yes: 1"],
	["dotenv", "DATA", "DATA=1"],
	["dotenv", "DATA", "export DATA=1"],
	["dotenv", "DATA", "A=1 DATA=2"],
	["dotenv", "DATA", "A=1;DATA=2"],
	["dotenv", "DATA", "A=$(DATA=2)"],
	["dotenv", "DATA", "DATA\n=1"],
	["dotenv", "DATA", "  DATA : x"],
	["dotenv", "DATA", "DA\\\nTA=hunter2\n"],
];

const EMBEDDED_ROWS: readonly Row[] = [
	["json", "data", '{"metadata": 1}'],
	["json", "data", "{metadata: 1}"],
	["json", "data", '{"database": 1}'],
	["json", "data", '{"data_x": 1}'],
	["json", "data", '{"x": "some data here"}'],
	["json", "data", '{"x": "a data/hora"}'],
	["json", "data", '{"x": "\\\\d\\u0061ta"}'],
	["json", "data", '{"x": "a\\nb\\tc\\\\d\\"e data"}'],
	["json", "data", '{"x": "C:\\\\data\\\\x"}'],
	["json", "data", '{"x": "\\u0064\\u0061ta is here"}'],
	["yaml", "data", "metadata: 1"],
	["yaml", "data", "database: 1"],
	["yaml", "data", "user_data: 1"],
	["yaml", "data", "my-data: 1"],
	["yaml", "data", "x.data: 1"],
	["yaml", "data", "a/data: 1"],
	["yaml", "data", "dataset: 1"],
	["yaml", "data", "data-source: 1"],
	["yaml", "data", "note: the data is here"],
	["yaml", "data", "note: data and more"],
	["yaml", "data", '"x": "metadata"'],
	["yaml", "data", '"x": "a\\nb data c"'],
	["dotenv", "DATA", "METADATA=1"],
	["dotenv", "DATA", "DATA_URL=1"],
	["dotenv", "DATA", "MY.DATA=1"],
	["dotenv", "DATA", "X-DATA=1"],
	["dotenv", "DATA", "DATABASE=1"],
];

function spellings(rows: readonly Row[]): Spelling[] {
	return rows.map(([id, name, text]) => ({ id, name, text }));
}

/** Reader-selected or hazardous spellings. */
export const SPELLED: readonly Spelling[] = spellings(SPELLED_ROWS);

/** Embedded names no reader selects. */
export const EMBEDDED: readonly Spelling[] = spellings(EMBEDDED_ROWS);
