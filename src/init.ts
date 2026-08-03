import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import {
	errorMessage,
	globalConfigPath,
	isPlainObject,
	type Profile,
	validateProfile,
} from "./config.js";

const PROMPTS: { key: keyof Profile; text: string }[] = [
	{ key: "provider", text: "provider (claude): " },
	{ key: "model", text: "model: " },
	{ key: "interval", text: "interval (60): " },
	{ key: "user", text: "user: " },
	{ key: "prompt", text: "prompt: " },
	{ key: "fix", text: "enable fix? (y/N): " },
];

const parseAnswer = (key: keyof Profile, raw: string): unknown => {
	const value = raw.trim();
	if (value === "") {
		return key === "fix" ? false : undefined;
	}
	if (key === "fix") {
		const lower = value.toLowerCase();
		if (lower === "y" || lower === "yes") {
			return true;
		}
		if (lower === "n" || lower === "no") {
			return false;
		}
		return value;
	}
	if (key === "interval") {
		return Number(value);
	}
	return value;
};

const readExistingConfig = async (configPath: string): Promise<Record<string, unknown>> => {
	let raw = "";
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- config path is internal, not user input
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT") {
			return {};
		}
		throw error;
	}
	if (raw.trim() === "") {
		return {};
	}
	const parsed = JSON.parse(raw) as unknown;
	if (!isPlainObject(parsed)) {
		throw new Error("config is not a JSON object");
	}
	return parsed;
};

const runInit = async (): Promise<void> => {
	if (!process.stdin.isTTY) {
		process.stderr.write("init requires an interactive terminal\n");
		process.exitCode = 1;
		return;
	}

	const configPath = globalConfigPath();
	let existing: Record<string, unknown>;
	try {
		existing = await readExistingConfig(configPath);
	} catch (error) {
		process.stderr.write(`Error: ${errorMessage(error)}\n`);
		process.exitCode = 1;
		return;
	}

	const rl = createInterface({ input: process.stdin, output: process.stderr });
	const answers: Record<string, unknown> = {};
	try {
		for (const { key, text } of PROMPTS) {
			const answer = await rl.question(text);
			const parsed = parseAnswer(key, answer);
			if (parsed !== undefined) {
				// oxlint-disable-next-line security/detect-object-injection -- key comes from the hard-coded PROMPTS list
				answers[key] = parsed;
			}
		}
	} catch (error) {
		process.stderr.write(`Error: ${errorMessage(error)}\n`);
		process.exitCode = 1;
		return;
	} finally {
		rl.close();
	}

	const { profile, warnings } = validateProfile(answers);
	for (const warning of warnings) {
		process.stderr.write(`Warning: ${warning}\n`);
	}

	const defaults = {
		...(isPlainObject(existing?.defaults) ? (existing.defaults as Record<string, unknown>) : {}),
		...profile,
	};

	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- config path is internal, not user input
		await mkdir(path.dirname(configPath), { recursive: true });
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- config path is internal, not user input
		await writeFile(configPath, JSON.stringify({ ...existing, defaults }, null, 2));
		process.stdout.write(`Wrote config to ${configPath}\n`);
	} catch (error) {
		process.stderr.write(`Error: ${errorMessage(error)}\n`);
		process.exitCode = 1;
	}
};

export { runInit };
