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

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Resposta não-JSON em ${url}. Body: ${text.slice(0, 200)}`);
  }
}

async function getLastFinishedRound(): Promise<{
  rodadaAtual: number;
  lastFinished: number;
  statusMercado: number | null;
}> {
  const st = await fetchJson(`${CARTOLA_BASE}/mercado/status`);

  const rodadaAtual = Number(st?.rodada_atual);
  const statusMercado = st?.status_mercado != null ? Number(st.status_mercado) : null;

  const safeRodadaAtual = Number.isFinite(rodadaAtual) && rodadaAtual > 0 ? rodadaAtual : 1;

  // regra prática: status_mercado === 1 => mercado aberto (time ainda pode mudar)
  const mercadoAberto = statusMercado === 1;

  const lastFinished = Math.max(0, mercadoAberto ? safeRodadaAtual - 1 : safeRodadaAtual);

  return { rodadaAtual: safeRodadaAtual, lastFinished, statusMercado };
}

function positionNameFromId(id: number) {
  // 1: GOL, 2: LAT, 3: ZAG, 4: MEI, 5: ATA, 6: TEC
  const map: Record<number, string> = { 1: "GOL", 2: "LAT", 3: "ZAG", 4: "MEI", 5: "ATA", 6: "TEC" };
  return map[id] ?? `POS_${id}`;
}

type ImportBody = {
  id: number;              // team_id (obrigatório)
  slug?: string;           // opcional (vamos atualizar em fantasy_teams)
  name?: string;           // opcional
  cartoleiro?: string;     // opcional
  badge_url?: string;      // opcional
  force?: boolean;         // reimporta rodadas já existentes
};

export async function POST(req: Request) {
  const sb = supabase();
  const body = (await req.json().catch(() => ({}))) as Partial<ImportBody>;

  const teamId = Number(body?.id);
  if (!Number.isFinite(teamId) || teamId <= 0) {
    return NextResponse.json({ ok: false, error: "missing/invalid id (team_id)" }, { status: 400 });
  }

  const force = Boolean(body?.force);

  // 1) Descobrir última rodada finalizada
  const { rodadaAtual, lastFinished, statusMercado } = await getLastFinishedRound();

  if (lastFinished <= 0) {
    return NextResponse.json({
      ok: true,
      teamId,
      rodadaAtual,
      statusMercado,
      lastFinishedRound: lastFinished,
      importedRounds: 0,
      importedPicks: 0,
      skippedRounds: 0,
      errors: [],
      message: "Nenhuma rodada finalizada ainda (mercado aberto / início de temporada).",
    });
  }

  // 2) Buscar snapshot da rodada 1 para canonicalizar nome/slug/escudo/cartoleiro
  // (se falhar, usamos o que veio do body)
  let ref: any | null = null;
  try {
    ref = await fetchJson(`${CARTOLA_BASE}/time/id/${teamId}/1`);
  } catch {
    ref = null;
  }

  const slug =
    String(ref?.time?.slug ?? body?.slug ?? "").trim() ||
    `time-${teamId}`;

  const name =
    String(ref?.time?.nome ?? body?.name ?? "").trim() ||
    slug;

  const cartoleiroName =
    String(ref?.time?.nome_cartola ?? body?.cartoleiro ?? "").trim() ||
    null;

  const badgeUrl =
    String(ref?.time?.url_escudo_png ?? ref?.time?.url_escudo_svg ?? body?.badge_url ?? "").trim() ||
    null;

  // 3) Upsert fantasy_teams (PK = team_id)
  const upTeam = await sb.from("fantasy_teams").upsert(
    {
      team_id: teamId,
      slug,
      name,
      cartoleiro_name: cartoleiroName,
      badge_url: badgeUrl,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "team_id" }
  );

  if (upTeam.error) {
    return NextResponse.json({ ok: false, error: upTeam.error.message }, { status: 500 });
  }

  // 4) Carregar matches da rodada quando necessário para opponent/home
  // (assume que bootstrap já foi executado)
  const getMatchesForRound = async (round: number) => {
    const r = await sb
      .from("matches")
      .select("home_club_id,away_club_id")
      .eq("round", round);

    return r.data ?? [];
  };

  const findOpponent = (clubId: number, matches: any[]) => {
    for (const m of matches) {
      if (m.home_club_id === clubId) return { opponent: m.away_club_id as number, is_home: true as boolean };
      if (m.away_club_id === clubId) return { opponent: m.home_club_id as number, is_home: false as boolean };
    }
    return { opponent: null as number | null, is_home: null as boolean | null };
  };

  // 5) Rodadas a importar: 1..lastFinished
  const roundsToImport = Array.from({ length: lastFinished }, (_, i) => i + 1);

  let importedRounds = 0;
  let importedPicks = 0;
  let skippedRounds = 0;
  const errors: Array<{ round: number; error: string }> = [];

  for (const round of roundsToImport) {
    // pula se já existe e não é force
    if (!force) {
      const ex = await sb
        .from("team_rounds")
        .select("id")
        .eq("team_id", teamId)
        .eq("round", round)
        .maybeSingle();

      if (ex.data?.id) {
        skippedRounds++;
        continue;
      }
    }

    try {
      const snapshot = await fetchJson(`${CARTOLA_BASE}/time/id/${teamId}/${round}`);

      // Se a API disser "Rodada inválida", paramos.
      if (snapshot?.mensagem && String(snapshot.mensagem).toLowerCase().includes("rodada inválida")) {
        errors.push({ round, error: `Rodada inválida (API): ${snapshot.mensagem}` });
        break;
      }

      const points =
        snapshot?.pontos ??
        snapshot?.pontuacao ??
        snapshot?.time?.pontos ??
        snapshot?.time?.pontuacao ??
        null;

      const patrimonio =
        snapshot?.patrimonio ??
        snapshot?.time?.patrimonio ??
        snapshot?.patrimonio_atual ??
        null;

      // upsert team_rounds por (team_id, round)
      const upRound = await sb.from("team_rounds").upsert(
        {
          team_id: teamId,
          round,
          points: typeof points === "number" ? points : null,
          patrimonio: typeof patrimonio === "number" ? patrimonio : null,
          raw: snapshot,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "team_id,round" }
      );

      if (upRound.error) throw new Error(upRound.error.message);

      const tr = await sb
        .from("team_rounds")
        .select("id")
        .eq("team_id", teamId)
        .eq("round", round)
        .single();

      const teamRoundId = tr.data?.id;

if (!teamRoundId) {
  return NextResponse.json(
    { ok: false, error: "Falha ao criar team_round." },
    { status: 500 }
  );
}


      // force = limpa picks da rodada antes de reinserir
      if (force) {
        await sb.from("picks").delete().eq("team_round_id", teamRoundId);
      }

      const matches = await getMatchesForRound(round);

      const atletas: any[] = Array.isArray(snapshot?.atletas) ? snapshot.atletas : [];
      const capId = snapshot?.capitao_id ?? snapshot?.time?.capitao_id ?? null;

      const picksPayload = atletas.map((a: any) => {
        const atleta_id = Number(a?.atleta_id ?? a?.id);
        const apelido = a?.apelido ?? a?.apelido_abreviado ?? a?.nome ?? null;
        const posId = Number(a?.posicao_id ?? a?.posicao ?? a?.posicaoId);
        const clubId = Number(a?.clube_id ?? a?.clubeId ?? a?.time_id);

        const pts = a?.pontos_num ?? a?.pontuacao ?? a?.pontos ?? null;

        const scouts = a?.scout ?? a?.scouts ?? null;
        const had_sg = scouts && typeof scouts === "object" ? Boolean(scouts.SG) : false;
        const had_goal = scouts && typeof scouts === "object" ? Boolean(scouts.G) : false;
        const had_assist = scouts && typeof scouts === "object" ? Boolean(scouts.A) : false;

        const opp = Number.isFinite(clubId) ? findOpponent(clubId, matches) : { opponent: null, is_home: null };

        return {
          team_round_id: teamRoundId,
          team_id: teamId,

          atleta_id: Number.isFinite(atleta_id) ? atleta_id : null,
          atleta_name: apelido,

          position_id: Number.isFinite(posId) ? posId : null,
          position_name: Number.isFinite(posId) ? positionNameFromId(posId) : null,

          club_id: Number.isFinite(clubId) ? clubId : null,

          is_captain: capId ? atleta_id === Number(capId) : false,
          points: typeof pts === "number" ? pts : null,

          opponent_club_id: opp.opponent,
          is_home: opp.is_home,

          had_sg,
          had_goal,
          had_assist,
          scouts,
        };
      });

      if (picksPayload.length) {
        const ins = await sb
          .from("picks")
          .upsert(picksPayload, { onConflict: "team_round_id,atleta_id" });
        if (ins.error) throw new Error(ins.error.message);
        importedPicks += picksPayload.length;
      }

      importedRounds++;
    } catch (e: any) {
      const msg = String(e?.message ?? "error");
      if (msg.includes("Rodada inválida")) {
        errors.push({ round, error: msg });
        break;
      }
      errors.push({ round, error: msg });
    }
  }

  return NextResponse.json({
    ok: true,
    teamId,
    slug,
    name,
    rodadaAtual,
    statusMercado,
    lastFinishedRound: lastFinished,
    force,
    importedRounds,
    importedPicks,
    skippedRounds,
    errors,
  });
}
