import { readFile } from "node:fs/promises";
import path from "node:path";
import { statePath } from "./state.js";

type WarningFn = (message: string, fields?: Record<string, unknown>) => Promise<void>;

type Profile = {
	debug?: boolean;
	interval?: number;
	log?: boolean;
	model?: string;
	prompt?: string;
	provider?: string;
	timeoutSeconds?: number;
	unsafeNoUser?: boolean;
	user?: string;
};

const PROFILE_KEYS = new Set<keyof Profile>([
	"provider",
	"model",
	"interval",
	"user",
	"prompt",
	"log",
	"debug",
	"unsafeNoUser",
	"timeoutSeconds",
]);

const REMOVED_KEYS = new Set(["defaults", "dryRun", "fix", "profiles"]);

const isString = (value: unknown): value is string => typeof value === "string";

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const isPositiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 1;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const configPath = (): string => path.join(path.dirname(statePath()), "config.json");

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const validateProfile = (raw: unknown): { profile: Partial<Profile>; warnings: string[] } => {
	const profile: Record<string, unknown> = {};
	const warnings: string[] = [];

	if (!isPlainObject(raw)) {
		return { profile: {}, warnings: ["config is not an object"] };
	}

	for (const [key, value] of Object.entries(raw)) {
		if (key === "$schema") {
			continue;
		}
		if (REMOVED_KEYS.has(key)) {
			warnings.push(`${key} is no longer supported; remove it from your config`);
			continue;
		}
		if (!(PROFILE_KEYS as Set<string>).has(key)) {
			warnings.push(`unknown key ${key}`);
			continue;
		}
		let valid = false;
		switch (key as keyof Profile) {
			case "provider":
			case "model":
			case "user":
			case "prompt":
				valid = isString(value);
				break;
			case "interval":
			case "timeoutSeconds":
				valid = isPositiveInteger(value);
				break;
			case "log":
			case "debug":
			case "unsafeNoUser":
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

const loadConfig = async (onWarning: WarningFn): Promise<Partial<Profile>> => {
	const filePath = configPath();
	let raw: string;
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- config path is internal (XDG_CONFIG_HOME/homedir), not user input
		raw = await readFile(filePath, "utf8");
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT") {
			return {};
		}
		await onWarning("config invalid", {
			error: errorMessage(error),
			file: filePath,
			reason: "read",
		});
		return {};
	}

	let parsed: unknown;
	try {
		parsed = raw ? (JSON.parse(raw) as unknown) : undefined;
	} catch (error) {
		await onWarning("config invalid", {
			error: errorMessage(error),
			file: filePath,
			reason: "json",
		});
		return {};
	}
	if (parsed === undefined) {
		return {};
	}

	const { profile, warnings } = validateProfile(parsed);
	for (const reason of warnings) {
		await onWarning(reason, { file: filePath, reason });
	}
	return profile;
};

export { configPath, loadConfig, type Profile, validateProfile };
