import type { AdmittedBytes, JournalAdmission } from "./secretPolicy.js";
import type { IndexStore } from "./store.js";
import { TransactionManager } from "./transactions.js";

declare const store: Pick<IndexStore, "putBlob">;
declare const transactionStore: IndexStore;
declare const bytes: Uint8Array;
declare const admission: JournalAdmission;

// @ts-expect-error raw bytes unadmitted
store.putBlob(bytes);

// @ts-expect-error policy instance required
new TransactionManager(transactionStore, ".", () => null);

// @ts-expect-error only policy mints images
const forged: AdmittedBytes = { module: "src/a.json", hash: "h", stamp: null, bytes };

// @ts-expect-error an image requires bytes
const noBytes: AdmittedBytes = admission;

void forged;
void noBytes;
