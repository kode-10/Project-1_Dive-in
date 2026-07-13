// ---------- AI Connections: pluggable multi-provider manager ----------
// Supports Anthropic, Google AI Studio (Gemini), and any OpenAI-compatible
// endpoint (Groq, OpenRouter, Together, Mistral, DeepSeek, local Ollama/LM
// Studio, etc.) — the last one is what makes this scale to "any provider"
// without needing bespoke code per service.
(function () {
  const STORAGE = "nodeway.connections";
  const ACTIVE_STORAGE = "nodeway.activeConnectionId";

  const PROVIDER_META = {
    gemini: {
      label: "Google AI Studio (Gemini)",
      defaultModel: "gemini-2.5-flash",
      needsBaseUrl: false,
      help: "Free key at aistudio.google.com/apikey. Generous free tier, good default choice.",
    },
    anthropic: {
      label: "Anthropic (Claude)",
      defaultModel: "claude-haiku-4-5-20251001",
      needsBaseUrl: false,
      help: "Key at console.anthropic.com. Pay-as-you-go, pennies per call on Haiku.",
    },
    "openai-compatible": {
      label: "OpenAI-compatible",
      defaultModel: "",
      needsBaseUrl: true,
      help: "Works with any provider implementing the OpenAI chat/completions format. Free options: Groq (console.groq.com — fast, generous free tier, e.g. model \"llama-3.3-70b-versatile\"), OpenRouter (openrouter.ai — has free models, e.g. \"meta-llama/llama-3.3-70b-instruct:free\").",
    },
  };

  // ---------- storage ----------
  function uid() {
    return "c_" + Math.random().toString(36).slice(2, 10);
  }
  function getConnections() {
    try {
      const list = JSON.parse(localStorage.getItem(STORAGE));
      if (Array.isArray(list)) return list;
    } catch {}
    return [];
  }
  function saveConnections(list) {
    localStorage.setItem(STORAGE, JSON.stringify(list));
  }
  function getActiveId() {
    return localStorage.getItem(ACTIVE_STORAGE) || "";
  }
  function setActiveId(id) {
    localStorage.setItem(ACTIVE_STORAGE, id);
    updateGearDot();
  }
  function getActiveConnection() {
    return getConnections().find((c) => c.id === getActiveId()) || null;
  }

  function addConnection({ provider, nickname, apiKey, model, baseUrl }) {
    const meta = PROVIDER_META[provider];
    const list = getConnections();
    const conn = {
      id: uid(),
      provider,
      nickname: (nickname || "").trim() || meta.label,
      apiKey: (apiKey || "").trim(),
      model: (model || "").trim() || meta.defaultModel,
      baseUrl: (baseUrl || "").trim().replace(/\/$/, ""),
      status: "unknown",
      lastTestedAt: null,
    };
    list.push(conn);
    saveConnections(list);
    if (!getActiveId()) setActiveId(conn.id);
    return conn;
  }

  function removeConnection(id) {
    const list = getConnections().filter((c) => c.id !== id);
    saveConnections(list);
    if (getActiveId() === id) setActiveId(list[0]?.id || "");
    updateGearDot();
  }

  function updateConnection(id, patch) {
    const list = getConnections();
    const idx = list.findIndex((c) => c.id === id);
    if (idx === -1) return;
    list[idx] = { ...list[idx], ...patch };
    saveConnections(list);
  }

  // ---------- provider adapters ----------
  async function callAnthropic(conn, prompt) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": conn.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: conn.model,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error("anthropic http " + res.status);
    const data = await res.json();
    return (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");
  }

  async function callGemini(conn, prompt) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(conn.model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": conn.apiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    if (!res.ok) throw new Error("gemini http " + res.status);
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text || "").join("\n\n");
  }

  async function callOpenAiCompatible(conn, prompt) {
    if (!conn.baseUrl) throw new Error("missing base url");
    const res = await fetch(`${conn.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${conn.apiKey}`,
      },
      body: JSON.stringify({
        model: conn.model,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error("openai-compatible http " + res.status);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  async function call(conn, prompt) {
    if (conn.provider === "anthropic") return callAnthropic(conn, prompt);
    if (conn.provider === "gemini") return callGemini(conn, prompt);
    if (conn.provider === "openai-compatible") return callOpenAiCompatible(conn, prompt);
    throw new Error("unknown provider " + conn.provider);
  }

  async function callActive(prompt) {
    const conn = getActiveConnection();
    if (!conn || !conn.apiKey) return null;
    return call(conn, prompt);
  }

  async function testConnection(id) {
    const conn = getConnections().find((c) => c.id === id);
    if (!conn) return "error";
    let status = "error";
    try {
      const text = await call(conn, 'Reply with exactly one word: OK');
      status = text && text.trim().length > 0 ? "ok" : "error";
    } catch (err) {
      status = "error";
    }
    updateConnection(id, { status, lastTestedAt: Date.now() });
    updateGearDot();
    return status;
  }

  // ---------- gear icon status dot ----------
  function updateGearDot() {
    const dot = document.getElementById("gearStatusDot");
    if (!dot) return;
    const conn = getActiveConnection();
    dot.classList.remove("status-ok", "status-error", "status-unknown");
    if (!conn) {
      dot.classList.add("status-unknown");
      dot.title = "No AI connection set up";
    } else if (conn.status === "ok") {
      dot.classList.add("status-ok");
      dot.title = `Connected — ${conn.nickname}`;
    } else if (conn.status === "error") {
      dot.classList.add("status-error");
      dot.title = `${conn.nickname} — last test failed`;
    } else {
      dot.classList.add("status-unknown");
      dot.title = `${conn.nickname} — not tested yet`;
    }
  }

  // ---------- settings modal UI ----------
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function renderConnectionsList() {
    const list = getConnections();
    const activeId = getActiveId();
    const el = document.getElementById("connectionsList");
    if (!el) return;
    if (list.length === 0) {
      el.innerHTML = `<p class="connections-empty">No connections yet — add one below. Gemini's free tier is the easiest place to start.</p>`;
      return;
    }
    el.innerHTML = list
      .map((c) => {
        const meta = PROVIDER_META[c.provider] || {};
        const isActive = c.id === activeId;
        return `
        <div class="connection-row" data-id="${c.id}">
          <span class="status-dot status-${c.status}" title="${escapeHtml(c.status)}"></span>
          <div class="connection-info">
            <p class="connection-name">${escapeHtml(c.nickname)}</p>
            <p class="connection-meta">${escapeHtml(meta.label || c.provider)} · ${escapeHtml(c.model || "—")}</p>
          </div>
          <label class="connection-active">
            <input type="radio" name="activeConn" value="${c.id}" ${isActive ? "checked" : ""}> active
          </label>
          <button class="btn-ghost btn-sm test-btn" data-id="${c.id}">Test</button>
          <button class="icon-btn btn-sm remove-btn" data-id="${c.id}" aria-label="Remove" title="Remove">✕</button>
        </div>`;
      })
      .join("");
  }

  function wireConnectionsListEvents() {
    const el = document.getElementById("connectionsList");
    el.addEventListener("click", async (e) => {
      const testBtn = e.target.closest(".test-btn");
      const removeBtn = e.target.closest(".remove-btn");
      if (testBtn) {
        const id = testBtn.dataset.id;
        testBtn.textContent = "Testing…";
        testBtn.disabled = true;
        const status = await testConnection(id);
        renderConnectionsList();
        updateGearDot();
        if (status === "error") {
          const row = el.querySelector(`.connection-row[data-id="${id}"]`);
          if (row) {
            const note = document.createElement("p");
            note.className = "error-text connection-error-note";
            note.textContent = "Couldn't connect — check the API key, model name, and (for OpenAI-compatible) the base URL.";
            row.after(note);
            setTimeout(() => note.remove(), 5000);
          }
        }
      } else if (removeBtn) {
        removeConnection(removeBtn.dataset.id);
        renderConnectionsList();
      }
    });
    el.addEventListener("change", (e) => {
      if (e.target.name === "activeConn") {
        setActiveId(e.target.value);
        renderConnectionsList();
      }
    });
  }

  function wireAddForm() {
    const providerType = document.getElementById("newProviderType");
    const baseUrl = document.getElementById("newBaseUrl");
    const apiKey = document.getElementById("newApiKey");
    const model = document.getElementById("newModel");
    const nickname = document.getElementById("newNickname");
    const hint = document.getElementById("newProviderHint");
    const addBtn = document.getElementById("addConnectionBtn");

    function refresh() {
      const meta = PROVIDER_META[providerType.value];
      baseUrl.hidden = !meta.needsBaseUrl;
      model.placeholder = meta.defaultModel ? `model name (default: ${meta.defaultModel})` : "model name";
      hint.textContent = meta.help;
    }
    providerType.addEventListener("change", refresh);
    refresh();

    addBtn.addEventListener("click", () => {
      if (!apiKey.value.trim()) {
        apiKey.focus();
        return;
      }
      addConnection({
        provider: providerType.value,
        nickname: nickname.value,
        apiKey: apiKey.value,
        model: model.value,
        baseUrl: baseUrl.value,
      });
      apiKey.value = "";
      model.value = "";
      nickname.value = "";
      renderConnectionsList();
      updateGearDot();
    });
  }

  function initSettingsUI() {
    const settingsToggle = document.getElementById("settingsToggle");
    const settingsOverlay = document.getElementById("settingsOverlay");
    const closeSettings = document.getElementById("closeSettings");

    settingsToggle.addEventListener("click", () => {
      renderConnectionsList();
      settingsOverlay.hidden = false;
    });
    closeSettings.addEventListener("click", () => (settingsOverlay.hidden = true));
    settingsOverlay.addEventListener("click", (e) => {
      if (e.target === settingsOverlay) settingsOverlay.hidden = true;
    });

    wireConnectionsListEvents();
    wireAddForm();
    updateGearDot();
  }

  document.addEventListener("DOMContentLoaded", initSettingsUI);
  // in case this script runs after DOMContentLoaded already fired
  if (document.readyState !== "loading") initSettingsUI();

  window.NodewayAI = {
    PROVIDER_META,
    getConnections,
    addConnection,
    removeConnection,
    updateConnection,
    getActiveId,
    setActiveId,
    getActiveConnection,
    callActive,
    testConnection,
    call,
    updateGearDot,
  };
})();
