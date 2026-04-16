import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const DEFAULT_SITE_URL = "https://agent.xentric-ai.com";
const DEFAULT_TIMEOUT_MS = 30_000;

const siteUrl = normalizeUrl(
  getArgValue("--site-url") ?? process.env.SITE_URL ?? DEFAULT_SITE_URL
);
const canonicalUrl = normalizeUrl(
  getArgValue("--canonical-url") ?? process.env.CANONICAL_URL ?? siteUrl
);
const secondarySiteUrl =
  getArgValue("--secondary-site-url") ?? process.env.SECONDARY_SITE_URL;

const checks = [];

function getArgValue(name) {
  const prefixed = `${name}=`;
  const directIndex = process.argv.indexOf(name);

  if (directIndex !== -1) {
    return process.argv[directIndex + 1];
  }

  return process.argv
    .find((arg) => arg.startsWith(prefixed))
    ?.slice(prefixed.length);
}

function normalizeUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function makeUrl(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl}/`).toString();
}

async function fetchText(pathname, options = {}) {
  const response = await fetchWithTimeout(makeUrl(siteUrl, pathname), options);
  const text = await response.text();
  return { response, text };
}

async function fetchJson(pathname, options = {}) {
  const { response, text } = await fetchText(pathname, options);
  assert.match(
    response.headers.get("content-type") ?? "",
    /json|linkset/,
    `${pathname} should return a JSON-compatible content type`
  );
  return { response, json: JSON.parse(text), text };
}

async function fetchWithTimeout(url, options = {}) {
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return fetch(url, { ...options, signal });
}

async function check(name, fn) {
  const start = performance.now();
  try {
    await fn();
    const elapsed = Math.round(performance.now() - start);
    checks.push({ name, status: "pass", elapsed });
    console.log(`ok - ${name} (${elapsed}ms)`);
  } catch (error) {
    checks.push({ name, status: "fail", error });
    console.error(`not ok - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

function parseMcpPayload(text) {
  const dataLines = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());

  const payload = dataLines.length > 0 ? dataLines.join("\n") : text;
  return JSON.parse(payload);
}

async function mcpRequest(message) {
  const response = await fetchWithTimeout(makeUrl(siteUrl, "/mcp"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify(message),
    timeoutMs: 120_000
  });
  const text = await response.text();

  assert.equal(response.status, 200, `MCP request failed: ${text}`);
  return parseMcpPayload(text);
}

await check("homepage renders in a browser", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  try {
    const response = await page.goto(siteUrl, {
      waitUntil: "networkidle",
      timeout: DEFAULT_TIMEOUT_MS
    });

    assert.equal(response?.status(), 200);
    await assert.doesNotReject(() =>
      page.getByRole("heading", { name: /platform.*agents/i }).waitFor({
        timeout: 10_000
      })
    );
    assert.match(await page.title(), /Cloudflare Agents/i);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await browser.close();
  }
});

await check("homepage advertises MCP discovery links", async () => {
  const { response, text } = await fetchText("/");

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(text, /Cloudflare Agents/);

  const linkHeader = response.headers.get("link") ?? "";
  assert.match(linkHeader, /rel="api-catalog"/);
  assert.match(linkHeader, /rel="service-desc"/);
  assert.match(linkHeader, /rel="service-meta"/);
});

await check("MCP server card points at this deployment", async () => {
  const { response, json } = await fetchJson(
    "/.well-known/mcp/server-card.json"
  );

  assert.equal(response.status, 200);
  assert.equal(json.serverInfo.name, "agents-mcp");
  assert.equal(json.transport.type, "streamable-http");
  assert.equal(json.websiteUrl, canonicalUrl);
  assert.equal(json.transport.endpoint, makeUrl(canonicalUrl, "/mcp"));
});

await check("OpenAPI and API catalog point at this deployment", async () => {
  const { json: openApi } = await fetchJson("/.well-known/mcp-openapi.json");
  const { json: catalog } = await fetchJson("/.well-known/api-catalog");
  const linkset = catalog.linkset?.[0];

  assert.equal(openApi.servers?.[0]?.url, canonicalUrl);
  assert.ok(openApi.paths?.["/mcp"], "OpenAPI should describe /mcp");
  assert.equal(linkset?.anchor, makeUrl(canonicalUrl, "/mcp"));
});

