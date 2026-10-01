(async () => {
  const { brl, fmtTime, compact, loadConfig } = Common;
  const app = document.getElementById("app"); // pode ser movido para a janela PiP
  const $ = (s) => app.querySelector(s);
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (n) => n.trim().toLowerCase();

  let cfg = await loadConfig();
  const st = await chrome.storage.local.get(["session", "meet", "pendingSummary"]);
  let session = st.session || null;
  if (session && !session.people) Object.assign(session, { people: [], defaultRate: session.avgRate || cfg.avgRate, nextId: 1 }); // sessão de versão antiga
  if (session) session.people.forEach((p) => { p.group ??= p.id; p.n ??= 1; p.key ??= p.name.trim().toLowerCase(); });
  let meet = st.meet || {};
  let summary = st.pendingSummary || null;

  let view = null;        // idle | form | live | summary
  let formOpen = false;   // form aberto manualmente (iniciar manual / ajustar)
  let draft = null;
  let skipped = null;     // código da reunião em que o usuário pulou o check-in
  let lostAt = 0;
  let pip = null;
  let plistSig = "";
  let settingsOpen = false;
  let sdraft = null;      // rascunho das configurações
  let shist = [];         // histórico exibido nas configurações
  let smanaged = {};      // chaves definidas por política da organização
  let sflash = "";

  // Meet publicando há pouco = chamada em andamento (evita estado velho de reunião já encerrada).
  const inCall = () => !!meet.inCall && Date.now() - (meet.ts || 0) < 20000;

  const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
  // "HH:MM" de hoje; se cair no futuro (reunião começou antes da meia-noite) vale o dia anterior.
  function parseStart(v) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v || "");
    if (!m) return Date.now();
    const d = new Date();
    d.setHours(+m[1], +m[2], 0, 0);
    return d.getTime() > Date.now() + 60000 ? d.getTime() - 86400000 : Math.min(d.getTime(), Date.now());
  }

  // ---------- modelo ----------
  const presentOf = (s) => s.people.filter((p) => p.present);
  const rateOf = (s) =>
    s.mode === "avg" ? s.avgRate * s.headcount
    : s.mode === "people" ? presentOf(s).reduce((a, p) => a + p.rate, 0)
    : cfg.tiers.reduce((a, t, i) => a + t.rate * (s.tierCounts[i] || 0), 0);
  const peopleOf = (s) =>
    s.mode === "avg" ? s.headcount
    : s.mode === "people" ? presentOf(s).length
    : Object.values(s.tierCounts).reduce((a, b) => a + b, 0);

  // Cada segmento vale até o início do próximo (ou até `end`). Pausado não conta tempo nem custo.
  // No modo "people" o segmento guarda quem estava presente e a que valor, para o custo individual.
  function totals(s, end) {
    let cost = 0, ms = 0, peopleMs = 0, pausedMs = 0, peak = 0;
    const per = {};
    s.segments.forEach((seg, i) => {
      const to = s.segments[i + 1] ? s.segments[i + 1].t : end;
      const d = Math.max(0, to - seg.t);
      if (seg.paused) { pausedMs += d; return; }
      ms += d;
      peopleMs += seg.people * d;
      cost += (seg.rate * d) / 3.6e6;
      peak = Math.max(peak, seg.people);
      (seg.parts || []).forEach((p) => {
        const r = (per[p.id] ||= { ms: 0, cost: 0 });
        r.ms += d;
        r.cost += (p.rate * d) / 3.6e6;
      });
    });
    return { cost, ms, pausedMs, peak, avgPeople: ms ? peopleMs / ms : 0, per };
  }
  function pushSeg(s, paused = !!s.paused) {
    s.paused = paused;
    s.segments.push({
      t: Date.now(), rate: rateOf(s), paused, people: peopleOf(s),
      parts: s.mode === "people" ? presentOf(s).map((p) => ({ id: p.id, rate: p.rate })) : undefined,
    });
  }
  const saveSession = () => chrome.storage.local.set({ session });

  // Cada passagem de uma pessoa pela reunião é uma entrada (linha) própria. Saiu e voltou = nova entrada,
  // todas ligadas pelo mesmo `group`/`key`. O custo individual do relatório soma as entradas do grupo.
  const mkPerson = (id, name, rate, manual) => ({
    id, group: id, n: 1, key: norm(name), name, rate, present: true, manual, locked: false, removed: false, miss: 0,
    statusAt: Date.now(), joinedAt: Date.now(), leftAt: null,
  });
  function addEntry(s, name, rate, manual = true) {
    const prev = s.people.filter((x) => (x.key || norm(x.name)) === norm(name));
    const p = mkPerson("p" + s.nextId++, name, rate, manual);
    if (prev.length) { const last = prev[prev.length - 1]; Object.assign(p, { group: last.group, n: prev.length + 1, name: last.name, key: last.key }); }
    s.people.push(p);
    return p;
  }
  const leave = (p) => { if (p.present) { p.present = false; p.statusAt = p.leftAt = Date.now(); } };
  const ignoreKey = (p) => { (session.ignored ||= {})[p.key] = true; };

  // Sincroniza a lista de pessoas com os nomes detectados no Meet.
  // `locked` = presença forçada pelo usuário; vale até o Meet confirmar que a pessoa está lá.
  // `ignored` = usuário disse que saiu/removeu; não recria a entrada até a pessoa sumir do Meet.
  function syncPeople(names) {
    if (!session || session.mode !== "people" || !names || !names.length) return false;
    let changed = false;
    const seen = new Set(names.map(norm));
    const ign = (session.ignored ||= {});
    for (const k of Object.keys(ign)) if (!seen.has(k)) delete ign[k];
    for (const n of names) {
      const k = norm(n);
      const cur = session.people.find((x) => x.key === k && x.present && !x.removed);
      if (cur) { cur.miss = 0; cur.locked = false; continue; }
      if (ign[k]) continue;
      const prev = session.people.filter((x) => x.key === k).pop();
      addEntry(session, n, prev ? prev.rate : session.defaultRate, false);
      changed = true;
    }
    // Saída automática só depois de 3 leituras seguidas sem aparecer (evita oscilação do DOM).
    for (const p of session.people) {
      if (!p.present || p.removed || p.manual || p.locked || seen.has(p.key)) continue;
      p.miss = (p.miss || 0) + 1;
      if (p.miss >= 3) { leave(p); changed = true; }
    }
    return changed;
  }

  // ---------- views ----------
  function decide() {
    let v;
    if (settingsOpen) v = "settings";
    else if (formOpen) v = "form";
    else if (session) v = "live";
    else if (summary) v = "summary";
    else if (inCall() && skipped !== meet.code) v = "form";
    else v = "idle";
    if (v === "form" && !draft) draft = makeDraft();
    if (v !== view) { view = v; render(); }
  }

  function makeDraft() {
    const tierCounts = session ? { ...session.tierCounts } : Object.fromEntries(cfg.tiers.map((_, i) => [i, 0]));
    const auto = meet.count;
    if (!session && auto) tierCounts[Math.min(1, cfg.tiers.length - 1)] = auto;
    const defaultRate = session ? session.defaultRate : cfg.avgRate;
    let nextId = session ? session.nextId : 1;
    const people = session && session.people.length
      ? session.people.map((p) => ({ ...p, hist: true }))
      : (meet.names || []).map((n) => mkPerson("p" + nextId++, n, defaultRate, false));
    return {
      mode: session ? session.mode : (meet.names && meet.names.length ? "people" : "avg"),
      srcSig: JSON.stringify([meet.names, meet.count]), dirty: false,
      startTime: hhmm(session ? session.start : Date.now()), startTouched: false,
      avgRate: session ? session.avgRate : cfg.avgRate,
      headcount: session ? session.headcount : auto || 2,
      tierCounts, people, defaultRate, nextId,
    };
  }

  function render() {
    plistSig = "";
    if (view === "idle") {
      app.innerHTML = `<header><span>Custo da reunião</span><span class="tools"><button data-act="options" title="Configurações">⚙</button></span></header>
        <div class="idle"><div class="emoji">💸</div><h2>Aguardando reunião</h2>
        <p>Entre numa chamada do Google Meet. O check-in aparece aqui automaticamente.</p>
        <button data-act="manual">Iniciar manualmente</button></div>`;
    } else if (view === "form") renderForm();
    else if (view === "live") renderLive();
    else if (view === "summary") renderSummary();
    else if (view === "settings") renderSettings();
  }

  function renderForm() {
    const editing = !!session;
    const auto = meet.count;
    const opt = (m, title, sub) => `<label class="opt ${draft.mode === m ? "sel" : ""}" data-act="mode" data-m="${m}"><b>${title}</b><small>${sub}</small></label>`;
    let body;
    if (draft.mode === "avg") {
      body = `<div class="row"><span>Valor médio/hora (R$)</span><input id="avg" type="number" min="0" value="${draft.avgRate}"></div>
        <div class="row"><span>Participantes</span><input id="hc" type="number" min="1" value="${draft.headcount}"></div>`;
    } else if (draft.mode === "tiers") {
      body = cfg.tiers.map((t, i) => `<div class="row"><span>${esc(t.name)} <small>${brl(t.rate)}/h</small></span>
        <span class="step"><button data-act="step" data-t="${i}" data-d="-1">−</button><b>${draft.tierCounts[i] || 0}</b><button data-act="step" data-t="${i}" data-d="1">+</button></span></div>`).join("");
    } else {
      const rows = draft.people.map((p, i) => p.removed ? "" : `<div class="prow ${p.present ? "" : "dim"}">
        <input class="nm" data-i="${i}" value="${esc(p.name)}" placeholder="Nome">
        <input class="rt" data-i="${i}" type="number" min="0" value="${p.rate}" title="R$/hora">
        <select class="tr" data-i="${i}" title="Preencher pela faixa"><option value="">faixa</option>${cfg.tiers.map((t, j) => `<option value="${j}">${esc(t.name)}</option>`).join("")}</select>
        <button data-act="delp" data-i="${i}" class="sm" title="${p.hist ? (p.present ? "Marcar ausente" : "Voltar") : "Remover"}">${p.hist && !p.present ? "↺" : "✕"}</button></div>`).join("");
      body = `<div class="row"><span>Valor padrão p/ novos (R$/h)</span><input id="def" type="number" min="0" value="${draft.defaultRate}"></div>
        ${rows || `<p>Nenhum nome detectado no Meet. Adicione manualmente.</p>`}
        <button class="sm" data-act="addp">+ Adicionar pessoa</button>`;
    }
    app.innerHTML = `<header><span>${editing ? "Ajustar" : "Check-in da reunião"}</span></header>
      <h2>${editing ? "Ajustar valores" : "Como calcular o custo?"}</h2>
      ${!editing && inCall() ? `<p>${esc(meet.title || "Chamada do Meet")}${auto ? ` · ${auto} participante(s) detectado(s)` : ""}</p>` : ""}
      <div class="row"><span>Início da reunião</span><span class="step"><input id="start" type="time" value="${draft.startTime}"><button class="sm" data-act="startnow">Agora</button></span></div>
      <p class="note">Já começou? Informe o horário: o custo conta desde lá, com os participantes e valores atuais.</p>
      ${opt("avg", "Média única", "Mesmo valor/hora para todos. Acompanha a contagem do Meet.")}
      ${opt("tiers", "Por faixa", "Quantas pessoas de cada nível.")}
      ${opt("people", "Por pessoa", "Valor individual de cada participante. Gera relatório individual.")}
      ${body}
      <div class="act"><button data-act="cancel">${editing ? "Cancelar" : "Agora não"}</button><button class="pri" data-act="go">${editing ? "Salvar" : "Iniciar contagem"}</button></div>`;
  }

  function renderLive() {
    app.innerHTML = `<div class="live" id="live" style="display:contents">
      <header><span>Custo da reunião</span><span class="tools"><button data-act="pin" title="Fixar sobre as outras janelas">📌</button><button data-act="options" title="Configurações">⚙</button></span></header>
      <div class="cost" id="cost">R$ 0,00</div>
      <div class="bar"><i id="bar"></i></div><div class="budget" id="budget"></div>
      <div class="stats"><div><small id="since">Tempo</small><b id="time"></b></div><div><small>Pessoas</small><b id="ppl"></b></div><div><small>Por hora</small><b id="rate"></b></div></div>
      <div class="hint" id="hint" hidden></div>
      ${session.mode === "people"
        ? `<div class="sec" id="pcount">Participantes</div><div class="plist" id="plist"></div>`
        : `<div class="grow"></div>`}
      <div class="foot">
        ${session.mode === "people"
          ? `<form class="padd" id="padd"><input id="addname" placeholder="Novo participante" autocomplete="off"><input id="addrate" type="number" min="0" value="${session.defaultRate}" title="R$/hora"><button class="pri sm" type="submit">+ Adicionar</button></form>`
          : `<button class="sm" data-act="topeople">👥 Gerenciar participantes individualmente</button>`}
        <div class="act"><button data-act="pause" id="pause"></button><button data-act="adjust">Ajustar</button><button class="danger" data-act="finish">Finalizar</button></div>
      </div></div>`;
    updateLive();
  }

  const since = (t) => fmtTime(Date.now() - (t || Date.now())).replace(/^00:/, "");
  const dur = (ms) => fmtTime(ms).replace(/^00:/, "");
  function updatePList(per) {
    const box = $("#plist");
    if (!box) return;
    const list = session.people.filter((p) => !p.removed).sort((a, b) => b.present - a.present || a.joinedAt - b.joinedAt);
    const lastN = {}; const hasPresent = {};
    list.forEach((p) => { lastN[p.group] = Math.max(lastN[p.group] || 0, p.n); if (p.present) hasPresent[p.group] = true; });
    const canReturn = (p) => !p.present && p.n === lastN[p.group] && !hasPresent[p.group];
    const sig = list.map((p) => `${p.id}|${p.name}|${p.present}|${canReturn(p)}`).join(";");
    const ae = app.ownerDocument.activeElement;
    const typing = ae && ae.tagName === "INPUT" && box.contains(ae); // só adia a reconstrução se estiver digitando
    if (sig !== plistSig && !typing) {
      plistSig = sig;
      box.innerHTML = list.map((p) => `<div class="pr ${p.present ? "" : "gone"}" data-id="${p.id}">
        <div class="l1"><i class="dot"></i><input class="pname" value="${esc(p.name)}" title="Renomear">${p.n > 1 ? `<span class="badge" title="Entrada ${p.n} desta pessoa">↩ voltou</span>` : ""}<span class="pc" data-c></span></div>
        <div class="l2"><input class="prate" type="number" min="0" value="${p.rate}" title="R$/hora"><span class="ps" data-s></span>
          ${p.present ? `<button class="sm" data-act="pleave" data-id="${p.id}">Saiu</button>` : canReturn(p) ? `<button class="sm" data-act="preturn" data-id="${p.id}">Voltou</button>` : ""}
          <button class="sm danger" data-act="pdel" data-id="${p.id}" title="Remover esta entrada da lista (o custo já acumulado continua no relatório)">🗑</button></div></div>`).join("")
        || `<p>Nenhum participante ainda. Adicione abaixo.</p>`;
    }
    box.querySelectorAll(".pr").forEach((row) => {
      const p = session.people.find((x) => x.id === row.dataset.id);
      const ms = per[p.id] ? per[p.id].ms : 0;
      row.querySelector("[data-c]").textContent = brl(per[p.id] ? per[p.id].cost : 0);
      row.querySelector("[data-s]").textContent = p.present
        ? `${p.n > 1 ? "voltou" : "entrou"} às ${hhmm(p.joinedAt)} · ${dur(ms)}`
        : `saiu às ${hhmm(p.leftAt || p.statusAt)} · ficou ${dur(ms)}`;
    });
    const here = list.filter((p) => p.present).length;
    $("#pcount").textContent = `Participantes · ${here} presente(s)${list.length - here ? ` · ${list.length - here} saída(s)` : ""}`;
  }

  function updateLive() {
    if (!session || !$("#live")) return;
    const now = Date.now();
    const { cost, ms, per } = totals(session, now);
    const limit = cfg.budgetLimit;
    const pct = limit > 0 ? Math.min(100, (cost / limit) * 100) : 0;
    const level = limit > 0 && cost >= limit ? "over" : limit > 0 && cost >= limit * 0.8 ? "warn" : "ok";
    $("#live").dataset.level = level;
    app.classList.toggle("paused", !!session.paused);
    $("#cost").textContent = brl(cost);
    $("#bar").style.width = pct + "%";
    $("#budget").textContent = limit > 0 ? `${Math.round(pct)}% do limite de ${brl(limit)}` : "Sem limite definido";
    $("#time").textContent = fmtTime(ms);
    $("#since").textContent = "Desde " + hhmm(session.start);
    $("#ppl").textContent = peopleOf(session);
    $("#rate").textContent = brl(rateOf(session)) + "/h";
    $("#pause").textContent = session.paused ? "▶ Retomar" : "⏸ Pausar";
    const hint = $("#hint");
    const auto = meet.count;
    if (session.mode === "tiers" && inCall() && auto && auto !== peopleOf(session)) {
      hint.hidden = false;
      hint.innerHTML = `<span>Meet detecta ${auto}, você marcou ${peopleOf(session)}.</span><button class="sm" data-act="adjust">Ajustar</button>`;
    } else hint.hidden = true;
    updatePList(per);
    chrome.action.setBadgeText({ text: compact(cost) });
    chrome.action.setBadgeBackgroundColor({ color: level === "over" ? "#d94343" : level === "warn" ? "#d9a300" : "#2ea36b" });
  }

  // ---------- configurações ----------
  async function openSettings() {
    const [{ config }, { history = [] }, managed] = await Promise.all([
      chrome.storage.local.get("config"),
      chrome.storage.local.get("history"),
      chrome.storage.managed.get(null).catch(() => ({})),
    ]);
    const base = { ...Common.DEFAULTS, ...(config || {}) };
    sdraft = { avgRate: base.avgRate, budgetLimit: base.budgetLimit, tiers: base.tiers.map((t) => ({ ...t })) };
    shist = history; smanaged = managed; sflash = "";
    settingsOpen = true; view = null; decide();
  }
  function closeSettings() { settingsOpen = false; sdraft = null; view = null; decide(); }

  function renderSettings() {
    const lock = (k) => (k in smanaged ? "disabled" : "");
    const tiers = sdraft.tiers.map((t, i) => `<div class="srow"><input class="s-tn" data-i="${i}" value="${esc(t.name)}" placeholder="Nome" ${lock("tiers")}>
      <input class="s-tr" data-i="${i}" type="number" min="0" value="${t.rate}" title="R$/hora" ${lock("tiers")}>
      <button class="sm" data-act="stierdel" data-i="${i}" ${lock("tiers")}>✕</button></div>`).join("");
    const hist = shist.slice(0, 8).map((h) => `<tr><td>${new Date(h.start).toLocaleDateString("pt-BR")}</td><td>${esc(h.title)}</td><td>${brl(h.cost)}</td></tr>`).join("");
    app.innerHTML = `<header><span>Configurações</span><span class="tools"><button data-act="sback">← Voltar</button></span></header>
      ${Object.keys(smanaged).length ? `<p class="note">Alguns valores são definidos pela sua organização e não podem ser editados.</p>` : ""}
      <div class="sec">Valores</div>
      <div class="row"><span>Valor médio/hora (R$)</span><input id="s-avg" type="number" min="0" value="${sdraft.avgRate}" ${lock("avgRate")}></div>
      <div class="row"><span>Limite de alerta (R$)</span><input id="s-limit" type="number" min="0" value="${sdraft.budgetLimit}" ${lock("budgetLimit")}></div>
      <div class="sec">Faixas</div>${tiers}
      <button class="sm" data-act="stieradd" ${lock("tiers")}>+ Faixa</button>
      <p class="note">Custo/hora ≈ (salário × encargos 1,8) ÷ 160. Valores ficam só neste navegador.</p>
      <div class="sec">Empresa</div>
      <div class="act"><button data-act="sexp">Exportar JSON</button><button data-act="simp">Importar JSON</button></div>
      <input type="file" id="s-file" accept="application/json" hidden>
      <div class="sec">Histórico</div>
      ${hist ? `<table class="tbl"><tr><th>Data</th><th>Reunião</th><th>Custo</th></tr>${hist}</table>` : "<p>Nenhuma reunião registrada.</p>"}
      <div class="act"><button data-act="hcsv" ${shist.length ? "" : "disabled"}>Exportar CSV</button><button data-act="hclr" ${shist.length ? "" : "disabled"}>Limpar</button></div>
      <div class="act"><button data-act="sback">Voltar</button><button class="pri" data-act="ssave">Salvar e voltar</button></div>
      ${sflash ? `<p class="note">${sflash}</p>` : ""}`;
  }

  async function saveSettings() {
    const cur = {
      avgRate: Math.max(0, +sdraft.avgRate || 0),
      budgetLimit: Math.max(0, +sdraft.budgetLimit || 0),
      tiers: sdraft.tiers.map((t, i) => ({ name: t.name.trim() || `Faixa ${i + 1}`, rate: Math.max(0, +t.rate || 0) })),
    };
    await chrome.storage.local.set({ config: cur });
    cfg = await loadConfig();
    closeSettings();
  }

  const historyCsv = () => "data,reuniao,pessoas,duracao_s,custo\n" + shist.map((r) => [
    new Date(r.start).toISOString(), `"${r.title.replace(/"/g, '""')}"`, r.people,
    Math.round((r.ms ?? (r.end - r.start)) / 1000), r.cost.toFixed(2)].join(",")).join("\n");

  // ---------- relatório ----------
  function renderSummary() {
    const r = summary;
    const hours = r.ms / 3.6e6;
    const stat = (l, v) => `<div><small>${l}</small><b>${v}</b></div>`;
    const modeName = { avg: "Média única", tiers: "Por faixa", people: "Por pessoa" }[r.mode];
    const rows = (r.rows || []).map((p) => `<tr><td>${esc(p.name)}${p.entries > 1 ? ` <small>(${p.entries} entradas)</small>` : ""}<span class="share" style="width:${r.cost ? (p.cost / r.cost) * 100 : 0}%"></span></td>
      <td>${fmtTime(p.ms)}</td><td>${brl(p.cost)}</td><td>${r.cost ? Math.round((p.cost / r.cost) * 100) : 0}%</td></tr>`).join("");
    app.innerHTML = `<header><span>Relatório da reunião</span></header>
      <div><h2>${esc(r.title)}</h2><p>${new Date(r.start).toLocaleString("pt-BR")} · ${modeName}</p></div>
      <div class="cost">${brl(r.cost)}</div>
      <div class="grid2">
        ${stat("Duração", fmtTime(r.ms))}
        ${stat("Pico de pessoas", r.people)}
        ${stat("Média de pessoas", r.avgPeople.toFixed(1).replace(".", ","))}
        ${stat("Custo por minuto", brl(r.ms ? r.cost / (r.ms / 60000) : 0))}
        ${stat("Custo/hora médio", brl(hours ? r.cost / hours : 0))}
        ${stat("Se durasse metade", brl(r.cost / 2))}
        ${r.pausedMs > 1000 ? stat("Tempo pausado", fmtTime(r.pausedMs)) : ""}
      </div>
      <div class="sec">Por participante</div>
      ${rows ? `<table class="tbl"><tr><th>Nome</th><th>Tempo</th><th>Custo</th><th>%</th></tr>${rows}</table>`
        : `<p>Relatório individual só existe no modo <b>Por pessoa</b>. Use-o no próximo check-in.</p>`}
      ${r.partialFrom && rows ? `<p>Individual considera só o período após ${new Date(r.partialFrom).toLocaleTimeString("pt-BR")} (quando passou ao modo por pessoa).</p>` : ""}
      <div class="act wrap"><button data-act="copy">Copiar</button><button data-act="csv">CSV</button><button class="pri" data-act="closeSummary">Fechar</button></div>`;
  }

  function reportText(r) {
    const L = [`Reunião: ${r.title}`, `Data: ${new Date(r.start).toLocaleString("pt-BR")}`, `Custo total: ${brl(r.cost)}`,
      `Duração: ${fmtTime(r.ms)}`, `Pico de pessoas: ${r.people} (média ${r.avgPeople.toFixed(1)})`,
      `Custo/hora médio: ${brl(r.ms ? r.cost / (r.ms / 3.6e6) : 0)}`];
    if (r.rows && r.rows.length) {
      L.push("", "Por participante:");
      r.rows.forEach((p) => L.push(`- ${p.name}${p.entries > 1 ? ` (${p.entries} entradas)` : ""}: ${fmtTime(p.ms)} · ${brl(p.cost)} (${r.cost ? Math.round((p.cost / r.cost) * 100) : 0}%)`));
    }
    return L.join("\n");
  }
  function reportCsv(r) {
    const q = (t) => `"${String(t).replace(/"/g, '""')}"`;
    const L = ["campo,valor", `reuniao,${q(r.title)}`, `inicio,${new Date(r.start).toISOString()}`, `custo_total,${r.cost.toFixed(2)}`,
      `duracao_s,${Math.round(r.ms / 1000)}`, `pico_pessoas,${r.people}`, `media_pessoas,${r.avgPeople.toFixed(2)}`];
    if (r.rows && r.rows.length) {
      L.push("", "participante,entradas,tempo_s,custo,percentual");
      r.rows.forEach((p) => L.push(`${q(p.name)},${p.entries || 1},${Math.round(p.ms / 1000)},${p.cost.toFixed(2)},${r.cost ? ((p.cost / r.cost) * 100).toFixed(1) : 0}`));
    }
    return L.join("\n");
  }

  // ---------- ações ----------
  function submitForm() {
    draft.avgRate = Math.max(0, +draft.avgRate || 0);
    draft.headcount = Math.max(1, +draft.headcount || 1);
    draft.defaultRate = Math.max(0, +draft.defaultRate || 0);
    draft.people.forEach((p, i) => { p.name = p.name.trim() || `Participante ${i + 1}`; p.rate = Math.max(0, +p.rate || 0); delete p.hist; p.key ||= norm(p.name); });
    if (session) {
      Object.assign(session, { mode: draft.mode, avgRate: draft.avgRate, headcount: draft.headcount, tierCounts: draft.tierCounts, people: draft.people, defaultRate: draft.defaultRate, nextId: draft.nextId });
      // Valor digitado manualmente deixa de seguir a contagem automática.
      session.pinned = draft.mode === "avg" && meet.count !== draft.headcount;
      pushSeg(session);
      if (draft.startTouched) setStart(parseStart(draft.startTime));
    } else {
      session = {
        code: inCall() ? meet.code : null, title: inCall() ? meet.title : "Reunião manual", manual: !inCall(),
        mode: draft.mode, avgRate: draft.avgRate, headcount: draft.headcount, tierCounts: draft.tierCounts,
        people: draft.people, defaultRate: draft.defaultRate, nextId: draft.nextId,
        pinned: false, paused: false, start: draft.startTouched ? parseStart(draft.startTime) : Date.now(), segments: [],
      };
      pushSeg(session);
      session.segments[0].t = session.start;
    }
    saveSession();
    formOpen = false; draft = null; lostAt = 0; view = null;
    decide();
  }

  // Move o início da sessão: estende o 1º segmento para trás ou descarta o que vier antes do novo início.
  function setStart(ts) {
    const segs = session.segments;
    if (ts >= segs[0].t) while (segs.length > 1 && segs[1].t <= ts) segs.shift();
    segs[0].t = ts;
    session.start = ts;
  }

  async function finish(end = Date.now(), manualClick = false) {
    if (!session) return;
    const s = session;
    const t = totals(s, end);
    const rec = {
      code: s.code, title: s.title, start: s.start, end, ms: t.ms, pausedMs: t.pausedMs, cost: t.cost,
      people: t.peak, avgPeople: t.avgPeople, mode: s.mode, partialFrom: s.convertedAt || null,
      rows: s.mode === "people"
        ? Object.values(s.people.reduce((g, p) => {
            const r = t.per[p.id];
            if (!r) return g;
            const x = (g[p.group] ||= { name: p.name, ms: 0, cost: 0, entries: 0 });
            x.ms += r.ms; x.cost += r.cost; x.entries++;
            return g;
          }, {})).sort((a, b) => b.cost - a.cost)
        : [],
    };
    session = null; summary = rec; view = null;
    if (manualClick) skipped = meet.code;
    chrome.action.setBadgeText({ text: "" });
    const { history = [] } = await chrome.storage.local.get("history");
    history.unshift(rec);
    await chrome.storage.local.set({ history: history.slice(0, 500), pendingSummary: rec });
    await chrome.storage.local.remove("session");
    decide();
  }

  async function pin() {
    if (!window.documentPictureInPicture) return alert("Este Chrome não suporta janela flutuante (precisa da versão 116+).");
    if (pip) { pip.close(); return; }
    pip = await documentPictureInPicture.requestWindow({ width: 360, height: 520 });
    const link = pip.document.createElement("link");
    link.rel = "stylesheet"; link.href = chrome.runtime.getURL("src/monitor.css");
    pip.document.head.append(link);
    pip.document.body.append(app);
    pip.addEventListener("pagehide", () => { document.body.prepend(app); pip = null; });
  }

  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
  }

  app.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    if (draft && ["mode", "step", "addp", "delp", "startnow"].includes(act)) draft.dirty = true;
    if (act === "startnow") { draft.startTime = hhmm(Date.now()); draft.startTouched = true; render(); return; }
    if (act === "mode") { draft.mode = el.dataset.m; render(); }
    else if (act === "step") { const i = +el.dataset.t; draft.tierCounts[i] = Math.max(0, (draft.tierCounts[i] || 0) + +el.dataset.d); render(); }
    else if (act === "addp") {
      draft.people.push(mkPerson("p" + draft.nextId++, "", draft.defaultRate, true));
      render();
    } else if (act === "delp") {
      const p = draft.people[+el.dataset.i];
      if (p.hist) { p.present = !p.present; p.locked = true; } else draft.people.splice(+el.dataset.i, 1);
      render();
    }
    else if (act === "go") submitForm();
    else if (act === "cancel") { if (!session) skipped = meet.code; formOpen = false; draft = null; view = null; decide(); }
    else if (act === "manual" || act === "adjust") { formOpen = true; draft = null; view = null; decide(); }
    else if (act === "options") openSettings();
    else if (act === "sback") closeSettings();
    else if (act === "ssave") saveSettings();
    else if (act === "stieradd") { sdraft.tiers.push({ name: "", rate: 50 }); render(); }
    else if (act === "stierdel") { sdraft.tiers.splice(+el.dataset.i, 1); render(); }
    else if (act === "sexp") download("custo-reuniao-config.json", JSON.stringify(sdraft, null, 2), "application/json");
    else if (act === "simp") $("#s-file").click();
    else if (act === "hcsv") download("reunioes.csv", historyCsv(), "text/csv");
    else if (act === "hclr") { if (confirm("Apagar todo o histórico?")) { shist = []; chrome.storage.local.remove("history"); render(); } }
    else if (act === "pin") pin();
    else if (act === "pause") { pushSeg(session, !session.paused); saveSession(); updateLive(); }
    else if (act === "finish") finish(Date.now(), true);
    else if (act === "pleave") {
      const p = session.people.find((x) => x.id === el.dataset.id);
      leave(p); p.locked = false; ignoreKey(p);
      afterPeopleChange();
    } else if (act === "preturn") {
      // Volta = nova entrada na lista (mesma pessoa), marcada como "voltou".
      const p = session.people.find((x) => x.id === el.dataset.id);
      const e2 = addEntry(session, p.name, p.rate, false);
      e2.locked = true;
      delete session.ignored?.[p.key];
      afterPeopleChange();
    } else if (act === "pdel") {
      const p = session.people.find((x) => x.id === el.dataset.id);
      leave(p); p.removed = true; ignoreKey(p);
      afterPeopleChange();
    } else if (act === "topeople") toPeople();
    else if (act === "closeSummary") { summary = null; chrome.storage.local.remove("pendingSummary"); view = null; decide(); }
    else if (act === "copy") { navigator.clipboard.writeText(reportText(summary)); el.textContent = "Copiado ✓"; }
    else if (act === "csv") download(`reuniao-${new Date(summary.start).toISOString().slice(0, 10)}.csv`, reportCsv(summary), "text/csv");
  });

  app.addEventListener("submit", (e) => {
    if (e.target.id !== "padd") return;
    e.preventDefault();
    const name = $("#addname").value.trim();
    if (!name) return;
    const rate = Math.max(0, +$("#addrate").value || 0);
    const cur = session.people.find((x) => x.key === norm(name) && x.present && !x.removed);
    if (cur) cur.rate = rate; // já está na lista
    else { addEntry(session, name, rate).locked = true; delete session.ignored?.[norm(name)]; }
    $("#addname").value = "";
    afterPeopleChange();
  });

  // Registra a mudança (novo segmento de custo) e redesenha a lista na hora.
  function afterPeopleChange() {
    pushSeg(session); saveSession(); plistSig = ""; updateLive();
  }

  // Converte uma sessão em andamento (média/faixa) para o modo por pessoa, sem perder o custo acumulado.
  function toPeople() {
    const rate = session.mode === "avg" ? session.avgRate : cfg.avgRate;
    const total = peopleOf(session);
    session.mode = "people";
    session.defaultRate = rate;
    session.convertedAt = Date.now(); // o relatório individual só cobre dali em diante
    session.people = [];
    (meet.names || []).forEach((n) => addEntry(session, n, rate, false));
    while (session.people.length < total) addEntry(session, `Participante ${session.people.length + 1}`, rate);
    pushSeg(session); saveSession(); view = null; decide();
  }

  // Edição de campos: no formulário atualiza o rascunho; na lista ao vivo atualiza a sessão.
  app.addEventListener("input", (e) => {
    const t = e.target;
    if (view === "settings") {
      const i = +t.dataset.i;
      if (t.id === "s-avg") sdraft.avgRate = +t.value;
      else if (t.id === "s-limit") sdraft.budgetLimit = +t.value;
      else if (t.classList.contains("s-tn")) sdraft.tiers[i].name = t.value;
      else if (t.classList.contains("s-tr")) sdraft.tiers[i].rate = +t.value;
      return;
    }
    if (view !== "form" || !draft) return;
    draft.dirty = true;
    const i = +t.dataset.i;
    if (t.id === "avg") draft.avgRate = +t.value;
    else if (t.id === "hc") draft.headcount = +t.value;
    else if (t.id === "def") draft.defaultRate = +t.value;
    else if (t.id === "start") { draft.startTime = t.value; draft.startTouched = true; }
    else if (t.classList.contains("nm")) draft.people[i].name = t.value;
    else if (t.classList.contains("rt")) draft.people[i].rate = +t.value;
  });
  app.addEventListener("change", async (e) => {
    const t = e.target;
    if (view === "settings" && t.id === "s-file") {
      try {
        const j = JSON.parse(await t.files[0].text());
        if (j.avgRate != null) sdraft.avgRate = +j.avgRate || 0;
        if (j.budgetLimit != null) sdraft.budgetLimit = +j.budgetLimit || 0;
        if (Array.isArray(j.tiers)) sdraft.tiers = j.tiers.map((x) => ({ name: String(x.name || ""), rate: +x.rate || 0 }));
        sflash = "Importado. Clique em Salvar para aplicar.";
      } catch { sflash = "JSON inválido."; }
      render();
      return;
    }
    if (view === "form" && t.classList.contains("tr") && t.value !== "") {
      draft.dirty = true;
      draft.people[+t.dataset.i].rate = cfg.tiers[+t.value].rate;
      render();
    } else if (view === "live" && (t.classList.contains("prate") || t.classList.contains("pname"))) {
      const p = session.people.find((x) => x.id === t.closest(".pr").dataset.id);
      if (t.classList.contains("prate")) p.rate = Math.max(0, +t.value || 0);
      else { const nm = t.value.trim() || p.name; session.people.forEach((x) => { if (x.group === p.group) x.name = nm; }); }
      afterPeopleChange();
    }
  });

  // ---------- sinais do Meet ----------
  function onMeetChange() {
    if (session) {
      if (session.mode === "avg" && !session.pinned && !session.paused && inCall() && meet.count && meet.count !== session.headcount) {
        session.headcount = meet.count;
        pushSeg(session);
        saveSession();
      } else if (session.mode === "people" && inCall() && syncPeople(meet.names)) {
        if (!session.paused) pushSeg(session);
        saveSession();
      }
    }
    // Check-in aberto e ainda intocado: reflete na hora o que o Meet detectar (nomes chegam depois do scan).
    if (view === "form" && !session && draft && !draft.dirty && draft.srcSig !== JSON.stringify([meet.names, meet.count])) {
      draft = makeDraft();
      render();
    }
    decide();
    if (view === "live") updateLive();
  }

  chrome.storage.onChanged.addListener(async (ch, area) => {
    if (area !== "local") return;
    if (ch.config) cfg = await loadConfig();
    if (ch.meet) { meet = ch.meet.newValue || {}; onMeetChange(); }
  });

  setInterval(() => {
    const now = Date.now();
    if (session && !session.manual) {
      // Meet sumiu (saiu da chamada, fechou aba) por >15s => encerra.
      if (!meet.inCall || now - (meet.ts || 0) > 20000) {
        if (!lostAt) lostAt = now;
        if (now - lostAt > 15000) return finish(Math.min(now, Math.max(meet.ts || 0, session.segments[session.segments.length - 1].t)));
      } else lostAt = 0;
    }
    if (view === "live") updateLive();
  }, 1000);

  decide();
  // Pede às abas do Meet que publiquem agora (injeta o script se a aba já estava aberta antes da extensão).
  chrome.runtime.sendMessage({ type: "scan" }).catch(() => {});
})();
