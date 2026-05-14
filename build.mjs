import { clangTree, command, executable, macOSApp, pngIcon, reckon } from "@andrew24601/reckon";
import { readdir } from "node:fs/promises";

const projectRoot = decodeURIComponent(new URL(".", import.meta.url).pathname);
const nativeFlags = ["-std=c++17"];
const frameworkNames = ["Cocoa", "Foundation", "Security", "WebKit", "UniformTypeIdentifiers"];

async function main() {
  const webBundle = command("npm", ["run", "build"], {
    cwd: "web",
    outputs: ["web/dist/app.bundle.js"],
    fileDependencies: ["web/build.mjs", "web/package.json", "web/src/*.js"],
  });

  const binary = executable("build/RunDown", clangTree("app", { flags: nativeFlags }), {
    frameworks: frameworkNames,
  });

  const appBundle = macOSApp("build/RunDown.app", binary, {
    bundleIdentifier: "dev.doof.rundown",
    bundleName: "RunDown",
    displayName: "RunDown",
    executableName: "RunDown",
    version: "0.1.0",
    shortVersion: "0.1.0",
    icon: pngIcon("icon.png"),
    infoPlistEntries: {
      LSApplicationCategoryType: "public.app-category.developer-tools",
    },
    resources: [
      { source: "samples/welcome.md", destination: "samples/welcome.md" },
      { source: "web/index.html", destination: "web/index.html" },
      { source: "web/styles.css", destination: "web/styles.css" },
      { source: webBundle, destination: "web/dist/app.bundle.js" },
    ],
  });

  await reckon(appBundle, {
    cwd: projectRoot,
    verbose: true
  });
}

void main();
