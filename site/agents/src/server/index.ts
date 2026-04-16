import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createMcpHandler } from "agents/mcp";
import { fetchAndBuildIndex, formatResults } from "./utils";
import {
  analyzeDeployTarget,
  checkSiteHealth,
  planSiteMigration
} from "./diagnostics";
import { search } from "@orama/orama";
import { Effect } from "effect";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // TODO: instrument this server for observability
    const mcpServer = new McpServer({
      name: "agents-mcp",
      version: "0.0.1"
    });

    const inputSchema = {
      query: z
        .string()
        .describe(
          "query string to search for eg. 'agent hibernate', 'schedule tasks'"
        ),
      k: z
        .number()
        .optional()
        .default(5)
        .describe("number of results to return")
    };

    mcpServer.registerTool(
      "search-agent-docs",
      {
        description:
          "Token efficient search of the Cloudflare Agents SDK documentation",
        inputSchema
      },
      async ({ query, k }) => {
        const searchEffect = Effect.gen(function* () {
          console.log({ query, k });
          const term = query.trim();

          const docsDb = yield* fetchAndBuildIndex;

          const result = search(docsDb, { term, limit: k });
          const searchResult = yield* result instanceof Promise
            ? Effect.promise(() => result)
            : Effect.succeed(result);

          return {
            content: [
              {
                type: "text" as const,
                text: formatResults(searchResult, term, k)
              }
            ]
          };
        }).pipe(
          Effect.catchAll((error) => {
            console.error(error);
            return Effect.succeed({
              content: [
                {
                  type: "text" as const,
                  text: `There was an error with the search tool. Please try again later.`
                }
              ]
            });
          })
        );

        return await Effect.runPromise(searchEffect);
      }
    );

    mcpServer.registerTool(
      "check-site-health",
      {
        description:
          "Read-only health check for a deployed site, including homepage, discovery metadata, sitemap, robots, and optional MCP endpoint checks.",
        inputSchema: {
          url: z
            .string()
            .url()
            .describe(
              "Site URL to check, for example https://agent.xentric-ai.com"
            ),
          expectedCanonicalUrl: z
            .string()
            .url()
            .optional()
            .describe(
              "Canonical URL expected in discovery metadata. Defaults to url."
            ),
          includeMcpChecks: z
            .boolean()
            .optional()
            .default(true)
            .describe(
              "Whether to check MCP discovery and /mcp transport behavior"
            )
        }
      },
      async ({ url, expectedCanonicalUrl, includeMcpChecks }) => {
        const text = await checkSiteHealth({
          url,
          expectedCanonicalUrl,
          includeMcpChecks,
          requesterUrl: request.url
        });

        return {
          content: [
            {
              type: "text" as const,
              text
            }
          ]
        };
      }
    );

    mcpServer.registerTool(
      "analyze-deploy-target",
      {
        description:
          "Read-only analysis of a public GitHub repo to identify framework, deploy target, useful config files, and blockers before migrating or deploying a site.",
        inputSchema: {
          repoUrl: z
            .string()
            .url()
            .describe(
              "Public GitHub repo URL, for example https://github.com/owner/repo"
            ),
          branch: z
            .string()
            .optional()
            .default("main")
            .describe("Branch to analyze. Defaults to main.")
        }
      },
      async ({ repoUrl, branch }) => {
        const text = await analyzeDeployTarget({ repoUrl, branch });

        return {
          content: [
            {
              type: "text" as const,
              text
            }
          ]
        };
      }
    );

    mcpServer.registerTool(
      "plan-site-migration",
      {
        description:
          "Create a safe migration plan for moving a site from an expiring host to Cloudflare Workers or Pages.",
        inputSchema: {
          currentUrl: z
            .string()
            .url()
            .optional()
            .describe("Current live site URL, if available."),
          repoUrl: z
            .string()
            .url()
            .optional()
            .describe("Repository URL for the site, if available."),
          targetProvider: z
            .enum(["cloudflare-workers", "cloudflare-pages"])
            .optional()
            .default("cloudflare-workers")
            .describe("Preferred Cloudflare target.")
        }
      },
      async ({ currentUrl, repoUrl, targetProvider }) => {
        const text = await planSiteMigration({
          currentUrl,
          repoUrl,
          targetProvider
        });

        return {
          content: [
            {
              type: "text" as const,
              text
            }
          ]
        };
      }
    );
    return createMcpHandler(mcpServer)(request, env, ctx);
  }
};
