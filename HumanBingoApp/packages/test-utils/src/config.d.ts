export interface PropertyTestOptions {
    readonly numRuns: number;
    readonly seed: number;
}
/** Shared fast-check defaults: enough coverage for CI and a reproducible failure seed. */
export declare const readPropertyTestOptions: (source?: NodeJS.ProcessEnv) => PropertyTestOptions;
export interface DatabaseTestConfig {
    readonly enabled: boolean;
    readonly schema: string;
    readonly reset: boolean;
    readonly maxConnections: number;
    readonly url?: string;
}
export declare class DatabaseTestConfigurationError extends Error {
    constructor(message: string);
}
/** Reads an explicitly test-scoped PostgreSQL configuration and refuses production URLs. */
export declare const readDatabaseTestConfig: (source?: NodeJS.ProcessEnv) => DatabaseTestConfig;
export declare const requireDatabaseTestConfig: (source?: NodeJS.ProcessEnv) => DatabaseTestConfig & {
    readonly url: string;
};
//# sourceMappingURL=config.d.ts.map