// Abre (ou foca) a janela do painel. Chrome fecha popups de action ao perder foco,
// então o painel é uma janela do tipo "popup" que fica aberta durante a reunião.
async function openMonitor(focused) {
  const { monitorWin } = await chrome.storage.session.get("monitorWin");
  if (monitorWin) {
    try {
      await chrome.windows.update(monitorWin, { focused });
      return;
    } catch {}
  }
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL("src/monitor.html"),
    type: "popup",
    width: 400,
    height: 640,
    focused,
  });
  await chrome.storage.session.set({ monitorWin: w.id });
}

// Abas do Meet abertas antes de instalar/recarregar a extensão não têm o content script:
// injeta nelas e pede para publicarem o estado agora.
async function scanMeetTabs() {
  const tabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
  for (const t of tabs) {
    try {
      await chrome.tabs.sendMessage(t.id, { type: "scan" });
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["src/adapter-meet.js", "src/content.js"] });
      } catch {}
    }
  }
}

chrome.action.onClicked.addListener(async () => {
  await openMonitor(true);
  scanMeetTabs();
});
chrome.runtime.onInstalled.addListener(scanMeetTabs);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "call-started") openMonitor(false);
  if (msg && msg.type === "scan") scanMeetTabs();
});

chrome.windows.onRemoved.addListener(async (id) => {
  const { monitorWin } = await chrome.storage.session.get("monitorWin");
  if (monitorWin === id) chrome.storage.session.remove("monitorWin");
});
