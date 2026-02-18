"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  LabelList,
} from "recharts";
import posthog from "posthog-js";

type TeamInfo = {
  team_id: number;
  slug: string;
  name: string;
  cartoleiro_name: string | null;
  badge_url: string | null;
};

type DashboardResponse = {
  ok: boolean;
  team: TeamInfo;
  filters: { is_home: string | null };
  totals: { points_total: number; patrimonio_current: number | null };

  series: {
    points: { round: number; points: number | null; moving_avg: number | null }[];
    patrimonio: { round: number; patrimonio: number | null }[];
  };

  metrics: {
    avg_points_by_position: { position_id: number; position: string; n: number; avg_points: number | null }[];
    points_by_scout: { scout: string; points: number }[];
    sg_efficiency: {
      by_position: { position_id: number; position: string; n: number; rate: number | null }[];
      total: { position_id: number; position: "TOT"; n: number; rate: number | null };
    };
    offensive_efficiency: {
      by_position: { position_id: number; position: string; n: number; rate: number | null }[];
      total: { position_id: number; position: "TOT"; n: number; rate: number | null };
    };
  };
};

type DrillRow = {
  round: number;
  atleta_name: string;
  club_name: string
  club_badge_url: string | null;
  points: number | null;
  ok: boolean;
};

function pct(v: number | null) {
  if (v == null) return "—";
  return `${Math.round(v * 100)}%`;
}
function num2(v: number | null) {
  if (v == null) return "—";
  return v.toFixed(2);
}

function PosChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-lg border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-300">
      {label}
    </span>
  );
}

