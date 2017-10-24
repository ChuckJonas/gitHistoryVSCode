export type GitLogArgs = {
    logArgs: string[],
    fileStatArgs: string[],
    counterArgs: string[]
};
export const IGitArgsService = Symbol('IGitArgsService');

export interface IGitArgsService {
    getGitRootArgs(): string[];
    getCurrentBranchArgs(): string[];
    getCommitDateArgs(hash: string): string[];
    getCommitWithNumStatArgs(hash: string): string[];
    getCommitNameStatusArgs(hash: string): string[];
    getObjectHashArgs(object: string): string[];
    getRefsContainingCommitArgs(hash: string): string[];
    getLogArgs(pageIndex?: number, pageSize?: number, branch?: string, searchText?: string, relativeFilePath?: string): GitLogArgs;
    getDiffCommitWithNumStatArgs(hash1: string, hash2: string): string[];
    getDiffCommitNameStatusArgs(hash1: string, hash2: string): string[];
}