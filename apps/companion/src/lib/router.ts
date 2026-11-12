import { useSyncExternalStore } from "react";

export type Route =
  | { name: "pair"; query: URLSearchParams }
  | { name: "bugs" }
  | { name: "bug"; id: string; workspaceId: string | null }
  | { name: "settings" };

const parse = (hash: string): Route => {
  const [path, queryString = ""] = hash.replace(/^#/, "").split("?");
  const query = new URLSearchParams(queryString);
  const parts = path.split("/").filter(Boolean);
  switch (parts[0]) {
    case "pair":
      return { name: "pair", query };
    case "bugs":
      return { name: "bugs" };
    case "bug":
      // Workspace rides along in the hash query: #/bug/<id>?w=<workspaceId>.
      return parts[1]
        ? { name: "bug", id: parts[1], workspaceId: query.get("w") }
        : { name: "bugs" };
    case "settings":
      return { name: "settings" };
    default:
      return { name: "bugs" };
  }
};

// useSyncExternalStore requires a stable snapshot between store changes.
let cachedHash: string | null = null;
let cachedRoute: Route = { name: "bugs" };

const readHash = (): Route => {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parse(hash);
  }
  return cachedRoute;
};

const subscribe = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, readHash);
}

export const navigate = (hash: string): void => {
  window.location.hash = hash;
};
