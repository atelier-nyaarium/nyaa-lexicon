// Maps of lists and maps of maps, filled as they are read.

////////////////////////////////
//  Functions & Helpers

/** The list `map` holds at `key`, made empty when missing. */
export function listAt<K, V>(map: Map<K, V[]>, key: K): V[] {
	let list = map.get(key);
	if (list === undefined) {
		list = [];
		map.set(key, list);
	}
	return list;
}

/** The map `map` holds at `key`, made empty when missing. */
export function mapAt<K, L, V>(map: Map<K, Map<L, V>>, key: K): Map<L, V> {
	let inner = map.get(key);
	if (inner === undefined) {
		inner = new Map();
		map.set(key, inner);
	}
	return inner;
}
