import { mkdir, readFile, writeFile } from "node:fs/promises";
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

const loadStateEntries = (state: Map<string, string[]>, raw: string): boolean => {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return true;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return true;
	}
	for (const [key, value] of Object.entries(parsed)) {
		if (!Array.isArray(value)) {
			continue;
		}
		const keys = value
			.map((item) => (typeof item === "number" ? `review:${item}` : item))
			.filter(
				(item): item is string =>
					typeof item === "string" && /^(review|conversation):\d+$/.test(item),
			);
		if (keys.length) {
			state.set(key, keys);
		}
	}
	return false;
};

const loadState = async (
	filePath = statePath(),
	onCorrupt: () => void | Promise<void> = () => {
		process.stderr.write("Warning: state file is corrupted, resetting.\n");
	},
): Promise<Map<string, string[]>> => {
	const state = new Map<string, string[]>();
	const raw = await readRawState(filePath);
	if (raw === "") {
		return state;
	}
	if (loadStateEntries(state, raw)) {
		await onCorrupt();
	}
	return state;
};

const saveState = async (state: Map<string, string[]>, filePath = statePath()): Promise<void> => {
	const dir = path.dirname(filePath);
	// oxlint-disable-next-line security/detect-non-literal-fs-filename -- state dir is internal (XDG_CONFIG_HOME/homedir), not user input
	await mkdir(dir, { recursive: true });
	// oxlint-disable-next-line security/detect-non-literal-fs-filename -- state path is internal (XDG_CONFIG_HOME/homedir), not user input
	await writeFile(filePath, JSON.stringify(Object.fromEntries(state)));
};

export { loadState, saveState, statePath };
