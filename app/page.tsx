import { redirect } from "next/navigation";
import { getSession, homeFor } from "@/lib/server/auth";
import { ensureSeeded } from "@/lib/server/seed";

export default async function Home() {
  await ensureSeeded();
  const u = await getSession();
  redirect(u ? homeFor(u.role) : "/login");
}
