window.Common = (() => {
  const DEFAULTS = {
    avgRate: 80,
    budgetLimit: 2000,
    tiers: [
      { name: "Júnior", rate: 40 },
      { name: "Pleno", rate: 70 },
      { name: "Sênior", rate: 110 },
      { name: "Gestão", rate: 160 },
    ],
  };
  const brl = (v) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const fmtTime = (ms) => {
    const s = Math.floor(ms / 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  };
  const compact = (v) => (v < 1000 ? String(Math.round(v)) : v < 1e6 ? (v / 1000).toFixed(1) + "k" : (v / 1e6).toFixed(1) + "M");
  async function loadConfig() {
    const [local, managed] = await Promise.all([
      chrome.storage.local.get("config"),
      chrome.storage.managed.get(null).catch(() => ({})),
    ]);
    // Política da empresa vence a config pessoal.
    return { ...DEFAULTS, ...(local.config || {}), ...managed };
  }
  return { DEFAULTS, brl, fmtTime, compact, loadConfig };
})();
