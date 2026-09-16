import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { configPath, loadConfig, validateProfile } = await import("./config.js");

describe("config", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-config-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	it("resolves the config path under the crewmate config dir", () => {
		expect(configPath()).toBe(path.join(tempDir, "crewmate", "config.json"));
	});

	it("returns an empty profile when the file is missing", async () => {
		const warn = vi.fn();
		expect(await loadConfig(warn)).toEqual({});
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns and returns empty when the file cannot be read", async () => {
		const dir = path.join(tempDir, "crewmate");
		await mkdir(dir, { recursive: true });
		const filePath = path.join(dir, "config.json");
		await writeFile(filePath, "{}");
		await chmod(filePath, 0o000);
		const warn = vi.fn();
		expect(await loadConfig(warn)).toEqual({});
		expect(warn).toHaveBeenCalledWith(
			"config invalid",
			expect.objectContaining({ reason: "read" }),
		);
		await chmod(filePath, 0o600);
	});

	it("warns and returns empty on invalid JSON", async () => {
		const dir = path.join(tempDir, "crewmate");
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "config.json"), "nope{");
		const warn = vi.fn();
		expect(await loadConfig(warn)).toEqual({});
		expect(warn).toHaveBeenCalledWith(
			"config invalid",
			expect.objectContaining({ reason: "json" }),
		);
	});

	it("returns an empty profile for an empty file", async () => {
		const dir = path.join(tempDir, "crewmate");
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "config.json"), "");
		const warn = vi.fn();
		expect(await loadConfig(warn)).toEqual({});
		expect(warn).not.toHaveBeenCalled();
	});

	it("loads a valid flat profile and warns about bad keys", async () => {
		const dir = path.join(tempDir, "crewmate");
		await mkdir(dir, { recursive: true });
		await writeFile(
			path.join(dir, "config.json"),
			JSON.stringify({
				$schema: "https://example.com/schema.json",
				provider: "my-llm",
				model: "opus",
				interval: 120,
				timeoutSeconds: 300,
				user: "alice",
				prompt: "Be terse",
				log: true,
				debug: false,
				unsafeNoUser: false,
				fix: true,
				profiles: { "owner/repo": {} },
				intervalBad: undefined,
				unknown: 1,
			}),
		);
		const warn = vi.fn();
		const profile = await loadConfig(warn);
		expect(profile).toEqual({
			provider: "my-llm",
			model: "opus",
			interval: 120,
			timeoutSeconds: 300,
			user: "alice",
			prompt: "Be terse",
			log: true,
			debug: false,
			unsafeNoUser: false,
		});
		const reasons = warn.mock.calls.map((call) => call[0]);
		expect(reasons).toContain("fix is no longer supported; remove it from your config");
		expect(reasons).toContain("profiles is no longer supported; remove it from your config");
		expect(reasons).toContain("unknown key unknown");
	});

	it("warns about invalid value types", async () => {
		const dir = path.join(tempDir, "crewmate");
		await mkdir(dir, { recursive: true });
		await writeFile(
			path.join(dir, "config.json"),
			JSON.stringify({ interval: "soon", timeoutSeconds: 0, log: "yes", provider: 3 }),
		);
		const warn = vi.fn();
		expect(await loadConfig(warn)).toEqual({});
		const reasons = warn.mock.calls.map((call) => call[0]);
		expect(reasons).toContain("invalid type for interval");
		expect(reasons).toContain("invalid type for timeoutSeconds");
		expect(reasons).toContain("invalid type for log");
		expect(reasons).toContain("invalid type for provider");
	});

	it("validateProfile warns when the config is not an object", () => {
		const { profile, warnings } = validateProfile([1]);
		expect(profile).toEqual({});
		expect(warnings).toEqual(["config is not an object"]);
	});

	it("warns with a stringified error when JSON.parse throws a non-Error", async () => {
		const dir = path.join(tempDir, "crewmate");
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "config.json"), "{}");
		const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
			throw "boom";
		});
		const warn = vi.fn();
		expect(await loadConfig(warn)).toEqual({});
		expect(warn).toHaveBeenCalledWith("config invalid", expect.objectContaining({ error: "boom" }));
		parse.mockRestore();
	});
});
