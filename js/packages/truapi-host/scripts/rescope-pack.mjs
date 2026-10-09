#!/usr/bin/env node
// Pack the built package as @polkadot-community-foundation/truapi-host
// without renaming it in-tree. Expects `npm run build` and `npm run build:wasm`
// to have run.
//
// Only `name` and `version` change; dependencies keep the published
// @parity/* ranges. Pack-time lifecycle scripts are dropped so the repack in a
// node_modules-less staging dir cannot trigger a rebuild.
//
// Usage: PCF_TRUAPI_HOST_VERSION=0.10.1-pcf.1 node scripts/rescope-pack.mjs
// Writes the tarball to <repo>/artifacts/.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLISHED_NAME = "@polkadot-community-foundation/truapi-host";
const PACK_TIME_SCRIPTS = ["prepack", "prepare", "postpack"];
const LOCAL_SPEC = /^(workspace|file|link|portal|git(\+[a-z]+)?|https?):/;

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(pkgDir, "../../../artifacts");

const version = process.env.PCF_TRUAPI_HOST_VERSION;
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(
    `PCF_TRUAPI_HOST_VERSION must be a semver version, got '${version ?? ""}'`,
  );
}

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"] })
    .toString()
    .trim();

const stage = mkdtempSync(join(tmpdir(), "pcf-truapi-host-"));
try {
  run("npm", ["pack", "--pack-destination", stage], pkgDir);
  const srcTgz = readdirSync(stage).find((f) => f.endsWith(".tgz"));
  if (!srcTgz) throw new Error("npm pack produced no tarball");
  run("tar", ["-xzf", join(stage, srcTgz), "-C", stage], stage);

  const pkgRoot = join(stage, "package");
  const pkgJsonPath = join(pkgRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  if (!existsSync(join(pkgRoot, "dist/wasm/web/truapi_server_bg.wasm"))) {
    throw new Error("packed tarball has no WASM; run build:wasm first");
  }

  for (const field of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
      if (LOCAL_SPEC.test(spec)) {
        throw new Error(`${field}.${dep} is not a registry range: ${spec}`);
      }
      const resolved = run(
        "npm",
        ["view", `${dep}@${spec}`, "version", "--json"],
        stage,
      );
      if (!resolved) {
        throw new Error(`${dep}@${spec} resolves to no published version`);
      }
      console.log(`[rescope-pack] ${field}: ${dep}@${spec}`);
    }
  }

  if (!version.startsWith(`${pkg.version}-`)) {
    throw new Error(
      `${version} is not a prerelease of the in-tree version ${pkg.version}`,
    );
  }

  const upstream = `${pkg.name}@${pkg.version}`;
  pkg.name = PUBLISHED_NAME;
  pkg.version = version;
  for (const script of PACK_TIME_SCRIPTS) delete pkg.scripts?.[script];
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");

  mkdirSync(outDir, { recursive: true });
  const outTgz = run(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", outDir, "--json"],
    pkgRoot,
  );
  const [{ filename }] = JSON.parse(outTgz);
  console.log(`[rescope-pack] ${upstream} -> ${PUBLISHED_NAME}@${version}`);
  console.log(`[rescope-pack] ${join(outDir, filename)}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
