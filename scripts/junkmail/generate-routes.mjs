// junkmail: regenerate apps/web/src/routeTree.gen.ts without starting Vite. Used after an
// upstream merge, where the generated file conflicts whenever either side adds a route.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/web");
const require = createRequire(path.join(webRoot, "package.json"));
const pluginEntry = require.resolve("@tanstack/router-plugin/vite");
const generatorEntry = createRequire(pluginEntry).resolve("@tanstack/router-generator");
const { Generator, getConfig } = await import(generatorEntry);

const config = getConfig({ autoCodeSplitting: true }, webRoot);
await new Generator({ config, root: webRoot }).run();
console.log("Regenerated apps/web/src/routeTree.gen.ts");
