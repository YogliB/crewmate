import { readFile } from "node:fs/promises";
import path from "node:path";
import { statePath } from "./state.js";

type WarningFn = (message: string, fields?: Record<string, unknown>) => Promise<void>;

type Profile = {
	provider?: string;
	model?: string;
	interval?: number;
	user?: string;
	prompt?: string;
	fix?: boolean;
	dryRun?: boolean;
	log?: boolean;
	debug?: boolean;
};

type GlobalConfig = {
	defaults?: Profile;
	profiles?: Record<string, Profile>;
};

const PROFILE_KEYS = new Set<keyof Profile>([
	"provider",
	"model",
	"interval",
	"user",
	"prompt",
	"fix",
	"dryRun",
	"log",
	"debug",
]);

const isString = (value: unknown): value is string => typeof value === "string";

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const isPositiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 1;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const globalConfigPath = (): string => path.join(path.dirname(statePath()), "config.json");

const repoConfigPath = (repoRoot: string): string => path.join(repoRoot, ".crewmate.json");

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const validateProfile = (raw: unknown): { profile: Partial<Profile>; warnings: string[] } => {
	const profile: Record<string, unknown> = {};
	const warnings: string[] = [];

	if (!isPlainObject(raw)) {
		return { profile: {}, warnings: ["config is not an object"] };
	}

	for (const key of PROFILE_KEYS) {
		if (!(key in raw)) {
			continue;
		}
		// oxlint-disable-next-line security/detect-object-injection -- key is a known Profile key
		const value = raw[key];
		let valid = false;
		switch (key) {
			case "provider":
			case "model":
			case "user":
			case "prompt":
				valid = isString(value);
				break;
			case "interval":
				valid = isPositiveInteger(value);
				break;
			case "fix":
			case "dryRun":
			case "log":
			case "debug":
				valid = isBoolean(value);
				break;
		}
		if (valid) {
			// oxlint-disable-next-line security/detect-object-injection -- key is a known Profile key
			profile[key] = value;
		} else {
			warnings.push(`invalid type for ${key}`);
		}
	}

	return { profile: profile as Partial<Profile>, warnings };
};

const warnAll = async (warnings: string[], source: string, file: string, onWarning: WarningFn) => {
	for (const reason of warnings) {
		await onWarning(reason, { reason, source, file });
	}
};

const loadConfigFile = async (
	filePath: string,
	source: string,
	onWarning: WarningFn,
): Promise<unknown> => {
	let raw: string;
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- filePath is a config path
		raw = await readFile(filePath, "utf8");
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT") {
			return undefined;
		}
		await onWarning("config invalid", {
			error: errorMessage(error),
			file: filePath,
			reason: "read",
			source,
		});
		return undefined;
	}

	try {
		return raw ? (JSON.parse(raw) as unknown) : undefined;
	} catch (error) {
		await onWarning("config invalid", {
			error: errorMessage(error),
			file: filePath,
			reason: "json",
			source,
		});
		return undefined;
	}
};

const loadGlobalConfig = async (
	owner: string,
	repo: string | undefined,
	onWarning: WarningFn,
): Promise<Partial<Profile>> => {
	const filePath = globalConfigPath();
	const raw = await loadConfigFile(filePath, "global", onWarning);

	if (raw === undefined) {
		return {};
	}

	if (!isPlainObject(raw)) {
		await onWarning("global config is not an object", {
			file: filePath,
			reason: "global-config-invalid",
			source: "global",
		});
		return {};
	}

	let selected: Partial<Profile> = {};
	const warnings: string[] = [];

	const hasDefaults = "defaults" in raw;
	const hasProfiles = "profiles" in raw;
	const hasBareProfile = Object.keys(raw).some((key) => (PROFILE_KEYS as Set<string>).has(key));
	if (!hasDefaults && !hasProfiles && hasBareProfile) {
		warnings.push("global config looks like a bare profile; wrap it in 'defaults' or 'profiles'");
	}

	const global = raw as GlobalConfig;

	if (global.defaults !== undefined) {
		if (isPlainObject(global.defaults)) {
			const { profile, warnings: defaultWarnings } = validateProfile(global.defaults);
			selected = { ...selected, ...profile };
			warnings.push(...defaultWarnings);
		} else {
			warnings.push("defaults is not an object");
		}
	}

	if (global.profiles !== undefined) {
		if (isPlainObject(global.profiles)) {
			const repoKey = repo === undefined ? owner.toLowerCase() : `${owner}/${repo}`.toLowerCase();
			const match = Object.entries(global.profiles).find(([key]) => key.toLowerCase() === repoKey);
			if (match !== undefined) {
				const [matchedKey, repoProfile] = match;
				if (!isPlainObject(repoProfile)) {
					warnings.push(`profiles["${matchedKey}"] is not an object`);
				} else {
					const { profile, warnings: profileWarnings } = validateProfile(repoProfile);
					selected = { ...selected, ...profile };
					warnings.push(...profileWarnings);
				}
			}
		} else {
			warnings.push("profiles is not an object");
		}
	}

	await warnAll(warnings, "global", filePath, onWarning);
	return selected;
};

const loadRepoConfig = async (
	repoRoot: string,
	onWarning: WarningFn,
): Promise<Partial<Profile>> => {
	const filePath = repoConfigPath(repoRoot);
	const raw = await loadConfigFile(filePath, "repo", onWarning);

	if (raw === undefined) {
		return {};
	}

	const { profile, warnings } = validateProfile(raw);
	if (profile.fix) {
		warnings.push("repo .crewmate.json enables --fix; only run crewmate in repositories you trust");
	}
	if (profile.provider && /[\\/]|^\./.test(profile.provider)) {
		warnings.push(
			"repo .crewmate.json uses a local/relative LLM provider; only run crewmate in repositories you trust",
		);
	}
	await warnAll(warnings, "repo", filePath, onWarning);
	return profile;
};

const resolveProfile = async (
	owner: string,
	repo: string | undefined,
	repoRoot: string | undefined,
	onWarning: WarningFn,
): Promise<Partial<Profile>> => {
	const globalProfile = await loadGlobalConfig(owner, repo, onWarning);
	if (repoRoot === undefined) {
		return globalProfile;
	}
	const repoProfile = await loadRepoConfig(repoRoot, onWarning);
	return { ...globalProfile, ...repoProfile };
};

export {
	errorMessage,
	globalConfigPath,
	isPlainObject,
	loadGlobalConfig,
	loadRepoConfig,
	type Profile,
	repoConfigPath,
	resolveProfile,
	validateProfile,
};
