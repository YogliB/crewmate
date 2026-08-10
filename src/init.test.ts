import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import process from "node:process";
import { runInit } from "./init.js";
import { globalConfigPath } from "./config.js";

const { mkdir, readFile, writeFile } = vi.hoisted(() => ({
	mkdir: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ mkdir, readFile, writeFile }));

const { createInterface } = vi.hoisted(() => ({ createInterface: vi.fn() }));
vi.mock("node:readline/promises", () => ({ createInterface }));

const makeError = (code: string): Error => Object.assign(new Error(code), { code });

const makeReadline = (answers: string[]) => {
	let index = 0;
	const close = vi.fn();
	const question = vi.fn(async () => {
		if (index >= answers.length) {
			return "";
		}
		const answer = answers[index];
		index += 1;
		return answer;
	});
	return { close, question };
};

type RunInitWith = {
	answers?: string[];
	existing?: string;
	existingError?: Error;
	writeError?: string;
	readline?: ReturnType<typeof makeReadline>;
};

const buildDefaults = (values: Record<string, unknown>) =>
	JSON.stringify({ defaults: values }, null, 2);

const runInitWith = async ({
	answers,
	existing,
	existingError,
	writeError,
	readline,
}: RunInitWith = {}): Promise<void> => {
	if (existingError) {
		readFile.mockRejectedValueOnce(existingError);
	} else if (typeof existing === "string") {
		readFile.mockResolvedValueOnce(existing);
	} else {
		readFile.mockRejectedValueOnce(makeError("ENOENT"));
	}
	if (readline) {
		createInterface.mockReturnValueOnce(readline);
	} else if (answers) {
		createInterface.mockReturnValueOnce(makeReadline(answers));
	}
	mkdir.mockResolvedValueOnce(undefined);
	if (writeError) {
		writeFile.mockRejectedValueOnce(makeError(writeError));
	} else {
		writeFile.mockResolvedValueOnce(undefined);
	}
	return runInit();
};