await check("status, robots, and sitemap use this deployment", async () => {
  const { json: status } = await fetchJson("/status.json");
  const { text: robots } = await fetchText("/robots.txt");
  const { text: sitemap } = await fetchText("/sitemap.xml");

  assert.equal(status.status, "ok");
  assert.equal(status.endpoint, makeUrl(canonicalUrl, "/mcp"));
  assert.match(
    robots,
    new RegExp(`${escapeRegExp(canonicalUrl)}/sitemap\\.xml`)
  );
  assert.match(
    sitemap,
    new RegExp(`<loc>${escapeRegExp(canonicalUrl)}/</loc>`)
  );
});

await check(
  "MCP transport rejects plain GET without event-stream",
  async () => {
    const { response, text } = await fetchText("/mcp");

    assert.equal(response.status, 406);
    assert.match(text, /Client must accept text\/event-stream/);
  }
);

await check("MCP protocol initializes and lists tools", async () => {
  const initialized = await mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "agents-site-smoke-test",
        version: "0.0.1"
      }
    }
  });
  const tools = await mcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });

  assert.equal(initialized.result.serverInfo.name, "agents-mcp");
  for (const toolName of [
    "search-agent-docs",
    "check-site-health",
    "analyze-deploy-target",
    "plan-site-migration"
  ]) {
    assert.ok(
      tools.result.tools.some((tool) => tool.name === toolName),
      `${toolName} should be available`
    );
  }
});

await check("MCP docs search tool returns results", async () => {
  const result = await mcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "search-agent-docs",
      arguments: {
        query: "schedule tasks",
        k: 1
      }
    }
  });

  const text = result.result.content?.[0]?.text ?? "";
  assert.match(text, /Search Results/);
  assert.match(text, /docs\/scheduling\.md/);
});

await check("MCP site health tool guards same-host checks", async () => {
  const result = await mcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "check-site-health",
      arguments: {
        url: siteUrl,
        expectedCanonicalUrl: canonicalUrl,
        includeMcpChecks: true
      }
    }
  });

  const text = result.result.content?.[0]?.text ?? "";
  assert.match(text, /Site health/);
  assert.match(text, /Self-check guard/);
});

await check("MCP site health tool checks an external site", async () => {
  const result = await mcpRequest({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "check-site-health",
      arguments: {
        url: "https://example.com",
        includeMcpChecks: false
      }
    }
  });

  const text = result.result.content?.[0]?.text ?? "";
  assert.match(text, /Site health/);
  assert.match(text, /Summary:/);
  assert.match(text, /PASS: homepage/);
});

await check("MCP deployment analysis tool reads a public repo", async () => {
  const result = await mcpRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "analyze-deploy-target",
      arguments: {
        repoUrl: "https://github.com/cloudflare/agents",
        branch: "main"
      }
    }
  });

  const text = result.result.content?.[0]?.text ?? "";
  assert.match(text, /Deployment Readiness/);
  assert.match(text, /Detected framework:/);
  assert.match(text, /Recommended target:/);
});

await check("MCP migration planner returns a safety-gated plan", async () => {
  const result = await mcpRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "plan-site-migration",
      arguments: {
        currentUrl: siteUrl,
        repoUrl: "https://github.com/cloudflare/agents",
        targetProvider: "cloudflare-workers"
      }
    }
  });

  const text = result.result.content?.[0]?.text ?? "";
  assert.match(text, /Migration Plan/);
  assert.match(text, /Safety gate/);
});

if (secondarySiteUrl) {
  await check("secondary site URL responds", async () => {
    const response = await fetchWithTimeout(normalizeUrl(secondarySiteUrl));
    assert.equal(response.status, 200);
  });
}

const failed = checks.filter((item) => item.status === "fail");
const passed = checks.length - failed.length;

console.log(`\n${passed}/${checks.length} smoke checks passed for ${siteUrl}`);

if (failed.length > 0) {
  process.exit(1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Give stdout a moment to flush on Windows shells.
await delay(10);
