import { env } from "cloudflare:workers";

type CheckStatus = "pass" | "warn" | "fail";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

interface SiteHealthInput {
  url: string;
  expectedCanonicalUrl?: string;
  includeMcpChecks?: boolean;
  requesterUrl?: string;
}

interface DeployTargetInput {
  repoUrl: string;
  branch?: string;
}

interface MigrationPlanInput {
  currentUrl?: string;
  repoUrl?: string;
  targetProvider?: "cloudflare-workers" | "cloudflare-pages";
}

interface GitHubRepo {
  owner: string;
  repo: string;
}

interface GitHubTreeItem {
  path: string;
  type: string;
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_API_BASE = "https://api.github.com";
const RAW_GITHUB_BASE = "https://raw.githubusercontent.com";

export async function checkSiteHealth(input: SiteHealthInput): Promise<string> {
  const baseUrl = normalizeUrl(input.url);
  const canonicalUrl = normalizeUrl(input.expectedCanonicalUrl ?? input.url);
  const includeMcpChecks = input.includeMcpChecks ?? true;
  const checks: CheckResult[] = [];

  if (input.requesterUrl && sameHostname(baseUrl, input.requesterUrl)) {
    return [
      `**Site health for ${baseUrl}**`,
      "",
      "WARN: Self-check guard - this MCP tool is running inside the same Cloudflare Worker hostname it was asked to inspect.",
      "",
      "Cloudflare may route same-host fetches from the Worker back through the edge in a way that returns misleading 522 results. Use the repo smoke test from outside the Worker for this deployment, or run this tool against a different site URL."
    ].join("\n");
  }

  const homepage = await fetchText(baseUrl);
  checks.push({
    name: "homepage",
    status: homepage.response.ok ? "pass" : "fail",
    detail: `${homepage.response.status} ${homepage.response.statusText}`
  });

  const contentType = homepage.response.headers.get("content-type") ?? "";
  checks.push({
    name: "homepage content type",
    status: contentType.includes("text/html") ? "pass" : "warn",
    detail: contentType || "missing content-type"
  });

  const linkHeader = homepage.response.headers.get("link") ?? "";
  checks.push({
    name: "discovery link headers",
    status:
      linkHeader.includes('rel="api-catalog"') ||
      linkHeader.includes("rel=api-catalog")
        ? "pass"
        : "warn",
    detail: linkHeader
      ? "homepage advertises Link metadata"
      : "no Link metadata found"
  });

  const title = homepage.text.match(/<title>(.*?)<\/title>/i)?.[1]?.trim();
  checks.push({
    name: "html title",
    status: title ? "pass" : "warn",
    detail: title ?? "no title tag found"
  });

  await checkJsonResource(
    checks,
    baseUrl,
    "/status.json",
    (json) =>
      getStringProperty(json, "endpoint") === makeUrl(canonicalUrl, "/mcp")
  );
  await checkTextResource(checks, baseUrl, "/robots.txt");
  await checkTextResource(checks, baseUrl, "/sitemap.xml");

  if (includeMcpChecks) {
    await checkMcpMetadata(checks, baseUrl, canonicalUrl);
    await checkMcpTransport(checks, baseUrl);
  }

  return formatCheckResults(`Site health for ${baseUrl}`, checks, [
    `Canonical URL: ${canonicalUrl}`,
    `Final homepage URL: ${homepage.response.url || baseUrl}`
  ]);
}

export async function analyzeDeployTarget(
  input: DeployTargetInput
): Promise<string> {
  const repo = parseGitHubRepo(input.repoUrl);
  const branch = input.branch ?? "main";
  const tree = await fetchGitHubTree(repo, branch);
  const paths = new Set(tree.map((item) => item.path));
  const packageJson = await fetchPackageJson(repo, branch);
  const scripts = packageJson?.scripts ?? {};
  const dependencies = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {})
  };
  const checks: CheckResult[] = [];

  checks.push({
    name: "package.json",
    status: packageJson ? "pass" : "fail",
    detail: packageJson ? "found" : "missing package.json"
  });
  checks.push({
    name: "build script",
    status: scripts.build ? "pass" : "warn",
    detail: scripts.build ?? "no npm build script found"
  });
  checks.push({
    name: "deploy script",
    status: scripts.deploy ? "pass" : "warn",
    detail: scripts.deploy ?? "no npm deploy script found"
  });
  checks.push({
    name: "Cloudflare config",
    status: findAny(paths, ["wrangler.jsonc", "wrangler.toml"])
      ? "pass"
      : "warn",
    detail:
      findAny(paths, ["wrangler.jsonc", "wrangler.toml"]) ??
      "no Wrangler config found"
  });

  const framework = detectFramework(paths, dependencies);
  const provider = detectProvider(paths, dependencies, framework);
  const envFiles = [...paths].filter((path) =>
    /(^|\/)(\.env\.example|\.dev\.vars\.example|\.env\.sample)$/.test(path)
  );
  const likelyOutput = detectOutputDirectory(framework, scripts);
  const blockers = findDeploymentBlockers(paths, scripts, provider);

  const lines = [
    `**Deployment Readiness: ${repo.owner}/${repo.repo}**`,
    "",
    `Branch analyzed: ${branch}`,
    `Detected framework: ${framework}`,
    `Recommended target: ${provider}`,
    `Likely output/runtime: ${likelyOutput}`,
    "",
    formatCheckList(checks),
    "",
    "**Useful files found**",
    "",
    ...[
      "wrangler.jsonc",
      "wrangler.toml",
      "netlify.toml",
      "vercel.json",
      "astro.config.ts",
      "astro.config.mjs",
      "vite.config.ts",
      "next.config.js",
      "next.config.mjs",
      "package-lock.json"
    ]
      .filter((path) => paths.has(path))
      .map((path) => `- ${path}`),
    ...(envFiles.length > 0
      ? [
          "",
          "**Environment examples**",
          "",
          ...envFiles.map((path) => `- ${path}`)
        ]
      : []),
    "",
    "**Blockers to resolve before deploy**",
    "",
    ...(blockers.length > 0
      ? blockers.map((item) => `- ${item}`)
      : ["- None detected from public repo metadata"]),
    "",
    "**Suggested next step**",
    "",
    suggestNextStep(provider, scripts)
  ];

  return lines.join("\n");
}

