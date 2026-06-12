# @part-kit/mcp

MCP server for the [PartKit](https://partkit.dev) registry — verified, attested standard parts for AI coding agents. Agents use it to discover parts, resolve capability requests into deterministic install plans, and read contracts, seams, and attestations.

## Tools

| Tool | Purpose |
|---|---|
| `search_parts` | Catalog search (empty query lists everything) |
| `resolve_plan` | Capabilities + parts.lock → topologically-ordered install plan |
| `get_contract` | Machine-readable contract for a part |
| `get_seams` | What the app must implement — sufficient without reading `src/` |
| `get_attestation` | Signed verification record with freshness |
| `get_upgrade_plan` | Seam changes between versions |

## Usage

```json
{
  "mcpServers": {
    "partkit": {
      "command": "npx",
      "args": ["-y", "@part-kit/mcp", "--registry", "/path/to/registry"]
    }
  }
}
```

**Status: pre-v0.** The hosted registry is not live yet — point `--registry` (or env `PARTKIT_REGISTRY`) at a local checkout of the registry directory.

MIT licensed. © PartKit authors.
