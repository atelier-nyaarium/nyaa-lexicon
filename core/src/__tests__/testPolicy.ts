import { type Clock, systemClock } from "../clock.js";
import type { GitRunner } from "../fileScope.js";
import type { ProviderPort } from "../providerPort.js";
import type { SecretPolicyConfig } from "../secretPolicy.js";
import { SecretPolicy } from "../secretPolicy.js";
import { LexiconService as CoreLexiconService } from "../service.js";
import type { IndexStore, StoredSecretPolicy } from "../store.js";
import { ProviderSupervisor as CoreProviderSupervisor } from "../supervisor.js";
import { Timings } from "../timings.js";

export function testPolicy(
	root: string,
	config?: Partial<SecretPolicyConfig>,
	store?: Pick<IndexStore, "lastSecretPolicy" | "rememberSecretPolicy">,
	runGit?: GitRunner,
): SecretPolicy {
	let persisted: StoredSecretPolicy | null =
		config === undefined ? null : { secrets: config.secrets ?? {}, deny: [...(config.deny ?? [])] };
	const selectedStore = store ?? {
		lastSecretPolicy: () => persisted,
		rememberSecretPolicy: (next: StoredSecretPolicy) => {
			persisted = next;
		},
	};
	const policy = SecretPolicy.initial({ root, store: selectedStore, ...(runGit === undefined ? {} : { runGit }) });
	policy.attach({
		index: { installScope: () => {} },
		journal: { policyChanged: () => {} },
		providers: { policyChanged: () => {} },
	});
	return policy;
}

export class TestLexiconService extends CoreLexiconService {
	readonly policy: SecretPolicy;

	constructor(
		store: IndexStore,
		supervisor: ProviderPort,
		readSource: ConstructorParameters<typeof CoreLexiconService>[2],
		root = ".",
		clock: Clock = systemClock,
		policy?: SecretPolicy,
	) {
		const selected = policy ?? testPolicy(root, undefined, store);
		super(store, supervisor, readSource, root, clock, selected);
		this.policy = selected;
		selected.attach({
			index: this.indexer,
			journal: { policyChanged: () => {} },
			providers: supervisor,
		});
	}

	attachJournal(journal: Parameters<SecretPolicy["attach"]>[0]["journal"]): void {
		this.policy.attach({ index: this.indexer, journal, providers: { policyChanged: () => {} } });
	}
}

export class TestProviderSupervisor extends CoreProviderSupervisor {
	constructor(
		clock: Clock = systemClock,
		timings?: Timings,
		policySource?: ConstructorParameters<typeof CoreProviderSupervisor>[2],
	) {
		const policy = testPolicy(".");
		super(clock, timings ?? new Timings(clock), policySource ?? (() => policy.current));
	}
}
