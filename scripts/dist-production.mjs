import { spawnSync } from "node:child_process";

const rawUrl = process.env.AEGIS_MASTER_SERVER_URL?.trim();
const publishArgs = process.argv.slice(2);

if (
  publishArgs.length > 0 &&
  (publishArgs.length !== 2 || publishArgs[0] !== "--publish" || publishArgs[1] !== "always")
) {
  console.error("The only supported production packaging option is --publish always.");
  process.exit(1);
}

if (!rawUrl) {
  console.error(
    "Set AEGIS_MASTER_SERVER_URL to the deployed HTTPS API URL before creating a production build.",
  );
  process.exit(1);
}

let masterServerUrl;
try {
  const parsed = new URL(rawUrl);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(parsed.hostname) ||
    parsed.hostname.endsWith(".localhost")
  ) {
    throw new Error();
  }
  masterServerUrl = parsed.toString().replace(/\/+$/, "");
} catch {
  console.error(
    "AEGIS_MASTER_SERVER_URL must be a public HTTPS URL without credentials, query, or fragment.",
  );
  process.exit(1);
}

const packageArgs = ["run", "dist:package"];
if (publishArgs.length > 0) packageArgs.push("--", ...publishArgs);

const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  packageArgs,
  {
    env: {
      ...process.env,
      NODE_ENV: "production",
      VITE_API_BASE_URL: masterServerUrl,
      VITE_API_KEY: "",
      VITE_AEGIS_SKIP_AUTH: "0",
    },
    shell: process.platform === "win32",
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`Could not start the production packaging command: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
