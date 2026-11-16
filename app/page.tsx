import { redirect } from "next/navigation";
import { getSession, homeFor } from "@/lib/server/auth";
import { ensureSeeded } from "@/lib/server/seed";
import { LoginForm } from "./login/LoginForm";
import { BrandMark } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Home() {
  void ensureSeeded().catch(() => {});
  const u = await getSession();
  if (u) redirect(homeFor(u.role));

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between p-12 bg-[color:var(--ink)] text-white">
        <div className="flex items-center gap-3">
          <BrandMark size={18} light />
        </div>
        <div className="max-w-md">
          <h1 className="text-[40px] leading-[1.08] font-[780] tracking-tight">Repair it, or swap up?</h1>
          <p className="mt-4 text-[17px] text-white/75 leading-relaxed">Repair quote vs trade-in + bonus, side by side.</p>
        </div>
        <p className="text-white/50 text-sm">Buyback by the programme&apos;s partner.</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <BrandMark size={18} />
          </div>
          <h2 className="text-2xl font-bold tracking-tight">Sign in</h2>
          <p className="hint mt-1 mb-6">Enter your username and password to continue.</p>
          <LoginForm next={null} initialError={null} />
        </div>
      </div>
    </div>
  );
}
