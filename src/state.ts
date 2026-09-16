import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const homeDir = (): string => {
	try {
		return homedir();
	} catch {
		return process.cwd();
	}
};

const configHome = (): string =>
	process.env.XDG_CONFIG_HOME ||
	path.join(process.env.HOME || process.env.USERPROFILE || homeDir(), ".config");

const statePath = (): string => path.join(configHome(), "crewmate", "state.json");

const lockPath = (): string => path.join(configHome(), "crewmate", "lock");

type JobStatus = "failed" | "pending" | "running" | "succeeded";

type Job = {
	attempts: number;
	lastError?: string;
	nextAttemptAt?: string;
	status: JobStatus;
	updatedAt: string;
};

type JobMap = Map<string, Map<string, Job>>;

const MAX_ATTEMPTS = 3;
const MAX_JOBS_PER_TARGET = 500;
const RETRY_BASE_SECONDS = 60;

const retryDelaySeconds = (attempts: number): number => RETRY_BASE_SECONDS * 2 ** (attempts - 1);

const isJobClosed = (job: Job): boolean =>
	job.status === "succeeded" || (job.status === "failed" && job.attempts >= MAX_ATTEMPTS);

const isJobDue = (job: Job, now: Date): boolean =>
	!isJobClosed(job) &&
	(job.nextAttemptAt === undefined || Date.parse(job.nextAttemptAt) <= now.getTime());

const JOB_KEY = /^(review|conversation|issue):\d+$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isJobStatus = (value: unknown): value is JobStatus =>
	value === "pending" || value === "running" || value === "succeeded" || value === "failed";

const toJob = (raw: unknown): Job | undefined => {
	if (!isPlainObject(raw)) return undefined;
	if (!isJobStatus(raw.status)) return undefined;
	if (typeof raw.attempts !== "number" || !Number.isInteger(raw.attempts) || raw.attempts < 0) {
		return undefined;
	}
	if (typeof raw.updatedAt !== "string") return undefined;
	const job: Job = { attempts: raw.attempts, status: raw.status, updatedAt: raw.updatedAt };
	if (typeof raw.nextAttemptAt === "string") job.nextAttemptAt = raw.nextAttemptAt;
	if (typeof raw.lastError === "string") job.lastError = raw.lastError;
	return job;
};

const migratedJob = (updatedAt: string): Job => ({
	attempts: 1,
	status: "succeeded",
	updatedAt,
});

const loadTargetJobs = (raw: unknown, migratedAt: string): Map<string, Job> | undefined => {
	const jobs = new Map<string, Job>();
	if (Array.isArray(raw)) {
		for (const item of raw) {
			const key = typeof item === "number" ? `review:${item}` : item;
			if (typeof key === "string" && JOB_KEY.test(key)) {
				jobs.set(key, migratedJob(migratedAt));
			}
		}
		return jobs;
	}
	if (!isPlainObject(raw)) return undefined;
	for (const [key, value] of Object.entries(raw)) {
		if (!JOB_KEY.test(key)) continue;
		const job = toJob(value);
		if (job !== undefined) {
			jobs.set(key, job);
		}
	}
	return jobs;
};

const readRawState = async (filePath: string): Promise<string> => {
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- state path is internal (XDG_CONFIG_HOME/homedir), not user input
		return await readFile(filePath, "utf8");
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT") {
			return "";
		}
		throw error;
	}
};

const loadState = async (
	filePath = statePath(),
	onCorrupt: () => void | Promise<void> = () => {
		process.stderr.write("Warning: state file is corrupted, resetting.\n");
	},
): Promise<JobMap> => {
	const state: JobMap = new Map();
	const raw = await readRawState(filePath);
	if (raw === "") {
		return state;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		await onCorrupt();
		return state;
	}
	if (!isPlainObject(parsed)) {
		await onCorrupt();
		return state;
	}
	const migratedAt = new Date().toISOString();
	const targets = isPlainObject(parsed.targets) ? parsed.targets : parsed;
	for (const [target, rawJobs] of Object.entries(targets)) {
		const jobs = loadTargetJobs(rawJobs, migratedAt);
		if (jobs !== undefined && jobs.size > 0) {
			state.set(target, jobs);
		}
	}
	return state;
};

