import { rm } from "node:fs/promises";
import esbuild from "esbuild";

await rm("./dist", { recursive: true, force: true });
await rm("./app.js", { force: true });

await esbuild.build({
  entryPoints: ["./src/app.js"],
  bundle: true,
  format: "iife",
  target: ["safari16"],
  outfile: "./dist/app.bundle.js",
  sourcemap: false,
  logLevel: "info"
});