import type { SourceReader, ViewReader } from "../sourceRead";
import type { EventHasher } from "../watcher";
import { testPolicy } from "./testPolicy";

/** Snapshot without project rules. */
export const readingPolicy = testPolicy(".").current;

/** Hashes test-policy views. */
export const hashOfRead: EventHasher = (read) => readingPolicy.view(read).hash;

/** Adapts sealed reads to views. */
export function viewsOf(read: SourceReader): ViewReader {
	return (module) => readingPolicy.view(read(module));
}
