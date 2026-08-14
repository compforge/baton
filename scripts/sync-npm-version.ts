import { readFileSync, writeFileSync } from "node:fs";

const packagePath = new URL("../package.json", import.meta.url);
const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;

packageJson.version = version;
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
