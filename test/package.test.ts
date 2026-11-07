import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface PackageManifest {
	name: string;
	type: string;
	private: boolean;
	pi: { extensions: string[] };
	dependencies?: Record<string, string>;
	peerDependencies: Record<string, string>;
	peerDependenciesMeta: Record<string, { optional?: boolean }>;
	devDependencies: Record<string, string>;
}

interface PackResult {
	files: { path: string }[];
}

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
const hostPackages = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];

test("the package declares an explicit ESM pi entry point and publication guard", () => {
	assert.equal(manifest.name, "pi-register");
	assert.equal(manifest.type, "module");
	assert.equal(manifest.private, true);
	assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
});

test("host packages are optional peers with pinned development versions", () => {
	for (const name of hostPackages) {
		assert.equal(manifest.dependencies?.[name], undefined, name);
		assert.equal(manifest.peerDependencies[name], "*", name);
		assert.equal(manifest.peerDependenciesMeta[name]?.optional, true, name);
		assert.match(manifest.devDependencies[name] ?? "", /^\d+\.\d+\.\d+$/, name);
	}
});

test("the npm package includes its entry point and excludes development and working data", async () => {
	const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const packages = JSON.parse(output) as PackResult[];
	const packaged = packages[0];
	assert.ok(packaged);
	const paths = packaged.files.map((file) => file.path);

	for (const required of [
		"index.ts",
		"src/extension.ts",
		"src/controller.ts",
		"src/text.ts",
		"src/prompts.ts",
		"src/viewer.ts",
		"compat/pi-compact-model.patch",
		"assets/brand/register-pi.png",
		"assets/brand/register-pi.svg",
		"assets/brand/register-horizontal.svg",
		"assets/brand/register-icon.svg",
		"assets/brand/register-icon-small.svg",
		"assets/architecture/register-architecture.svg",
		"assets/architecture/register-architecture.png",
		"arch.md",
		"package.json",
		"README.md",
		"CHANGELOG.md",
		"LICENSE",
	]) {
		assert.ok(paths.includes(required), required);
	}
	for (const file of await readdir(new URL("../src/", import.meta.url))) {
		assert.ok(paths.includes(`src/${file}`), `runtime source src/${file}`);
	}
	for (const path of paths) {
		assert.doesNotMatch(
			path,
			/^(?:test|eval|tools|node_modules|\.github|\.git)\/|^(?:AGENTS\.md|EVALUATION\.md|auth\.json|package-lock\.json|tsconfig\.json|biome\.json)$|\.(?:sqlite|db|log|tgz)(?:-|$)/,
		);
	}
});