export async function planSiteMigration(
  input: MigrationPlanInput
): Promise<string> {
  const targetProvider = input.targetProvider ?? "cloudflare-workers";
  const sections = [
    "**Migration Plan**",
    "",
    `Target provider: ${targetProvider}`,
    input.currentUrl ? `Current site: ${normalizeUrl(input.currentUrl)}` : null,
    input.repoUrl ? `Repository: ${input.repoUrl}` : null,
    "",
    "**Order of operations**",
    "",
    "1. Run `check-site-health` against the current live site and save the failing checks.",
    "2. Run `analyze-deploy-target` against the repo to identify framework, build command, output directory, and missing Cloudflare config.",
    "3. Add or correct the deployment config without changing DNS first.",
    "4. Run a provider dry run locally or in CI. For Cloudflare Workers this is `wrangler deploy --dry-run` after the site build succeeds.",
    "5. Deploy to a preview or `workers.dev` route and run the smoke tests against that route.",
    "6. Cut DNS or Worker routes only after the preview route passes.",
    "7. Keep the previous host active until the custom domain returns 200 and key flows pass from an external network.",
    "",
    "**Recommended tools to use next**",
    "",
    "- `check-site-health` for the current URL.",
    "- `analyze-deploy-target` for the repo.",
    "- Local `npm run test:smoke` after the new site has a preview URL.",
    "",
    "**Safety gate**",
    "",
    "Do not add live deploy or rollback capabilities to this public MCP server until diagnostics are consistently passing and write actions are protected by explicit approval."
  ].filter((line): line is string => line !== null);

  return sections.join("\n");
}

async function checkJsonResource(
  checks: CheckResult[],
  baseUrl: string,
  pathname: string,
  validate?: (json: unknown) => boolean
) {
  const result = await fetchText(makeUrl(baseUrl, pathname));

  if (!result.response.ok) {
    checks.push({
      name: pathname,
      status: "warn",
      detail: `${result.response.status} ${result.response.statusText}`
    });
    return;
  }

  try {
    const json = JSON.parse(result.text) as unknown;
    const valid = validate ? validate(json) : true;
    checks.push({
      name: pathname,
      status: valid ? "pass" : "warn",
      detail: valid
        ? "JSON fetched and validated"
        : "JSON fetched but did not match expected deployment metadata"
    });
  } catch {
    checks.push({
      name: pathname,
      status: "fail",
      detail: "response is not valid JSON"
    });
  }
}

