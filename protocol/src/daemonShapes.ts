// Every shape a daemon answer is made of.
//
// The wire owns these; core's rows, plans and outcomes are `z.infer` of them, so what the store
// builds and what a client types cannot drift apart. Plain `z.object` throughout: an unnamed field
// is stripped on the way out, which is the contract that nothing leaves that the table does not name.

export * from "./daemonHistory.js";
export * from "./daemonIndexState.js";
export * from "./daemonKnowledge.js";
export * from "./daemonReading.js";
export * from "./daemonRefactor.js";
export * from "./daemonRefactorTransactions.js";
export * from "./daemonRows.js";
