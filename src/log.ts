import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { statePath } from "./state.js";

type Logger = (event: string, fields?: Record<string, unknown>) => Promise<void>;

const createLogger =
	({
		filePath = path.join(path.dirname(statePath()), "pickup.log"),
		toStderr = false,
	}: { filePath?: string; toStderr?: boolean } = {}): Logger =>
	async (event, fields = {}) => {
		const at = new Date().toISOString();
		const line = JSON.stringify({ ...fields, event, at }) + "\n";
		try {
			// oxlint-disable-next-line security/detect-non-literal-fs-filename -- filePath is the config dir or an explicit override, not user input
			await mkdir(path.dirname(filePath), { recursive: true });
			// oxlint-disable-next-line security/detect-non-literal-fs-filename -- same as above
			await appendFile(filePath, line, "utf8");
		} catch (error) {
			const message = String(error);
			const warning = toStderr
				? JSON.stringify({ event: "warning", message, at }) + "\n"
				: `Warning: pickup log failed: ${message}\n`;
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