const pruneTargetJobs = (jobs: Map<string, Job>, max: number): Map<string, Job> => {
	if (jobs.size <= max) return jobs;
	const closed = [...jobs.entries()]
		.filter(([, job]) => isJobClosed(job))
		.toSorted((first, second) => first[1].updatedAt.localeCompare(second[1].updatedAt));
	let overflow = jobs.size - max;
	for (const [key] of closed) {
		if (overflow <= 0) break;
		jobs.delete(key);
		overflow -= 1;
	}
	return jobs;
};

const pruneState = (state: JobMap, max = MAX_JOBS_PER_TARGET): JobMap => {
	for (const [target, jobs] of state) {
		state.set(target, pruneTargetJobs(jobs, max));
	}
	return state;
};

const serializeState = (state: JobMap): string =>
	JSON.stringify({
		targets: Object.fromEntries(
			[...state.entries()].map(([target, jobs]) => [target, Object.fromEntries(jobs)]),
		),
		version: 2,
	});

const saveState = async (state: JobMap, filePath = statePath()): Promise<void> => {
	const dir = path.dirname(filePath);
	// oxlint-disable-next-line security/detect-non-literal-fs-filename -- state dir is internal (XDG_CONFIG_HOME/homedir), not user input
	await mkdir(dir, { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- tmp path is derived from the internal state path
		await writeFile(tmpPath, serializeState(pruneState(state)));
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- state path is internal (XDG_CONFIG_HOME/homedir), not user input
		await rename(tmpPath, filePath);
	} catch (error) {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- tmp path is derived from the internal state path
		await rm(tmpPath, { force: true }).catch(() => {});
		throw error;
	}
};

type LockOptions = {
	dir?: string;
	isProcessAlive?: (pid: number) => boolean;
};

const defaultIsProcessAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

const acquireLock = async (options: LockOptions = {}): Promise<() => Promise<void>> => {
	const dir = options.dir ?? path.dirname(statePath());
	const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
	const lockDir = path.join(dir, "lock");
	const pidFile = path.join(lockDir, "pid");
	const claim = async (): Promise<boolean> => {
		try {
			// oxlint-disable-next-line security/detect-non-literal-fs-filename -- lock dir is internal (XDG_CONFIG_HOME/homedir), not user input
			await mkdir(dir, { recursive: true });
			// oxlint-disable-next-line security/detect-non-literal-fs-filename -- lock dir is internal (XDG_CONFIG_HOME/homedir), not user input
			await mkdir(lockDir);
			// oxlint-disable-next-line security/detect-non-literal-fs-filename -- pid file lives inside the internal lock dir
			await writeFile(pidFile, String(process.pid));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
			return false;
		}
	};
	if (!(await claim())) {
		let holder: number | undefined;
		try {
			// oxlint-disable-next-line security/detect-non-literal-fs-filename -- pid file lives inside the internal lock dir
			holder = Number.parseInt(await readFile(pidFile, "utf8"), 10);
		} catch {
			holder = undefined;
		}
		if (holder !== undefined && !Number.isNaN(holder) && isProcessAlive(holder)) {
			throw new Error(
				`another crewmate instance is already running (pid ${holder}); if it is not, delete ${lockDir}`,
			);
		}
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- lock dir is internal (XDG_CONFIG_HOME/homedir), not user input
		await rm(lockDir, { force: true, recursive: true });
		if (!(await claim())) {
			throw new Error(`could not acquire crewmate lock at ${lockDir}`);
		}
	}
	return async () => {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- lock dir is internal (XDG_CONFIG_HOME/homedir), not user input
		await rm(lockDir, { force: true, recursive: true }).catch(() => {});
	};
};

export {
	acquireLock,
	isJobClosed,
	isJobDue,
	type Job,
	lockPath,
	loadState,
	MAX_ATTEMPTS,
	pruneState,
	retryDelaySeconds,
	saveState,
	statePath,
};