describe("runInit", () => {
	beforeEach(() => {
		process.exitCode = undefined;
		process.stdin.isTTY = true;
		vi.stubEnv("XDG_CONFIG_HOME", "/tmp/crewmate-init-test");
		mkdir.mockReset();
		readFile.mockReset();
		writeFile.mockReset();
		createInterface.mockReset();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it("exits when not running in a TTY", async () => {
		process.stdin.isTTY = false;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await runInit();
		expect(process.exitCode).toBe(1);
		expect(stderr).toHaveBeenCalledWith("init requires an interactive terminal\n");
		expect(readFile).not.toHaveBeenCalled();
		expect(createInterface).not.toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
		stderr.mockRestore();
	});

	it("writes a full defaults profile", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runInitWith({
			answers: ["claude", "sonnet", "60", "alice", "be terse", "y"],
		});

		expect(process.exitCode).toBeUndefined();
		expect(mkdir).toHaveBeenCalledWith(path.dirname(globalConfigPath()), { recursive: true });
		expect(writeFile).toHaveBeenCalledWith(
			globalConfigPath(),
			buildDefaults({
				provider: "claude",
				model: "sonnet",
				interval: 60,
				user: "alice",
				prompt: "be terse",
				fix: true,
			}),
		);
		expect(stdout).toHaveBeenCalledWith(`Wrote config to ${globalConfigPath()}\n`);
		stdout.mockRestore();
	});

	it("omits blank and whitespace answers and defaults fix to false", async () => {
		await runInitWith({ answers: ["", "  ", "\t", "\n", " ", "   "] });

		expect(writeFile).toHaveBeenCalledWith(globalConfigPath(), buildDefaults({ fix: false }));
	});

	it("preserves profiles, unknown top-level keys, and existing defaults", async () => {
		await runInitWith({
			answers: ["claude", "", "", "alice", "", "n"],
			existing: JSON.stringify({
				defaults: { model: "old-model", interval: 120, unknownKey: "keep" },
				profiles: { "owner/repo": { provider: "other" } },
				extra: 1,
			}),
		});

		expect(writeFile).toHaveBeenCalledWith(
			globalConfigPath(),
			JSON.stringify(
				{
					defaults: {
						model: "old-model",
						interval: 120,
						unknownKey: "keep",
						provider: "claude",
						user: "alice",
						fix: false,
					},
					profiles: { "owner/repo": { provider: "other" } },
					extra: 1,
				},
				null,
				2,
			),
		);
	});

	it("disables an existing fix when the fix answer is blank", async () => {
		await runInitWith({
			answers: ["", "", "", "", "", ""],
			existing: JSON.stringify({ defaults: { fix: true } }),
		});

		expect(writeFile).toHaveBeenCalledWith(globalConfigPath(), buildDefaults({ fix: false }));
	});

	it("treats empty and whitespace-only existing config as fresh", async () => {
		await runInitWith({
			answers: ["claude", "", "", "", "", ""],
			existing: "   \n",
		});

		expect(writeFile).toHaveBeenCalledWith(
			globalConfigPath(),
			buildDefaults({ provider: "claude", fix: false }),
		);
	});

	it("exits when the existing config is not valid JSON", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await runInitWith({ existing: "{not json" });
		expect(process.exitCode).toBe(1);
		expect(stderr).toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
		stderr.mockRestore();
	});

	it("exits when the existing config is not a JSON object", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await runInitWith({ existing: "[]" });
		expect(process.exitCode).toBe(1);
		expect(stderr).toHaveBeenCalledWith("Error: config is not a JSON object\n");
		expect(writeFile).not.toHaveBeenCalled();
		stderr.mockRestore();
	});

	it("exits on non-ENOENT read errors", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await runInitWith({ existingError: makeError("EACCES") });
		expect(process.exitCode).toBe(1);
		expect(stderr).toHaveBeenCalledWith("Error: EACCES\n");
		expect(writeFile).not.toHaveBeenCalled();
		stderr.mockRestore();
	});

	it("exits and closes the readline interface when a prompt fails", async () => {
		const { close, question } = makeReadline([]);
		question.mockRejectedValueOnce(new Error("prompt failed"));
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runInitWith({ readline: { close, question } });

		expect(process.exitCode).toBe(1);
		expect(close).toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
		stderr.mockRestore();
	});

	it("exits when the config cannot be written", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runInitWith({
			answers: ["claude", "", "", "", "", ""],
			writeError: "EACCES",
		});

		expect(process.exitCode).toBe(1);
		expect(stderr).toHaveBeenCalledWith("Error: EACCES\n");
		stderr.mockRestore();
	});

	it("warns and drops invalid interval values", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runInitWith({ answers: ["", "", "abc", "", "", ""] });

		expect(stderr).toHaveBeenCalledWith("Warning: invalid type for interval\n");
		expect(writeFile).toHaveBeenCalledWith(globalConfigPath(), buildDefaults({ fix: false }));
		stderr.mockRestore();
	});

	it("warns and drops invalid fix values", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runInitWith({ answers: ["", "", "", "", "", "maybe"] });

		expect(stderr).toHaveBeenCalledWith("Warning: invalid type for fix\n");
		expect(writeFile).toHaveBeenCalledWith(globalConfigPath(), buildDefaults({}));
		stderr.mockRestore();
	});

	it("accepts yes and no for fix", async () => {
		await runInitWith({ answers: ["", "", "", "", "", "yes"] });

		expect(writeFile).toHaveBeenCalledWith(globalConfigPath(), buildDefaults({ fix: true }));
	});

	it("accepts n for fix", async () => {
		await runInitWith({ answers: ["", "", "", "", "", "n"] });

		expect(writeFile).toHaveBeenCalledWith(globalConfigPath(), buildDefaults({ fix: false }));
	});

	it("treats a non-object existing defaults as empty", async () => {
		await runInitWith({
			answers: ["claude", "", "", "", "", ""],
			existing: JSON.stringify({ defaults: "string" }),
		});

		expect(writeFile).toHaveBeenCalledWith(
			globalConfigPath(),
			buildDefaults({ provider: "claude", fix: false }),
		);
	});
});
