import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
	globalConfigPath,
	loadGlobalConfig,
	loadRepoConfig,
	repoConfigPath,
	resolveProfile,
	validateProfile,
} from "./config.js";
import { statePath } from "./state.js";

const writeGlobalConfig = async (content: string) => {
	const filePath = globalConfigPath();
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf8");
};

describe("config paths", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-config-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	it("derives global config path from state path", () => {
		expect(globalConfigPath()).toBe(path.join(tempDir, "pickup", "config.json"));
		expect(statePath()).toBe(path.join(tempDir, "pickup", "state.json"));
	});

	it("derives repo config path from repo root", () => {
		expect(repoConfigPath("/repo")).toBe(path.join("/repo", ".pickup.json"));
	});
});

describe("validateProfile", () => {
	it("returns empty profile for non-objects", () => {
		expect(validateProfile(null)).toEqual({ profile: {}, warnings: ["config is not an object"] });
		expect(validateProfile(undefined)).toEqual({
			profile: {},
			warnings: ["config is not an object"],
		});
		expect(validateProfile(["foo"]).warnings).toContain("config is not an object");
	});

	it("collects all valid string fields", () => {
		const result = validateProfile({
			provider: "my-llm",
			model: "best",
			user: "alice",
			prompt: "be terse",
		});
		expect(result.profile).toEqual({
			provider: "my-llm",
			model: "best",
			user: "alice",
			prompt: "be terse",
		});
		expect(result.warnings).toHaveLength(0);
	});

	it("collects all valid number and boolean fields", () => {
		const result = validateProfile({
			interval: 30,
			fix: true,
			dryRun: false,
			log: true,
		});
		expect(result.profile).toEqual({
			interval: 30,
			fix: true,
			dryRun: false,
			log: true,
		});
		expect(result.warnings).toHaveLength(0);
	});

	it("ignores unknown keys", () => {
		const result = validateProfile({ unknown: "value", provider: "my-llm" });
		expect(result.profile).toEqual({ provider: "my-llm" });
		expect(result.warnings).toHaveLength(0);
	});

	it("warns on invalid types for known keys", () => {
		const result = validateProfile({
			provider: 123,
			interval: "30",
			fix: "yes",
			prompt: "ok",
		});
		expect(result.profile).toEqual({ prompt: "ok" });
		expect(result.warnings).toEqual([
			"invalid type for provider",
			"invalid type for interval",
			"invalid type for fix",
		]);
	});

	it("rejects non-positive or non-integer intervals", () => {
		expect(validateProfile({ interval: 0 }).warnings).toContain("invalid type for interval");
		expect(validateProfile({ interval: -1 }).warnings).toContain("invalid type for interval");
		expect(validateProfile({ interval: 1.5 }).warnings).toContain("invalid type for interval");
	});
});

