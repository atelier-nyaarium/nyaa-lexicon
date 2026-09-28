// Tallies for the edges read: peers grouped by first role, and names with no symbol.

import {
	type EdgeGroup,
	type EdgePeer,
	type EdgeRole,
	EdgeRoleSchema,
	type ImportResolution,
	type NameTally,
	type ReferenceRole,
	type StoredImport,
	type SymbolSummary,
} from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** Namespace import destination. */
export type NamespaceTarget = { module: string } | { external: true };

interface PeerCount {
	symbol: SymbolSummary | undefined;
	module: string;
	roles: Partial<Record<EdgeRole, number>>;
	sites: number;
	holders: Set<string>;
}

////////////////////////////////
//  Constants

/** Precedence: a peer's first role names its group. */
const EDGE_ROLES: readonly EdgeRole[] = EdgeRoleSchema.options;

////////////////////////////////
//  Functions & Helpers

export function isEdgeRole(role: ReferenceRole): role is EdgeRole {
	return (EDGE_ROLES as readonly string[]).includes(role);
}

/** With no kind, a nameless import binds the module. */
export function bindsModule(statement: StoredImport): boolean {
	if (statement.kind === undefined) return statement.name === undefined;
	return statement.kind === "namespace" || statement.kind === "require";
}

export function namespaceTargetOf(landed: ImportResolution | null): NamespaceTarget | null {
	if (landed?.status === "resolved") return { module: landed.module };
	return landed?.status === "external" ? { external: true } : null;
}

export function sameTarget(a: NamespaceTarget, b: NamespaceTarget): boolean {
	return "module" in a ? "module" in b && a.module === b.module : !("module" in b);
}

function firstRole(roles: Partial<Record<EdgeRole, number>>): EdgeRole {
	return EDGE_ROLES.find((role) => roles[role] !== undefined) ?? "read";
}

////////////////////////////////
//  Classes

/** Rank peers by sites, home, then name. */
export class PeerTally {
	private readonly peers = new Map<string, PeerCount>();

	constructor(private readonly home: string) {}

	/** Absent symbol means module top level. */
	add(symbol: SymbolSummary | null, module: string, role: EdgeRole, holder?: string): void {
		const key = symbol === null ? `module ${module}` : symbol.symbolId;
		let peer = this.peers.get(key);
		if (peer === undefined) {
			peer = { symbol: symbol ?? undefined, module, roles: {}, sites: 0, holders: new Set() };
			this.peers.set(key, peer);
		}
		peer.roles[role] = (peer.roles[role] ?? 0) + 1;
		peer.sites++;
		if (holder !== undefined) peer.holders.add(holder);
	}

	groups(limit: number, withHolders: boolean): EdgeGroup[] {
		const byRole = new Map<EdgeRole, PeerCount[]>();
		for (const peer of this.peers.values()) {
			const role = firstRole(peer.roles);
			const list = byRole.get(role);
			if (list === undefined) byRole.set(role, [peer]);
			else list.push(peer);
		}
		const nameOf = (peer: PeerCount) => peer.symbol?.name ?? peer.module;
		const rank = (a: PeerCount, b: PeerCount) =>
			b.sites - a.sites ||
			Number(b.module === this.home) - Number(a.module === this.home) ||
			nameOf(a).localeCompare(nameOf(b)) ||
			a.module.localeCompare(b.module);
		return EDGE_ROLES.flatMap((role) => {
			const list = byRole.get(role);
			if (list === undefined) return [];
			const peers = list
				.sort(rank)
				.slice(0, limit)
				.map(
					(peer): EdgePeer => ({
						...(peer.symbol === undefined ? {} : { symbol: peer.symbol }),
						module: peer.module,
						roles: peer.roles,
						sites: peer.sites,
						...(withHolders && peer.holders.size > 0 ? { holders: peer.holders.size } : {}),
					}),
				);
			return [{ role, peers, total: list.length }];
		});
	}
}

/** Names rank by sites. */
export class NameCount {
	private readonly sites = new Map<string, number>();

	add(name: string): void {
		this.sites.set(name, (this.sites.get(name) ?? 0) + 1);
	}

	tally(limit: number): NameTally {
		const names = [...this.sites]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, limit)
			.map(([name, sites]) => ({ name, sites }));
		return { names, total: this.sites.size };
	}

	/** Uncapped names, ranked by sites. */
	entries(): Array<[string, number]> {
		return [...this.sites].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	}
}
