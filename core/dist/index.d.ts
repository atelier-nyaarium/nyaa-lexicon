/** What a running daemon reports about itself at handshake. */
export interface DaemonIdentity {
    /** Absolute path of the workspace this daemon indexes. One daemon per workspace. */
    workspaceRoot: string;
    /** Provider protocol version. A client on a different major replaces the daemon. */
    protocolVersion: string;
}
/**
 * The daemon's own identity.
 *
 * Phase 4 lands the daemon itself; this exists so the package boundary and the
 * dependency direction (core -> protocol, never the reverse) are real from day one.
 */
export declare function daemonIdentity(workspaceRoot: string): DaemonIdentity;
//# sourceMappingURL=index.d.ts.map