describe("loadGlobalConfig", () => {
	let tempDir = "";
	const warn = vi.fn(() => Promise.resolve());

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-global-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
		warn.mockClear();
	});

	it("returns empty profile when global config is missing", async () => {
		const profile = await loadGlobalConfig("owner", "repo", warn);
		expect(profile).toEqual({});
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns and returns empty when global config cannot be read", async () => {
		await writeGlobalConfig("{}");
		await chmod(globalConfigPath(), 0o000);
		const profile = await loadGlobalConfig("owner", "repo", warn);
		expect(profile).toEqual({});
		expect(warn).toHaveBeenCalledWith("config invalid", expect.any(Object));
		await chmod(globalConfigPath(), 0o644);
	});

	it("returns empty profile when global config is empty", async () => {
		await writeGlobalConfig("");
		const profile = await loadGlobalConfig("owner", "repo", warn);
		expect(profile).toEqual({});
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns with a string error from JSON.parse", async () => {
		await writeGlobalConfig("{}");
		const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
			throw "boom";
		});
		const profile = await loadGlobalConfig("owner", "repo", warn);
		expect(profile).toEqual({});
		expect(warn).toHaveBeenCalledWith("config invalid", expect.objectContaining({ error: "boom" }));
		parse.mockRestore();
	});

	it("loads defaults", async () => {
		await writeGlobalConfig(JSON.stringify({ defaults: { provider: "claude", interval: 30 } }));
		const profile = await loadGlobalConfig("owner", "repo", warn);
		expect(profile).toEqual({ provider: "claude", interval: 30 });
		expect(warn).not.toHaveBeenCalled();
	});

	it("selects a matching repo profile over defaults", async () => {
		await writeGlobalConfig(
			JSON.stringify({
				defaults: { provider: "claude", interval: 30 },
				profiles: { "owner/repo": { provider: "my-llm", prompt: "be terse" } },
			}),
		);
		const profile = await loadGlobalConfig("owner", "repo", warn);
		expect(profile).toEqual({ provider: "my-llm", prompt: "be terse", interval: 30 });
	});

	it("falls back to defaults when no repo profile matches", async () => {
		await writeGlobalConfig(
			JSON.stringify({
				defaults: { provider: "claude" },
				profiles: { "other/repo": { provider: "my-llm" } },
			}),
		);
		const profile = await loadGlobalConfig("owner", "repo", warn);
		expect(profile).toEqual({ provider: "claude" });
	});

	it("warns and returns empty when global config is not an object", async () => {
		await writeGlobalConfig("[]");
		const profile = await loadGlobalConfig("owner", "repo", warn);
		expect(profile).toEqual({});
		expect(warn).toHaveBeenCalledWith("global config is not an object", expect.any(Object));
	});

	it("warns when defaults is not an object", async () => {
		await writeGlobalConfig(JSON.stringify({ defaults: "nope" }));
		const profile = await loadGlobalConfig("owner", "repo", warn);
		expect(profile).toEqual({});
		expect(warn).toHaveBeenCalledWith("defaults is not an object", expect.any(Object));
	});

	it("warns when profiles is not an object", async () => {
		await writeGlobalConfig(JSON.stringify({ profiles: ["nope"] }));
		const profile = await loadGlobalConfig("owner", "repo", warn);
		expect(profile).toEqual({});
		expect(warn).toHaveBeenCalledWith("profiles is not an object", expect.any(Object));
	});

	it("warns when a repo profile is not an object", async () => {
		await writeGlobalConfig(JSON.stringify({ profiles: { "owner/repo": "nope" } }));
		const profile = await loadGlobalConfig("owner", "repo", warn);
		expect(profile).toEqual({});
		expect(warn).toHaveBeenCalledWith(
			'profiles["owner/repo"] is not an object',
			expect.any(Object),
		);
	});

	it("warns when global config is a bare profile", async () => {
		await writeGlobalConfig(JSON.stringify({ provider: "my-llm" }));
		const profile = await loadGlobalConfig("owner", "repo", warn);
		expect(profile).toEqual({});
		expect(warn).toHaveBeenCalledWith(
			"global config looks like a bare profile; wrap it in 'defaults' or 'profiles'",
			expect.any(Object),
		);
	});

	it("warns on invalid types inside a matched profile but keeps valid fields", async () => {
		await writeGlobalConfig(
			JSON.stringify({
				profiles: { "owner/repo": { provider: "my-llm", interval: "fast" } },
			}),
		);
		const profile = await loadGlobalConfig("owner", "repo", warn);
		expect(profile).toEqual({ provider: "my-llm" });
		expect(warn).toHaveBeenCalledWith("invalid type for interval", expect.any(Object));
	});

	it("warns and returns empty on invalid JSON", async () => {
		await writeGlobalConfig("{not json");
		const profile = await loadGlobalConfig("owner", "repo", warn);
		expect(profile).toEqual({});
		expect(warn).toHaveBeenCalledWith(
			"config invalid",
			expect.objectContaining({ reason: "json" }),
		);
	});
});

