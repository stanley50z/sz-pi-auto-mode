import { readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SNAPSHOTTED_PI_PACKAGES } from "./pi-runtime-packages.js";

const CORE_PACKAGE_PREFIX = "@earendil-works/pi-";
const SHARED_PACKAGES = new Set(["@earendil-works/chord", "typebox"]);

function packageMatches(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

const configuredPackageDir = process.env.AUTOMODE_PI_PACKAGE_DIR;
if (!configuredPackageDir) throw new Error("Missing launching Pi package directory");
const piPackageDir = realpathSync(configuredPackageDir);
const packageJsonPath = join(piPackageDir, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
if (packageJson.name !== "@earendil-works/pi-coding-agent") {
  throw new Error("Launching Pi package directory is not pi-coding-agent");
}

const launchingPiPackageUrl = pathToFileURL(packageJsonPath).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (SNAPSHOTTED_PI_PACKAGES.some((name) => packageMatches(specifier, name))) {
      return nextResolve(specifier, {
        ...context,
        parentURL: import.meta.url,
      });
    }
    if (!specifier.startsWith(CORE_PACKAGE_PREFIX) && !SHARED_PACKAGES.has(specifier)) {
      return nextResolve(specifier, context);
    }
    return nextResolve(specifier, {
      ...context,
      parentURL: launchingPiPackageUrl,
    });
  },
});
