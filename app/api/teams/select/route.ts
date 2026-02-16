import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const CARTOLA_BASE = "https://api.cartola.globo.com";

function supabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

function baseUrlFromRequest(req: Request) {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

async function fetchJson(url: string) {
  const res = await fetch(url, {
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json,text/plain,*/*",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      "Referer": "https://cartola.globo.com/",
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} em ${url}. Body: ${text.slice(0, 200)}`);
  }
  if (!text.trim()) {
    throw new Error(`Resposta vazia em ${url}`);
  }
  return JSON.parse(text);
}

async function getLastFinishedRound(): Promise<{
  rodadaAtual: number;
  lastFinishedRound: number;
  statusMercado: number | null;
}> {
  const st = await fetchJson(`${CARTOLA_BASE}/mercado/status`);

  const rodadaAtual = Number(st?.rodada_atual);
  const statusMercado = st?.status_mercado != null ? Number(st.status_mercado) : null;

  const safeRodadaAtual = Number.isFinite(rodadaAtual) && rodadaAtual > 0 ? rodadaAtual : 1;

  // status_mercado === 1 => mercado aberto (time pode mudar)
  const mercadoAberto = statusMercado === 1;

  const lastFinishedRound = Math.max(0, mercadoAberto ? safeRodadaAtual - 1 : safeRodadaAtual);

  return { rodadaAtual: safeRodadaAtual, lastFinishedRound, statusMercado };
}

export async function POST(req: Request) {
  const sb = supabase();
  const baseUrl = baseUrlFromRequest(req);

  const body = await req.json().catch(() => ({}));
  const teamId = Number(body?.id);
  const slug = String(body?.slug ?? "").trim() || undefined;
  const name = String(body?.name ?? "").trim() || undefined;
  const force = Boolean(body?.force);

  if (!Number.isFinite(teamId) || teamId <= 0) {
    return NextResponse.json({ ok: false, error: "missing/invalid id" }, { status: 400 });
  }

  // 1) Descobrir última rodada finalizada
  let lastFinishedRound = 0;
  let rodadaAtual = 0;
  let statusMercado: number | null = null;

  try {
    const st = await getLastFinishedRound();
    lastFinishedRound = st.lastFinishedRound;
    rodadaAtual = st.rodadaAtual;
    statusMercado = st.statusMercado;
  } catch (e: any) {
    // Se status falhar, ainda dá para tentar importar, mas é melhor retornar erro claro
    return NextResponse.json(
      { ok: false, error: `Falha ao consultar mercado/status: ${e?.message ?? "erro"}` },
      { status: 500 }
    );
  }

  // Se ainda não existe rodada finalizada, não faz sentido importar histórico
  if (lastFinishedRound <= 0) {
    return NextResponse.json({
      ok: true,
      teamId,
      cache: "skip",
      reason: "no_finished_rounds_yet",
      rodadaAtual,
      statusMercado,
      lastFinishedRound,
    });
  }

  // 2) Cache inteligente: checar qual a maior rodada já importada no banco
  // Se já estiver atualizado (>= lastFinishedRound) e não for force, não importa.
  if (!force) {
    const maxRes = await sb
      .from("team_rounds")
      .select("round")
      .eq("team_id", teamId)
      .order("round", { ascending: false })
      .limit(1);

    if (maxRes.error) {
      return NextResponse.json({ ok: false, error: maxRes.error.message }, { status: 500 });
    }

    const maxRound = maxRes.data?.[0]?.round ?? null;

    if (maxRound != null && Number(maxRound) >= lastFinishedRound) {
      return NextResponse.json({
        ok: true,
        teamId,
        cache: "hit",
        maxImportedRound: Number(maxRound),
        rodadaAtual,
        statusMercado,
        lastFinishedRound,
      });
    }
  }

  // 3) Se não tem cache (ou force), chama o importador interno
  const importRes = await fetch(`${baseUrl}/api/import/team`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: teamId, slug, name, force }),
    cache: "no-store",
  });

  const importJson = await importRes.json().catch(() => null);

  if (!importRes.ok) {
    return NextResponse.json(
      { ok: false, error: "import failed", details: importJson },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    teamId,
    cache: "miss",
    rodadaAtual,
    statusMercado,
    lastFinishedRound,
    imported: importJson,
  });
}