async function checkTextResource(
  checks: CheckResult[],
  baseUrl: string,
  pathname: string
) {
  const result = await fetchText(makeUrl(baseUrl, pathname));
  checks.push({
    name: pathname,
    status: result.response.ok ? "pass" : "warn",
    detail: `${result.response.status} ${result.response.statusText}`
  });
}

async function checkMcpMetadata(
  checks: CheckResult[],
  baseUrl: string,
  canonicalUrl: string
) {
  await checkJsonResource(
    checks,
    baseUrl,
    "/.well-known/mcp/server-card.json",
    (json) =>
      getNestedString(json, ["transport", "endpoint"]) ===
      makeUrl(canonicalUrl, "/mcp")
  );
  await checkJsonResource(
    checks,
    baseUrl,
    "/.well-known/mcp-openapi.json",
    (json) => getNestedString(json, ["servers", "0", "url"]) === canonicalUrl
  );
  await checkJsonResource(
    checks,
    baseUrl,
    "/.well-known/api-catalog",
    (json) =>
      getNestedString(json, ["linkset", "0", "anchor"]) ===
      makeUrl(canonicalUrl, "/mcp")
  );
}

async function checkMcpTransport(checks: CheckResult[], baseUrl: string) {
  const result = await fetchText(makeUrl(baseUrl, "/mcp"));
  const looksLikeMcpError =
    result.response.status === 406 &&
    result.text.includes("Client must accept text/event-stream");

  checks.push({
    name: "MCP transport guard",
    status: looksLikeMcpError ? "pass" : "warn",
    detail: looksLikeMcpError
      ? "plain GET is rejected with the expected MCP transport error"
      : `${result.response.status} ${result.response.statusText}`
  });
}

async function fetchText(url: string) {
  const response = await fetchWithTimeout(url);
  const text = await response.text();
  return { response, text };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": "Xentric-Agent-Diagnostics/1.0",
        ...(init.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : init.headers)
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeUrl(value: string) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function makeUrl(baseUrl: string, pathname: string) {
  return new URL(pathname, `${baseUrl}/`).toString();
}

function sameHostname(left: string, right: string) {
  return new URL(left).hostname === new URL(right).hostname;
}

function formatCheckResults(
  title: string,
  checks: CheckResult[],
  context: string[]
) {
  const counts = checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 } satisfies Record<CheckStatus, number>
  );

  return [
    `**${title}**`,
    "",
    ...context,
    "",
    `Summary: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail`,
    "",
    formatCheckList(checks)
  ].join("\n");
}

function formatCheckList(checks: CheckResult[]) {
  return checks
    .map(
      (check) =>
        `- ${check.status.toUpperCase()}: ${check.name} - ${check.detail}`
    )
    .join("\n");
}

function getStringProperty(value: unknown, property: string) {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return undefined;
  }

  const field = (value as Record<string, unknown>)[property];
  return typeof field === "string" ? field : undefined;
}

function getNestedString(value: unknown, path: string[]) {
  let current = value;

  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = current[index];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }

  return typeof current === "string" ? current : undefined;
}

function parseGitHubRepo(repoUrl: string): GitHubRepo {
  const url = new URL(repoUrl);

  if (url.hostname !== "github.com") {
    throw new Error("Only public github.com repositories are supported.");
  }

  const [owner, repoWithSuffix] = url.pathname.replace(/^\/+/, "").split("/");
  const repo = repoWithSuffix?.replace(/\.git$/, "");

  if (!owner || !repo) {
    throw new Error(
      "Expected a GitHub repository URL like https://github.com/owner/repo."
    );
  }

  return { owner, repo };
}

async function fetchGitHubTree(repo: GitHubRepo, branch: string) {
  const url = `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/git/trees/${branch}?recursive=1`;
  const response = await fetchWithGitHubHeaders(url);

  if (!response.ok) {
    throw new Error(
      `GitHub tree fetch failed: ${response.status} ${response.statusText}`
    );
  }

  const json = (await response.json()) as { tree?: GitHubTreeItem[] };
  return json.tree?.filter((item) => item.type === "blob") ?? [];
}

