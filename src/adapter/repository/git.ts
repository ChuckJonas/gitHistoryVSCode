import { inject, injectable } from 'inversify';
import * as path from 'path';
// tslint:disable-next-line:no-import-side-effect
import 'reflect-metadata';
import * as tmp from 'tmp';
import { Uri } from 'vscode';
import { Branch, CommittedFile, IGitService, LogEntries, LogEntry } from '../../types';
import { IGitCommandExecutor } from '../exec';
import { IFileStatParserFactory, ILogParser } from '../parsers/types';
import { ITEM_ENTRY_SEPARATOR, LOG_ENTRY_SEPARATOR, LOG_FORMAT_ARGS, STATS_SEPARATOR } from './constants';
import { IGitArgsService } from './types';

@injectable()
export class Git implements IGitService {
    private gitRootPath: string;
    private async exec(...args: string[]): Promise<string> {
        const gitRootPath = await this.getGitRoot();
        return await this.gitCmdExecutor.exec(gitRootPath, ...args);
    }
    private async execInShell(...args: string[]): Promise<string> {
        const gitRootPath = await this.getGitRoot();
        return await this.gitCmdExecutor.exec({ cwd: gitRootPath, shell: true }, ...args);
    }
    // how to check if a commit has been merged into any other branch
    //  $ git branch --all --contains 019daf673583208aaaf8c3f18f8e12696033e3fc
    //  remotes/origin/chrmarti/azure-account
    //  If the output contains just one branch, then this means NO, its in the same source branch
    // NOTE:
    // When returning logEntry,
    //  Check if anything has a ref of type HEAD,
    //  If it does, this means that's the head of a particular branch
    //  This means we don't need to draw the graph line all the way up into no where...
    // However, if this branch has been merged, then we need to draw it all the way up (or till its merge has been found)
    //  To do this we need to perform the step of determining if it has been merged
    // Note: Even if we did find a merged location, this doesn't mean we shouldn't stop drawing the line
    //  Its possible the other branch that it has been merged into is out of the current page
    //  In this instance the grap line will have to go up (to no where)...

    private async getGitRelativePath(file: Uri) {
        const gitRoot: string = await this.getGitRoot();
        return path.relative(gitRoot, file.fsPath).replace(/\\/g, '/');
    }

    // tslint:disable-next-line:member-ordering
    constructor(private workspaceRoot: string,
        @inject(IGitCommandExecutor) private gitCmdExecutor: IGitCommandExecutor,
        @inject(ILogParser) private logParser: ILogParser,
        @inject(IGitArgsService) private gitArgsService: IGitArgsService,
        @inject(IFileStatParserFactory) private fileStatParserFactory: IFileStatParserFactory) {
    }

    public async  getGitRoot(): Promise<string> {
        if (this.gitRootPath) {
            return this.gitRootPath;
        }
        const gitRootPath = await this.gitCmdExecutor.exec(this.workspaceRoot, ...this.gitArgsService.getGitRootArgs());
        return this.gitRootPath = gitRootPath.split(/\r?\n/g)[0].trim();
    }

    // tslint:disable-next-line:member-ordering
    public async getHeadHashes(): Promise<{ ref: string, hash: string }[]> {
        const fullHashArgs = ['show-ref'];
        const fullHashRefsOutput = await this.exec(...fullHashArgs);
        return fullHashRefsOutput.split(/\r?\n/g)
            .filter(line => line.length > 0)
            .filter(line => line.indexOf('refs/heads/') > 0 || line.indexOf('refs/remotes/') > 0)
            .map(line => line.trim().split(' '))
            .filter(lineParts => lineParts.length > 1)
            .map(hashAndRef => { return { ref: hashAndRef[1], hash: hashAndRef[0] }; });
    }
    // tslint:disable-next-line:member-ordering
    public async getBranches(): Promise<Branch[]> {
        const output = await this.exec('branch');
        return output.split(/\r?\n/g)
            .filter(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => {
                const isCurrent = line.startsWith('*');
                const name = isCurrent ? line.substring(1).trim() : line;
                return {
                    name,
                    current: isCurrent
                };
            });
    }
    public async getCurrentBranch(): Promise<string> {
        const args = this.gitArgsService.getCurrentBranchArgs();
        const branch = await this.exec(...args);
        return branch.split(/\r?\n/g)[0].trim();
    }
    public async getObjectHash(object: string): Promise<string> {

        // Get the hash of the given ref
        // E.g. git show --format=%H --shortstat remotes/origin/tyriar/xterm-v3
        const args = this.gitArgsService.getObjectHashArgs(object);
        const output = await this.exec(...args);
        return output.split(/\r?\n/g)[0].trim();
    }
    public async getRefsContainingCommit(hash: string): Promise<string[]> {
        const args = this.gitArgsService.getRefsContainingCommitArgs(hash);
        const entries = await this.exec(...args);
        return entries.split(/\r?\n/g)
            .map(line => line.trim())
            // Remove the '*' prefix from current branch
            .map(line => line.startsWith('*') ? line.substring(1) : line)
            // Remove the '->' from ref pointers (take first portion)
            .map(ref => ref.indexOf(' ') ? ref.split(' ')[0].trim() : ref);
    }
    public async getLogEntries(pageIndex: number = 0, pageSize: number = 100, branch: string = '', searchText: string = '', file?: Uri): Promise<LogEntries> {
        const relativePath = file ? await this.getGitRelativePath(file) : undefined;
        const args = await this.gitArgsService.getLogArgs(pageIndex, pageSize, branch, searchText, relativePath);

        const gitRootPathPromise = this.getGitRoot();
        const outputPromise = this.exec(...args.logArgs);

        // Since we're using find and wc (shell commands, we need to execute the command in a shell)
        const countOutputPromise = this.execInShell(...args.counterArgs);

        const values = await Promise.all([gitRootPathPromise, outputPromise, countOutputPromise]);
        const gitRepoPath = values[0];
        const output = values[1];
        const countOutput = values[2];
        const count = parseInt(countOutput.trim(), 10);

        // Run another git history, but get file stats instead of the changes
        // const outputWithFileModeChanges = await this.exec(args.fileStatArgs);
        // const entriesWithFileModeChanges = outputWithFileModeChanges.split(LOG_ENTRY_SEPARATOR);
        const items = output
            .split(LOG_ENTRY_SEPARATOR)
            .map((entry, index) => {
                if (entry.length === 0) {
                    return;
                }
                return this.logParser.parse(gitRepoPath, entry, ITEM_ENTRY_SEPARATOR, STATS_SEPARATOR, LOG_FORMAT_ARGS);
            })
            .filter(logEntry => logEntry !== undefined)
            .map(logEntry => logEntry!);

        const headHashes = await this.getHeadHashes();
        const headHashesOnly = headHashes.map(item => item.hash);
        // tslint:disable-next-line:prefer-type-cast
        const headHashMap = new Map<string, string>(headHashes.map(item => [item.ref, item.hash] as [string, string]));

        items.forEach(async item => {
            // Check if this the very last commit of a branch
            // Just check if this is a head commit (if shows up in 'git show-ref')
            item.isLastCommit = headHashesOnly.indexOf(item.hash.full) >= 0;

            // Check if this commit has been merged into another branch
            // Do this only if this is a head commit (we don't care otherwise, only the graph needs it)
            if (!item.isLastCommit) {
                return;
            }
            const refsContainingThisCommit = await this.getRefsContainingCommit(item.hash.full);
            const hashesOfRefs = refsContainingThisCommit
                .filter(ref => headHashMap.has(ref))
                .map(ref => headHashMap.get(ref)!)
                // tslint:disable-next-line:possible-timing-attack
                .filter(hash => hash !== item.hash.full);
            // If we have hashes other than current, then yes it has been merged
            item.isThisLastCommitMerged = hashesOfRefs.length > 0;
        });

        return {
            items,
            count
        };
    }

