"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import posthog from "posthog-js";

type TeamSearchItem = {
  id: number;
  slug: string;
  name: string;
  cartoleiro: string | null;
  badge_url: string | null;
};

export default function HomePage() {
  const router = useRouter();

  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [teams, setTeams] = useState<TeamSearchItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const canSearch = useMemo(() => q.trim().length >= 2, [q]);

  useEffect(() => {
    let alive = true;

    async function run() {
      if (!canSearch) {
        setTeams([]);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`/api/teams/search?q=${encodeURIComponent(q.trim())}`, {
          cache: "no-store",
        });
        const data = await res.json();

        if (!alive) return;

        const list = Array.isArray(data) ? data : data?.teams ?? [];
        setTeams(list);

        posthog.capture("team_search", {
          query: q.trim(),
          results: list.lenght,
        });

      } catch (e: any) {
        if (!alive) return;
        setError(e?.message ?? "Erro ao buscar times");
      } finally {
        if (alive) setLoading(false);
      }
    }

    const t = setTimeout(run, 350); // debounce
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, canSearch]);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-xl px-4 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">CartolaDash</h1>
          <p className="mt-2 text-sm text-neutral-300">
            Estatísticas detalhadas do seu time e dos seus adversários!
          </p>
        </header>

        <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4 shadow-sm">
          <label className="text-sm text-neutral-300">Pesquisar time</label>
          <input
            className="mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-base outline-none focus:border-neutral-600"
            placeholder="Buscar"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />

          <div className="mt-3 text-xs text-neutral-400">
            {loading ? "Buscando..." : canSearch ? `${teams.length} resultado(s)` : "Digite pelo menos 2 letras"}
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-2xl border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-200">
            {error}
          </div>
        )}

        <section className="mt-4 space-y-2">
          {teams.map((t) => (
            <button
              key={t.id}
              className="w-full rounded-2xl border border-neutral-800 bg-neutral-900 p-4 text-left hover:border-neutral-700"
              onClick={() => {
                posthog.capture("team_selected", {
                teamId: t.id,
                teamName: t.name,
                hasBadge: Boolean(t.badge_url),
              });
              router.push(`/t/${t.id}`);
            }}

            >
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950">
                  {t.badge_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={t.badge_url} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </div>

                <div className="min-w-0">
                  <div className="truncate text-base font-medium">{t.name}</div>
                  <div className="truncate text-sm text-neutral-400">{t.cartoleiro ?? "—"}</div>
                </div>

                <div className="ml-auto text-xs text-neutral-500">abrir →</div>
              </div>
            </button>
          ))}
        </section>

        <footer className="mt-10 text-xs text-neutral-500">
          © 2026 CartolaDash
        </footer>
      </div>
    </main>
  );
}
