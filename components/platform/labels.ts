/**
 * Client-safe labels for the people and organisation screens. ROLE_LABEL lives
 * in lib/server/auth (a server module), so client components keep this copy —
 * keep the wording identical.
 */
import type { Role } from "@/lib/server/auth";

export const ROLE_NAME: Record<Role, string> = {
  platform: "SwapUp platform",
  org_admin: "Programme admin",
  store_manager: "Store manager",
  advisor: "Counter advisor",
  partner: "Buyback partner",
};

/** One line on what each role can do — shown next to the role picker. */
export const ROLE_HINT: Record<Role, string> = {
  platform: "SwapUp staff: onboards clients and partners, sees every programme.",
  org_admin: "Runs the client's programme: stores, credit limits, bonus campaigns, catalogue, reports.",
  store_manager: "Runs one store: the counter, its credit line, pickups and its advisors.",
  advisor: "Works the counter at one store: repair-or-upgrade quotes and trade-ins.",
  partner: "Buyback partner operations: pickups, verification, settlement and rate cards.",
};

export const CLIENT_TYPES = ["oem_service", "retail_chain", "experience_center", "other"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export const CLIENT_TYPE_LABEL: Record<ClientType, string> = {
  oem_service: "Brand service network",
  retail_chain: "Retail chain",
  experience_center: "Experience centres",
  other: "Other",
};

export function clientTypeLabel(t: string | null | undefined): string {
  if (!t) return "—";
  return (CLIENT_TYPE_LABEL as Record<string, string>)[t] ?? t;
}

export const ORG_KIND_LABEL: Record<"platform" | "client" | "partner", string> = {
  platform: "SwapUp",
  client: "Client",
  partner: "Buyback partner",
};

/** Which kind of organisation a role belongs to (mirrors the rule in createUser). */
export function orgKindForRole(role: Role): "platform" | "client" | "partner" {
  return role === "platform" ? "platform" : role === "partner" ? "partner" : "client";
}

export function roleNeedsStore(role: Role): boolean {
  return role === "store_manager" || role === "advisor";
}