async function fetchPackageJson(repo: GitHubRepo, branch: string) {
  const url = `${RAW_GITHUB_BASE}/${repo.owner}/${repo.repo}/${branch}/package.json`;
  const response = await fetchWithGitHubHeaders(url);

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(
      `package.json fetch failed: ${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as PackageJson;
}

function fetchWithGitHubHeaders(url: string) {
  const headers: Record<string, string> = {
    "User-Agent": "Xentric-Agent-Diagnostics/1.0",
    Accept: "application/vnd.github+json"
  };

  const githubToken = getOptionalGithubToken();
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  return fetchWithTimeout(url, { headers });
}

function getOptionalGithubToken() {
  return "GITHUB_TOKEN" in env && typeof env.GITHUB_TOKEN === "string"
    ? env.GITHUB_TOKEN
    : undefined;
}

function findAny(paths: Set<string>, candidates: string[]) {
  return candidates.find((candidate) => paths.has(candidate));
}

function detectFramework(
  paths: Set<string>,
  dependencies: Record<string, string>
) {
  if (
    paths.has("astro.config.ts") ||
    paths.has("astro.config.mjs") ||
    dependencies.astro
  ) {
    return "Astro";
  }
  if (
    paths.has("next.config.js") ||
    paths.has("next.config.mjs") ||
    dependencies.next
  ) {
    return "Next.js";
  }
  if (
    paths.has("vite.config.ts") ||
    paths.has("vite.config.js") ||
    dependencies.vite
  ) {
    return "Vite";
  }
  if (
    dependencies["@remix-run/cloudflare"] ||
    dependencies["@remix-run/node"]
  ) {
    return "Remix";
  }
  if (dependencies.react) {
    return "React";
  }

  return "unknown";
}

function detectProvider(
  paths: Set<string>,
  dependencies: Record<string, string>,
  framework: string
) {
  if (
    paths.has("wrangler.jsonc") ||
    paths.has("wrangler.toml") ||
    dependencies.wrangler
  ) {
    return "Cloudflare Workers";
  }
  if (paths.has("netlify.toml")) {
    return "Netlify";
  }
  if (paths.has("vercel.json")) {
    return "Vercel";
  }
  if (framework === "Astro" || framework === "Vite") {
    return "Cloudflare Pages or Workers Assets";
  }
  if (framework === "Next.js") {
    return "Cloudflare Workers with OpenNext, or Vercel";
  }

  return "needs manual review";
}

function detectOutputDirectory(
  framework: string,
  scripts: Record<string, string>
) {
  const buildScript = scripts.build ?? "";

  if (buildScript.includes("astro")) {
    return "dist";
  }
  if (buildScript.includes("vite")) {
    return "dist";
  }
  if (buildScript.includes("next")) {
    return ".next or OpenNext output";
  }
  if (framework === "Astro" || framework === "Vite") {
    return "dist";
  }

  return "unknown";
}

function findDeploymentBlockers(
  paths: Set<string>,
  scripts: Record<string, string>,
  provider: string
) {
  const blockers: string[] = [];

  if (!scripts.build) {
    blockers.push("Add or document a build command.");
  }
  if (
    provider.startsWith("Cloudflare") &&
    !paths.has("wrangler.jsonc") &&
    !paths.has("wrangler.toml")
  ) {
    blockers.push("Add a Wrangler config for Cloudflare deployment.");
  }
  if (
    !paths.has("package-lock.json") &&
    !paths.has("pnpm-lock.yaml") &&
    !paths.has("yarn.lock")
  ) {
    blockers.push("Commit a lockfile for repeatable deploys.");
  }

  return blockers;
}

function suggestNextStep(provider: string, scripts: Record<string, string>) {
  if (provider.startsWith("Cloudflare") && scripts.build) {
    return "Run the build locally, then run `wrangler deploy --dry-run` before moving DNS.";
  }
  if (scripts.build) {
    return "Run the build locally, then pick the deployment target that matches the framework output.";
  }

  return "Add a build script first, then re-run deployment readiness analysis.";
}
