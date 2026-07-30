import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { homedir } from "node:os";

const statePath = (): string =>
	path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "pickup", "state.json");

const readRawState = async (filePath: string): Promise<string> => {
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- state path is internal (XDG_CONFIG_HOME/homedir), not user input
		return await readFile(filePath, "utf8");
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT") {
			return "";
		}
		process.stderr.write(
			`Warning: could not read state file, resetting: ${(error as Error).message}\n`,
		);
		return "";
	}
};

const loadStateEntries = (state: Map<string, number[]>, raw: string): void => {
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	for (const [key, value] of Object.entries(parsed)) {
		if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
			state.set(key, value as number[]);
		}
	}
};

const loadState = async (filePath = statePath()): Promise<Map<string, number[]>> => {
	const state = new Map<string, number[]>();
	const raw = await readRawState(filePath);
	if (raw === "") {
		return state;
	}
	loadStateEntries(state, raw);
	return state;
};

const saveState = async (state: Map<string, number[]>, filePath = statePath()): Promise<void> => {
	const dir = path.join(filePath, "..");
	// oxlint-disable-next-line security/detect-non-literal-fs-filename -- state dir is internal (XDG_CONFIG_HOME/homedir), not user input
	await mkdir(dir, { recursive: true });
	// oxlint-disable-next-line security/detect-non-literal-fs-filename -- state path is internal (XDG_CONFIG_HOME/homedir), not user input
	await writeFile(filePath, JSON.stringify(Object.fromEntries(state)));
};

export { loadState, saveState, statePath };