function Modal({
  open,
  title,
  onClose,
  rows,
  loading,
  okLabel,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  rows: DrillRow[];
  loading: boolean;
  okLabel: string; // "SG" ou "G/A"
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="absolute left-1/2 top-1/2 w-[92vw] max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-neutral-800 bg-neutral-950 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <div className="text-sm font-medium">{title}</div>
          <button
            className="rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs hover:border-neutral-700"
            onClick={onClose}
          >
            Fechar
          </button>
        </div>

        <div className="max-h-[70vh] overflow-auto p-4">
          {loading ? (
            <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4 text-sm text-neutral-300">
              Carregando detalhes...
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4 text-sm text-neutral-300">
              Sem dados para este filtro.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-neutral-400">
                  <tr className="border-b border-neutral-800">
                    <th className="py-2 text-left font-medium">Rod</th>
                    <th className="py-2 text-left font-medium">Jogador</th>
                    <th className="py-2 text-left font-medium">Clube</th>
                    <th className="py-2 text-right font-medium">Pts</th>
                    <th className="py-2 text-center font-medium">{okLabel}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => (
                    <tr key={`${r.round}-${idx}`} className="border-b border-neutral-800">
                      <td className="py-2">{r.round}</td>
                      <td className="py-2">{r.atleta_name}</td>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-6 w-6 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900">
                            {r.club_badge_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={r.club_badge_url} alt="" className="h-full w-full object-cover" />
                            ) : null}
                          </div>
                          <span className="text-neutral-200">{r.club_name}</span>
                        </div>
                      </td>
                      <td className="py-2 text-right">{r.points == null ? "—" : r.points.toFixed(2)}</td>
                      <td className="py-2 text-center">{r.ok ? "✅" : "❌"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


export default function TeamDashboardPage() {
  const router = useRouter();
  const params = useParams<{ teamId: string }>();
  const teamId = useMemo(() => Number(params.teamId), [params.teamId]);
  const [sgInfoOpen, setSgInfoOpen] = useState(false);
  const [offInfoOpen, setOffInfoOpen] = useState(false);


  // filtro casa/fora deve afetar este card e os abaixo
  const [isHome, setIsHome] = useState<"all" | "true" | "false">("all");

  const [importing, setImporting] = useState(true);
  const [loadingDash, setLoadingDash] = useState(true);

  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardResponse | null>(null);

  // Drilldown states
  const [drillOpen, setDrillOpen] = useState(false);
  const [drillTitle, setDrillTitle] = useState("");
  const [drillRows, setDrillRows] = useState<DrillRow[]>([]);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillKind, setDrillKind] = useState<"sg" | "offense">("sg");
  const [drillPos, setDrillPos] = useState<string>("TOT");

  // 1) Importar (só quando muda teamId)
  useEffect(() => {
    let alive = true;

    async function runImport() {
      setError(null);
      setImporting(true);

      if (!Number.isFinite(teamId) || teamId <= 0) {
        setError("teamId inválido na URL.");
        setImporting(false);
        return;
      }

      try {
        const selRes = await fetch("/api/teams/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: teamId }),
          cache: "no-store",
        });

        const selJson = await selRes.json().catch(() => null);
        if (!selRes.ok) throw new Error(selJson?.error ?? "Falha ao importar/atualizar histórico.");

        if (!alive) return;
      } catch (e: any) {
        if (!alive) return;
        setError(e?.message ?? "Erro ao importar.");
      } finally {
        if (!alive) return;
        setImporting(false);
      }
    }

    runImport();
    return () => {
      alive = false;
    };
  }, [teamId]);

  // 2) Dashboard (teamId + filtro)
  useEffect(() => {
    let alive = true;

    async function loadDashboard() {
      setError(null);
      setLoadingDash(true);
      setData(null);

      if (!Number.isFinite(teamId) || teamId <= 0) {
        setError("teamId inválido na URL.");
        setLoadingDash(false);
        return;
      }

      // ===== PostHog: início do carregamento =====
      const start = performance.now();

      posthog.capture("dashboard_viewed", {
        teamId,
        isHome,
      });
      // ==========================================

      try {
        const qs = new URLSearchParams({ team_id: String(teamId) });
        if (isHome !== "all") qs.set("is_home", isHome);

        const res = await fetch(`/api/dashboard?${qs.toString()}`, { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as DashboardResponse | null;

        if (!res.ok || !json?.ok) {
          const message = (json as any)?.error ?? `HTTP ${res.status}`;
          posthog.capture("dashboard_error", {
            teamId,
            isHome,
            status: res.status,
            message,
          });
          throw new Error(message ?? "Falha ao carregar dashboard.");
        }

        if (!alive) return;

        setData(json);

        posthog.capture("dashboard_loaded", {
          teamId,
          isHome,
          load_time_ms: Math.round(performance.now() - start),
        });
      } catch (e: any) {
        if (!alive) return;

        const message = e?.message ?? "Erro ao carregar dashboard.";

        // Se cair aqui sem ter passado pelo res.ok/json.ok (ex: erro de rede),
        // ainda registramos:
        posthog.capture("dashboard_error", {
          teamId,
          isHome,
          message,
        });

        setError(message);
      } finally {
        if (!alive) return;
        setLoadingDash(false);
      }
    }

    if (!importing) loadDashboard();
    else setLoadingDash(true);

    return () => {
      alive = false;
    };
  }, [teamId, isHome, importing]);

  async function openDrill(kind: "sg" | "offense", pos: string) {
    setDrillKind(kind);
    setDrillPos(pos);

    const titleBase = kind === "sg" ? "Eficiência de SG" : "Eficiência ofensiva";
    setDrillTitle(`${titleBase} • ${pos}`);
    setDrillRows([]);
    setDrillLoading(true);
    setDrillOpen(true);

    try {
      const qs = new URLSearchParams({ team_id: String(teamId), pos });
      if (isHome !== "all") qs.set("is_home", isHome);

      const url = kind === "sg" ? `/api/drilldown/sg?${qs.toString()}` : `/api/drilldown/offense?${qs.toString()}`;

      const res = await fetch(url, { cache: "no-store" });
      const json = await res.json().catch(() => null);

      if (!res.ok || !json?.ok) throw new Error(json?.error ?? "Falha ao carregar drilldown.");

      const rows = (json.rows ?? []) as DrillRow[];
      setDrillRows(rows);
    } catch (e: any) {
      setDrillRows([]);
      setDrillTitle(`Erro • ${drillPos}`);
    } finally {
      setDrillLoading(false);
    }
  }

  // dados para gráficos
  const pointsChartData = data?.series.points ?? [];
  const patrChartData = data?.series.patrimonio ?? [];

  // posição (média) - já vem com CAP no final; queremos GOL..TEC..CAP (ids 1..6..99)
  const posAvg = useMemo(
  () => data?.metrics.avg_points_by_position ?? [],
  [data?.metrics.avg_points_by_position]
);

  const scoutPoints = useMemo(
    () => data?.metrics.points_by_scout ?? [],
    [data?.metrics.points_by_scout]
  );

  // SG cards: GOL LAT ZAG + TOT (TOT à direita)
  const sgCards = data
    ? [...data.metrics.sg_efficiency.by_position, data.metrics.sg_efficiency.total]
    : [];

  // Ofensiva cards: ATA MEI LAT ZAG + TOT (nessa ordem)
  const offCards = data
    ? [...data.metrics.offensive_efficiency.by_position, data.metrics.offensive_efficiency.total]
    : [];

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-4xl px-4 py-6">
        {/* Top bar (sem filtro aqui) */}
        <div className="flex items-center gap-3">
          <button
            className="rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm hover:border-neutral-700"
            onClick={() => router.push("/")}
          >
            ← Voltar
          </button>
        </div>

        {/* Header: time + cards (pontos total / patrimônio atual) */}
        <header className="mt-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950">
                {data?.team?.badge_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={data.team.badge_url} alt="" className="h-full w-full object-cover" />
                ) : null}
              </div>

              <div className="min-w-0">
                <div className="truncate text-xl font-semibold">
                  {data?.team?.name ?? "Dashboard"}
                </div>
                <div className="truncate text-sm text-neutral-400">
                  {data?.team?.cartoleiro_name ?? "—"}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:w-[340px]">
              <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
                <div className="text-xs text-neutral-400">Pontos</div>
                <div className="mt-1 text-xl font-semibold">
                  {data ? data.totals.points_total.toFixed(2) : "—"}
                </div>
              </div>

              <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
                <div className="text-xs text-neutral-400">Patrimônio</div>
                <div className="mt-1 text-xl font-semibold">
                  {data ? num2(data.totals.patrimonio_current) : "—"}
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* Messages */}
        {error && (
          <div className="mt-4 rounded-2xl border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-200">
            {error}
          </div>
        )}

        {!error && (importing || loadingDash) && (
          <div className="mt-4 rounded-2xl border border-neutral-800 bg-neutral-900 p-4 text-sm text-neutral-300">
            {importing ? "Atualizando histórico..." : "Carregando dashboard..."}
          </div>
        )}

        {/* DASHBOARD */}
        {!importing && !loadingDash && !error && data && (
          <div className="mt-6 space-y-6">
           
            {/* 6) Média por posição (horizontal) + filtro aqui */}
            <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-base font-medium">Média de pontos por posição</h2>

                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-400">Filtro</span>
                  <select
                    className="rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none"
                    value={isHome}
                    onChange={(e) => setIsHome(e.target.value as any)}
                  >
                    <option value="all">Casa+Fora</option>
                    <option value="true">Só casa</option>
                    <option value="false">Só fora</option>
                  </select>
                </div>
              </div>

              <div className="mt-4 h-72">
                <ResponsiveContainer width="100%" height="100%">
  <BarChart
    data={posAvg}
    layout="vertical"
    margin={{ left: 24, right: 24, top: 8, bottom: 8 }}
  >
    {/* sem pontilhado */}
    <XAxis type="number" axisLine tickLine={false} />
    <YAxis type="category" dataKey="position" axisLine tickLine={false} />
    
    {/* cor com mais contraste */}
    <Bar dataKey="avg_points" fill="#FF8300" isAnimationActive={false}>
      {/* rótulo com a média (2 casas) no lugar do "n" */}
      <LabelList
        dataKey="avg_points"
        position="right"
        formatter={(v: any) => (typeof v === "number" ? v.toFixed(2) : "")}
      />
    </Bar>
  </BarChart>
</ResponsiveContainer>

              </div>
            </section>

            {/* 7) Pontuação por scout (horizontal) */}
            <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
              <h2 className="text-base font-medium">Pontuação por scout</h2>

              <div className="mt-4 h-[28rem]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={scoutPoints}
                    layout="vertical"
                    margin={{ left: 24, right: 24, top: 8, bottom: 8 }}
                  >
                    <XAxis type="number" axisLine tickLine={false} />
                    <YAxis type="category" dataKey="scout" axisLine tickLine={false} width={40} />
                    <Bar dataKey="points" fill="#FF8300" isAnimationActive={false}>
                      <LabelList
                        dataKey="points"
                        position="right"
                        formatter={(v: any) => (typeof v === "number" ? v.toFixed(2) : "")}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            {/* 8) SG */}
            <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
              <div className="relative flex items-center gap-2">
  <h2 className="text-base font-medium">Eficiência de SG</h2>

  <button
    type="button"
    className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-neutral-700 bg-neutral-950 text-[11px] text-neutral-200 hover:border-neutral-500"
    onClick={() => setSgInfoOpen((v) => !v)}
    aria-label="Info"
  >
    i
  </button>

  {sgInfoOpen && (
    <div className="absolute left-0 top-7 z-10 w-72 rounded-xl border border-neutral-800 bg-neutral-950 p-3 text-xs text-neutral-200 shadow-lg">
      Percentual dos defensores escalados que teve SG
    </div>
  )}
</div>


              <div className="mt-4 grid gap-3 sm:grid-cols-4">
                {sgCards.map((c: any) => (
                  <button
                    key={c.position}
                    className="rounded-2xl border border-neutral-800 bg-neutral-950 p-4 text-left hover:border-neutral-700"
                    onClick={() => openDrill("sg", c.position)}
                  >
                    <div className="text-sm text-neutral-400">{c.position}</div>
                    <div className="mt-1 text-xl font-semibold">{pct(c.rate)}</div>
                    <div className="mt-1 text-xs text-neutral-500">n: {c.n}</div>
                  </button>
                ))}
              </div>

              <div className="mt-2 text-xs text-neutral-400">
                Clique em um card para ver o detalhe por rodada.
              </div>
            </section>

            {/* 9) Ofensiva */}
            <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
              <div className="relative flex items-center gap-2">
  <h2 className="text-base font-medium">Eficiência Ofensiva</h2>

  <button
    type="button"
    className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-neutral-700 bg-neutral-950 text-[11px] text-neutral-200 hover:border-neutral-500"
    onClick={() => setOffInfoOpen((v) => !v)}
    aria-label="Info"
  >
    i
  </button>

  {offInfoOpen && (
    <div className="absolute left-0 top-7 z-10 w-80 rounded-xl border border-neutral-800 bg-neutral-950 p-3 text-xs text-neutral-200 shadow-lg">
      Percentual dos jogadores de linha escalados que teve G ou A
    </div>
  )}
</div>

              <div className="mt-4 grid gap-3 sm:grid-cols-5">
                {offCards.map((c: any) => (
                  <button
                    key={c.position}
                    className="rounded-2xl border border-neutral-800 bg-neutral-950 p-4 text-left hover:border-neutral-700"
                    onClick={() => openDrill("offense", c.position)}
                  >
                    <div className="text-sm text-neutral-400">{c.position}</div>
                    <div className="mt-1 text-xl font-semibold">{pct(c.rate)}</div>
                    <div className="mt-1 text-xs text-neutral-500">n: {c.n}</div>
                  </button>
                ))}
              </div>

              <div className="mt-2 text-xs text-neutral-400">
                Clique em um card para ver o detalhe por rodada.
              </div>
            </section>
          </div>
        )}

        <Modal
  open={drillOpen}
  title={drillTitle}
  onClose={() => setDrillOpen(false)}
  rows={drillRows}
  loading={drillLoading}
  okLabel={drillKind === "sg" ? "SG" : "G/A"}
  />
      </div>
    </main>
  );
}
