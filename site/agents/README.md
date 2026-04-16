# Agents Microsite

This is the microsite for the Agents project, showcasing features, usage examples etc.

Built with **Astro** and deployed to Cloudflare Workers.

## Getting Started

First, install dependencies:

```bash
npm install #run this in the root of the repo
```

Then run the development server:

```bash
npm start
```

Open [http://localhost:4321](http://localhost:4321) with your browser to see the result.

## Cloudflare Deployment

The site is built with Astro and deployed to Cloudflare Workers:

```bash
# Build the site
npm run build

# Deploy to Cloudflare
npm run deploy
```

## Smoke Testing

Run the deployed-site smoke suite against the canonical custom domain:

```bash
npm run test:smoke
```

Run it against another route while keeping the custom domain as the advertised
canonical endpoint:

```bash
SITE_URL=https://xentric-agent.deanna11011101.workers.dev \
CANONICAL_URL=https://agent.xentric-ai.com \
npm run test:smoke
```

## Tech Stack

- **Astro** - Modern web framework
- **React** - For interactive components with partial hydration
- **Tailwind CSS** - Utility-first CSS framework
- **Framer Motion** - Animation library
- **GSAP** - Advanced animations
- **Cloudflare Workers** - Deployment platform

# Agents MCP Server

[![Add to Cursor](https://img.shields.io/badge/Add%20to-Cursor-blue)](https://cursor.com/en-US/install-mcp?name=cloudflare-agents&config=eyJ1cmwiOiJodHRwczovL2FnZW50LnhlbnRyaWMtYWkuY29tL21jcCJ9)
[![Add to VS Code](https://img.shields.io/badge/Add%20to-VS%20Code-blue)](vscode:mcp/install?%7B%22name%22%3A%22cloudflare-agents%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fagent.xentric-ai.com%2Fmcp%22%7D)

This is an MCP server for anyone building with Agents SDK. It exposes just 1 tool.

```json
{
  "name": "search-agent-docs",
  "description": "Token efficient search of the Cloudflare Agents SDK documentation",
  "inputSchema": {
    "query": {
      "type": "string",
      "description": "query string to search for eg. 'agent hibernate', 'schedule tasks'"
    },
    "k": {
      "type": "number",
      "optional": true,
      "default": 5,
      "description": "number of results to return"
    }
  }
}
```

## Usage

Connect to this MCP server to any MCP Client that supports remote MCP servers.

```txt
https://agent.xentric-ai.com/mcp
```

## How it works

It pulls the docs from Github, chunks them with a recursive chunker, and indexes them with Orama. The index is cached in KV for 1 day. Search is BM25 with stemming enabled for better results. This allows "hibernation" to match with "hibernate" allowing for more natural language queries.

### Ratelimiting

To avoid ratelimiting by GitHub, you can set the `GITHUB_TOKEN` environment variable with `wrangler secret put GITHUB_TOKEN`

## Development

To run this server locally, you can use the following command:

```bash
npm install
npm run dev
```

You can test this server with the MCP Inspector.

```bash
npx @modelcontextprotocol/inspector
```

## Deployment

To deploy this server to Cloudflare Workers, you can use the following command:

```bash
npm run deploy
```