describe("loadRepoConfig", () => {
	let tempDir = "";
	const warn = vi.fn(() => Promise.resolve());

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-repo-"));
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		warn.mockClear();
	});

	it("returns empty profile when repo config is missing", async () => {
		const profile = await loadRepoConfig(tempDir, warn);
		expect(profile).toEqual({});
		expect(warn).not.toHaveBeenCalled();
	});

	it("loads repo config", async () => {
		await writeFile(
			path.join(tempDir, ".pickup.json"),
			JSON.stringify({ prompt: "repo prompt" }),
			"utf8",
		);
		const profile = await loadRepoConfig(tempDir, warn);
		expect(profile).toEqual({ prompt: "repo prompt" });
	});

	it("warns and returns empty on invalid JSON", async () => {
		await writeFile(path.join(tempDir, ".pickup.json"), "{not json", "utf8");
		const profile = await loadRepoConfig(tempDir, warn);
		expect(profile).toEqual({});
		expect(warn).toHaveBeenCalledWith(
			"config invalid",
			expect.objectContaining({ reason: "json" }),
		);
	});

	it("warns and returns empty when repo config is not an object", async () => {
		await writeFile(path.join(tempDir, ".pickup.json"), "[]", "utf8");
		const profile = await loadRepoConfig(tempDir, warn);
		expect(profile).toEqual({});
		expect(warn).toHaveBeenCalledWith("config is not an object", expect.any(Object));
	});

	it("warns on invalid type but keeps valid fields", async () => {
		await writeFile(
			path.join(tempDir, ".pickup.json"),
			JSON.stringify({ prompt: "repo", fix: "yes" }),
			"utf8",
		);
		const profile = await loadRepoConfig(tempDir, warn);
		expect(profile).toEqual({ prompt: "repo" });
		expect(warn).toHaveBeenCalledWith("invalid type for fix", expect.any(Object));
	});

	it("warns when repo config enables fix", async () => {
		await writeFile(path.join(tempDir, ".pickup.json"), JSON.stringify({ fix: true }), "utf8");
		const profile = await loadRepoConfig(tempDir, warn);
		expect(profile).toEqual({ fix: true });
		expect(warn).toHaveBeenCalledWith(
			"repo .pickup.json enables --fix; only run pickup in repositories you trust",
			expect.any(Object),
		);
	});

	it("warns when repo config uses a relative provider", async () => {
		await writeFile(
			path.join(tempDir, ".pickup.json"),
			JSON.stringify({ provider: "./claude" }),
			"utf8",
		);
		const profile = await loadRepoConfig(tempDir, warn);
		expect(profile).toEqual({ provider: "./claude" });
		expect(warn).toHaveBeenCalledWith(
			"repo .pickup.json uses a local/relative LLM provider; only run pickup in repositories you trust",
			expect.any(Object),
		);
	});
});

