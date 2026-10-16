import { IDENTITY_REGISTRY, CELO_CHAIN_ID } from "./constants.js";
import { identityAbi, publicClient } from "./chain.js";
import { nodeFetcher } from "./safeFetch.js";
import { decodeDataUri, MAX_URI_CHARS, type RegistrationFile } from "./registration.js";

export type { RegistrationFile } from "./registration.js";
export { registrationCoherent } from "./registration.js";

export interface IdentityResult {
  exists: boolean;
  owner?: string;
  wallet?: string;
  uriKind?: "data" | "https" | "ipfs" | "other";
  registration?: RegistrationFile;
  registrationError?: string;
}


async function loadRegistration(uri: string): Promise<{ kind: IdentityResult["uriKind"]; file?: RegistrationFile; error?: string }> {
  try {
    if (uri.length > MAX_URI_CHARS) return { kind: "other", error: "registration URI too large" };
    if (uri.startsWith("data:")) {
      const comma = uri.indexOf(",");
      const text = decodeDataUri(uri);
      if (text === null) return { kind: "data", error: "undecodable data URI" };
      return { kind: "data", file: JSON.parse(text) };
    }
    if (uri.startsWith("https://") || uri.startsWith("ipfs://")) {
      const kind = uri.startsWith("ipfs://") ? "ipfs" : "https";
      const url = kind === "ipfs" ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri;
      const res = await nodeFetcher(url, { timeoutMs: 8000 });
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
