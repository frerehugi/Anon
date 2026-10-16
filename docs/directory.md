# Directory

A searchable, regularly refreshed list of agents and x402 services on Celo with evidence-based trust signals.

## Entry (planned schema)

```ts
interface DirectoryEntry {
  agentId: string;                 // ERC-8004 id on Celo
  owner: string; wallet?: string;
  name?: string; description?: string; image?: string;
  services: { name: string; endpoint: string; version?: string }[];
  x402Support?: boolean; active?: boolean;
  registrationCoherent: boolean;   // file points back at this id and registry (src/identity.ts)
  firstSeenBlock: number; lastSeenAt: string;
  probes: { url: string; status?: number; pass: boolean; errors: string[]; payTo?: string[]; assets?: string[];
            checkedAt: string; uptime7d?: number }[];
  reputation: { clients: number; count: number; average?: number };
  visa?: { tier: number };         // low weight, unknown is not penalised
  walletTxCount?: number;
  tags: string[];                  // rule-based capability tags first, model-assisted later
  trust: { verdict: "ok" | "caution" | "avoid"; score: number; reasons: string[] };
}
```

The trust fields reuse `checkAgent` (`src/check.ts`). A verdict is evidence, not a guarantee.

## Refresh

- New registry ids: incremental scan from the last seen id; batched reads through buy/Chainstack or forno.
- Registration files: `data:` URIs inline; `https`/`ipfs` fetched through the SSRF-guarded fetcher with size and time limits.
- Probes: only for entries that declare x402 or look paid (`x402`, `premium`, `paid`); one unpaid request each; redirects are reported, not followed.
- Classification: registration text is untrusted input. Rule-based tags first; any model step gets the text as data only,
  no tools, JSON-schema output validated in code.

## Queries (planned)

- `GET /v1/agents?x402=true&tag=&min_trust=&asset=USAT` returns a page of entries.
- `GET /v1/agents/{agentId}` returns one entry with evidence.
- Existing `check` and `lint` become views over the same data.

## Neutrality rules

- State observable facts and the rule that produced a verdict; never accuse.
- No personal data beyond what the registry itself publishes; Self-verified status is shown only as yes/no and tier.
- Anyone can ask for a re-probe of their own endpoint.

## Not built yet

Crawler, storage and the query endpoint. The building blocks (identity read, probe, check) exist.