    public async getCommitDate(hash: string): Promise<Date | undefined> {
        const args = this.gitArgsService.getCommitDateArgs(hash);
        const output = await this.exec(...args);
        const lines = output.split(/\r?\n/g).map(line => line.trim()).filter(line => line.length > 0);
        if (lines.length === 0) {
            return;
        }

        const unixTime = parseInt(lines[0], 10);
        if (isNaN(unixTime) || unixTime <= 0) {
            return;
        }
        return new Date(unixTime * 1000);
    }
    public async getCommit(hash: string): Promise<LogEntry | undefined> {
        const numStartArgs = this.gitArgsService.getCommitWithNumStatArgs(hash);
        const nameStatusArgs = this.gitArgsService.getCommitNameStatusArgs(hash);

        const gitRootPath = await this.getGitRoot();
        const output = await this.exec(...numStartArgs);

        // Run another git history, but get file stats instead of the changes
        const outputWithFileModeChanges = await this.exec(...nameStatusArgs);
        const entriesWithFileModeChanges = outputWithFileModeChanges.split(LOG_ENTRY_SEPARATOR);

        const entries = output
            .split(LOG_ENTRY_SEPARATOR)
            .map((entry, index) => {
                if (entry.trim().length === 0) {
                    return undefined;
                }
                return this.logParser.parse(gitRootPath, entry, ITEM_ENTRY_SEPARATOR, STATS_SEPARATOR, LOG_FORMAT_ARGS, entriesWithFileModeChanges[index]);
            })
            .filter(entry => entry !== undefined)
            .map(entry => entry!);

        return entries.length > 0 ? entries[0] : undefined;
    }

    public async getCommitFile(hash: string, file: Uri | string): Promise<Uri> {
        const gitRootPath = await this.getGitRoot();
        return new Promise<Uri>((resolve, reject) => {
            tmp.tmpName((err: Error, tmpPath: string) => {
                if (err) {
                    return reject(err);
                }
                const filePath = typeof file === 'string' ? file : file.fsPath.toString();
                const relativeFilePath = path.relative(gitRootPath, filePath);
                this.exec('show', `${hash}:${relativeFilePath}`, '>', tmpPath)
                    .then(() => resolve(Uri.file(tmpPath)))
                    .catch(reject);
            });
        });
    }
    public async getDifferences(hash1: string, hash2: string): Promise<CommittedFile[]> {
        const gitRepoPath = await this.getGitRoot();
        const numStartArgs = this.gitArgsService.getDiffCommitWithNumStatArgs(hash1, hash2);
        const nameStatusArgs = this.gitArgsService.getDiffCommitNameStatusArgs(hash1, hash2);

        const output = await this.exec(...numStartArgs);
        const outputWithFileModeChanges = await this.exec(...nameStatusArgs);
        const entriesWithFileModeChanges = outputWithFileModeChanges.split(/\r?\n/g);

        const bothEntries = output
            .split(/\r?\n/g)
            .map((entry, index) => {
                if (entry.trim().length === 0) {
                    return undefined;
                }
                return { numstat: entry, namestat: entriesWithFileModeChanges[index] };
            })
            .filter(entry => entry !== undefined)
            .map(entry => entry!);

        const numstatEntries = bothEntries.map(items => items.numstat);
        const namestatEntries = bothEntries.map(items => items.namestat);

        return this.fileStatParserFactory.createFileStatParser(gitRepoPath).parse(numstatEntries, namestatEntries);
    }
}