describe("resolveProfile", () => {
	let globalDir = "";
	let repoDir = "";
	const warn = vi.fn(() => Promise.resolve());

	beforeEach(async () => {
		globalDir = await mkdtemp(path.join(tmpdir(), "pickup-resolve-global-"));
		repoDir = await mkdtemp(path.join(tmpdir(), "pickup-resolve-repo-"));
		vi.stubEnv("XDG_CONFIG_HOME", globalDir);
	});

	afterEach(async () => {
		await rm(globalDir, { force: true, recursive: true });
		await rm(repoDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
		warn.mockClear();
	});

	it("merges global defaults with repo overrides", async () => {
		await writeGlobalConfig(JSON.stringify({ defaults: { provider: "claude", interval: 30 } }));
		await writeFile(
			path.join(repoDir, ".pickup.json"),
			JSON.stringify({ prompt: "repo", interval: 10 }),
			"utf8",
		);
		const profile = await resolveProfile("owner", "repo", repoDir, warn);
		expect(profile).toEqual({ provider: "claude", prompt: "repo", interval: 10 });
	});

	it("merges global repo profile with repo overrides", async () => {
		await writeGlobalConfig(
			JSON.stringify({
				profiles: { "owner/repo": { provider: "my-llm" } },
			}),
		);
		await writeFile(path.join(repoDir, ".pickup.json"), JSON.stringify({ prompt: "repo" }), "utf8");
		const profile = await resolveProfile("owner", "repo", repoDir, warn);
		expect(profile).toEqual({ provider: "my-llm", prompt: "repo" });
	});

	it("returns empty profile when both files are missing", async () => {
		const profile = await resolveProfile("owner", "repo", repoDir, warn);
		expect(profile).toEqual({});
	});

	it("applies precedence: repo > global profile > global defaults", async () => {
		await writeGlobalConfig(
			JSON.stringify({
				defaults: { provider: "claude", interval: 30 },
				profiles: { "owner/repo": { provider: "my-llm", interval: 60 } },
			}),
		);
		await writeFile(
			path.join(repoDir, ".pickup.json"),
			JSON.stringify({ user: "alice", interval: 10 }),
			"utf8",
		);
		const profile = await resolveProfile("owner", "repo", repoDir, warn);
		expect(profile).toEqual({ provider: "my-llm", user: "alice", interval: 10 });
	});

	it("reads boolean log and dryRun fields", async () => {
		await writeFile(
			path.join(repoDir, ".pickup.json"),
			JSON.stringify({ log: true, dryRun: false }),
			"utf8",
		);
		const profile = await resolveProfile("owner", "repo", repoDir, warn);
		expect(profile).toEqual({ log: true, dryRun: false });
	});

	it("merges global defaults with global profile when repo config is missing", async () => {
		await writeGlobalConfig(
			JSON.stringify({
				defaults: { provider: "claude", interval: 30 },
				profiles: { "owner/repo": { provider: "my-llm" } },
			}),
		);
		const profile = await resolveProfile("owner", "repo", repoDir, warn);
		expect(profile).toEqual({ provider: "my-llm", interval: 30 });
	});

	it("lets repo config override a matching global profile", async () => {
		await writeGlobalConfig(
			JSON.stringify({
				profiles: { "owner/repo": { provider: "my-llm", interval: 60 } },
			}),
		);
		await writeFile(
			path.join(repoDir, ".pickup.json"),
			JSON.stringify({ interval: 10, user: "alice" }),
			"utf8",
		);
		const profile = await resolveProfile("owner", "repo", repoDir, warn);
		expect(profile).toEqual({ provider: "my-llm", interval: 10, user: "alice" });
	});

	it("ignores a non-matching global profile and falls back to defaults", async () => {
		await writeGlobalConfig(
			JSON.stringify({
				defaults: { provider: "claude", interval: 30 },
				profiles: { "other/repo": { provider: "my-llm" } },
			}),
		);
		const profile = await resolveProfile("owner", "repo", repoDir, warn);
		expect(profile).toEqual({ provider: "claude", interval: 30 });
	});

	it("matches a global profile case-insensitively", async () => {
		await writeGlobalConfig(
			JSON.stringify({
				profiles: { "Owner/Repo": { provider: "my-llm" } },
			}),
		);
		const profile = await resolveProfile("owner", "repo", repoDir, warn);
		expect(profile).toEqual({ provider: "my-llm" });
	});

	it("matches an org profile by owner only", async () => {
		await writeGlobalConfig(
			JSON.stringify({
				profiles: { myorg: { provider: "my-llm" } },
			}),
		);
		const profile = await resolveProfile("MyOrg", undefined, repoDir, warn);
		expect(profile).toEqual({ provider: "my-llm" });
	});

	it("matches a lowercase config key against uppercase PR identifiers", async () => {
		await writeGlobalConfig(
			JSON.stringify({
				profiles: { "owner/repo": { provider: "my-llm" } },
			}),
		);
		const profile = await resolveProfile("OWNER", "REPO", repoDir, warn);
		expect(profile).toEqual({ provider: "my-llm" });
	});

	it("returns the global profile when repoRoot is undefined", async () => {
		await writeGlobalConfig(
			JSON.stringify({
				defaults: { provider: "claude", interval: 30 },
			}),
		);
		const profile = await resolveProfile("owner", "repo", undefined, warn);
		expect(profile).toEqual({ provider: "claude", interval: 30 });
	});
});
