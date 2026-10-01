const $ = (id) => document.getElementById(id);
const brl = (v) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const DEF = { avgRate: 80, budgetLimit: 2000, tiers: [
  { name: "Júnior", rate: 40 }, { name: "Pleno", rate: 70 }, { name: "Sênior", rate: 110 }, { name: "Gestão", rate: 160 }] };
let cfg;

function drawTiers() {
  $("tiers").innerHTML = "";
  cfg.tiers.forEach((t, i) => {
    const d = document.createElement("div"); d.className = "tier";
    d.innerHTML = `<input value="${t.name}" data-k="name"><input type="number" min="0" value="${t.rate}" data-k="rate"><button class="g">✕</button>`;
    d.querySelectorAll("input").forEach((inp) => (inp.oninput = () => (cfg.tiers[i][inp.dataset.k] = inp.dataset.k === "rate" ? +inp.value : inp.value)));
    d.querySelector("button").onclick = () => { cfg.tiers.splice(i, 1); drawTiers(); };
    $("tiers").appendChild(d);
  });
}
function flash(t) { $("msg").textContent = t; setTimeout(() => ($("msg").textContent = ""), 2000); }
function download(name, text, type) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
}
async function drawHist() {
  const { history = [] } = await chrome.storage.local.get("history");
  $("hist").innerHTML = "<tr><th>Data</th><th>Reunião</th><th>Pessoas</th><th>Custo</th></tr>" +
    history.slice(0, 50).map((h) => `<tr><td>${new Date(h.start).toLocaleString("pt-BR")}</td><td>${h.title}</td><td>${h.people}</td><td>${brl(h.cost)}</td></tr>`).join("");
  return history;
}
(async () => {
  const { config } = await chrome.storage.local.get("config");
  cfg = { ...DEF, ...(config || {}) };
  $("avg").value = cfg.avgRate; $("limit").value = cfg.budgetLimit; drawTiers(); drawHist();
  $("add").onclick = () => { cfg.tiers.push({ name: "Nova", rate: 50 }); drawTiers(); };
  $("save").onclick = async () => {
    cfg.avgRate = +$("avg").value; cfg.budgetLimit = +$("limit").value;
    await chrome.storage.local.set({ config: cfg }); flash("Salvo ✓");
  };
  $("exp").onclick = () => download("custo-reuniao-config.json", JSON.stringify(cfg, null, 2), "application/json");
  $("imp").onclick = () => $("file").click();
  $("file").onchange = async (e) => {
    try {
      const j = JSON.parse(await e.target.files[0].text());
      cfg = { ...DEF, ...j }; $("avg").value = cfg.avgRate; $("limit").value = cfg.budgetLimit; drawTiers(); flash("Importado — clique em Salvar");
    } catch { flash("JSON inválido"); }
  };
  $("csv").onclick = async () => {
    const h = await drawHist();
    download("reunioes.csv", "data,reuniao,pessoas,duracao_s,custo\n" + h.map((r) =>
      [new Date(r.start).toISOString(), `"${r.title.replace(/"/g, '""')}"`, r.people, Math.round((r.ms ?? (r.end - r.start)) / 1000), r.cost.toFixed(2)].join(",")).join("\n"), "text/csv");
  };
  $("clr").onclick = async () => { if (confirm("Apagar histórico?")) { await chrome.storage.local.remove("history"); drawHist(); } };
})();
