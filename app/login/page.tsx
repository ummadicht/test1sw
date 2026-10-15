import { redirect } from "next/navigation";
import { getSession, homeFor } from "@/lib/server/auth";
import { ensureSeeded } from "@/lib/server/seed";
import { LoginForm } from "./LoginForm";
import { BrandMark } from "@/components/ui";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await ensureSeeded();
  const u = await getSession();
  const { next } = await searchParams;
  if (u) redirect(safeNext(next) ?? homeFor(u.role));
  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between p-12 bg-[color:var(--ink)] text-white">
        <div className="flex items-center gap-3">
          <BrandMark size={40} />
          <span className="text-xl font-bold tracking-tight">SwapUp</span>
        </div>
        <div className="max-w-md">
          <h1 className="text-[40px] leading-[1.08] font-[780] tracking-tight">Repair it, or swap up?</h1>
          <p className="mt-4 text-[17px] text-white/75 leading-relaxed">
            The counter desk for service centres and experience stores: the repair quote and the trade-in value side by side, an honest
            recommendation, and an upgrade bonus — with every store&apos;s trade-in credit kept inside its limit until the buyback partner collects.
          </p>
        </div>
        <p className="text-white/50 text-sm">Trade-in pricing and buyback by the programme&apos;s partner.</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <BrandMark size={40} />
            <span className="text-xl font-bold">SwapUp</span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight">Sign in</h2>
          <p className="hint mt-1 mb-6">Use the account your store or programme admin gave you.</p>
          <LoginForm next={safeNext(next)} />
        </div>
      </div>
    </div>
  );
}

/** Only same-site paths; never an absolute URL. */
function safeNext(n?: string): string | null {
  if (!n || !n.startsWith("/") || n.startsWith("//") || n.startsWith("/\\") || n.startsWith("/login")) return null;
  return n;
}
