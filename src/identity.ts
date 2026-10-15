import { IDENTITY_REGISTRY, CELO_CHAIN_ID } from "./constants.js";
import { identityAbi, publicClient } from "./chain.js";
import { safeFetch } from "./safeFetch.js";

export interface RegistrationFile {
  type?: string;
  name?: string;
  description?: string;
  services?: { name?: string; endpoint?: string; version?: string }[];
  x402Support?: boolean;
  active?: boolean;
  supportedTrust?: string[];
  registrations?: { agentId?: number | string; agentRegistry?: string }[];
}

export interface IdentityResult {
  exists: boolean;
  owner?: string;
  wallet?: string;
  uriKind?: "data" | "https" | "ipfs" | "other";
  registration?: RegistrationFile;
  registrationError?: string;
}

const MAX_URI = 200_000;

async function loadRegistration(uri: string): Promise<{ kind: IdentityResult["uriKind"]; file?: RegistrationFile; error?: string }> {
  try {
    if (uri.length > MAX_URI) return { kind: "other", error: "registration URI too large" };
    if (uri.startsWith("data:")) {
      const comma = uri.indexOf(",");
      const meta = uri.slice(5, comma);
      const payload = uri.slice(comma + 1);
      const text = meta.includes(";base64")
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload);
      return { kind: "data", file: JSON.parse(text) };
    }
    if (uri.startsWith("https://") || uri.startsWith("ipfs://")) {
      const kind = uri.startsWith("ipfs://") ? "ipfs" : "https";
      const url = kind === "ipfs" ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri;
      const res = await safeFetch(url, { timeoutMs: 8000 });
      if (res.status !== 200) return { kind, error: `registration file returned HTTP ${res.status}` };
      return { kind, file: JSON.parse(res.body) };
    }
    return { kind: "other", error: "unsupported registration URI scheme" };
  } catch (e) {
    return { kind: "other", error: `could not load registration file: ${(e as Error).message}` };
  }
}

export async function readIdentity(agentId: bigint): Promise<IdentityResult> {
  let owner: string;
  try {
    owner = await publicClient.readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "ownerOf", args: [agentId] });
  } catch {
    return { exists: false };
  }
  const [uri, wallet] = await Promise.all([
    publicClient.readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "tokenURI", args: [agentId] }).catch(() => ""),
    publicClient.readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "getAgentWallet", args: [agentId] }).catch(() => undefined),
  ]);
  const loaded = uri ? await loadRegistration(uri) : { kind: "other" as const, error: "no agentURI set" };
  return {
    exists: true,
    owner,
    wallet,
    uriKind: loaded.kind,
    registration: loaded.file,
    registrationError: loaded.error,
  };
}

/** Does the registration file point back at this agent id and registry on Celo? */
export function registrationCoherent(reg: RegistrationFile | undefined, agentId: bigint): boolean {
  const want = `eip155:${CELO_CHAIN_ID}:${IDENTITY_REGISTRY}`.toLowerCase();
  return !!reg?.registrations?.some(
    (r) => String(r.agentId) === agentId.toString() && String(r.agentRegistry ?? "").toLowerCase() === want,
  );
}
