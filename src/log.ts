import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { statePath } from "./state.js";

type Logger = (event: string, fields?: Record<string, unknown>) => Promise<void>;

const DEFAULT_MAX_BYTES = 1_000_000;

const rotateIfNeeded = async (filePath: string, maxBytes: number): Promise<void> => {
	let size: number;
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- filePath is the config dir or an explicit override, not user input
		size = (await stat(filePath)).size;
	} catch {
		return;
	}
	if (size <= maxBytes) {
		return;
	}
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- rotated path is derived from the internal log path
		await rename(filePath, `${filePath}.1`);
	} catch {}
};

const createLogger =
	({
		filePath = path.join(path.dirname(statePath()), "crewmate.log"),
		maxBytes = DEFAULT_MAX_BYTES,
		toStderr = false,
	}: { filePath?: string; maxBytes?: number; toStderr?: boolean } = {}): Logger =>
	async (event, fields = {}) => {
		const at = new Date().toISOString();
		const line = JSON.stringify({ ...fields, event, at }) + "\n";
		try {
			// oxlint-disable-next-line security/detect-non-literal-fs-filename -- filePath is the config dir or an explicit override, not user input
			await mkdir(path.dirname(filePath), { recursive: true });
			await rotateIfNeeded(filePath, maxBytes);
			// oxlint-disable-next-line security/detect-non-literal-fs-filename -- same as above
			await appendFile(filePath, line, "utf8");
		} catch (error) {
			const message = String(error);
			const warning = toStderr
				? JSON.stringify({ event: "warning", message, at }) + "\n"
				: `Warning: crewmate log failed: ${message}\n`;
			try {
				process.stderr.write(warning);
			} catch {}
			return;
		}
		if (toStderr) {
			try {
				process.stderr.write(line);
			} catch {}
		}
	};

export { createLogger, type Logger };
