/* Radar Inversor · app web (sin dependencias salvo el gráfico)
   Datos: datos/principal.bin y datos/t/*.bin, cifrados con AES-GCM (clave PBKDF2 de tu contraseña).
   Precios en directo: Finnhub (WebSocket + consulta inicial), solo acciones de EE. UU. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* almacenamiento no disponible */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* nada */ } },
};

const S = { D: null, det: {}, clave: null, vivo: {}, vista: "inicio", ws: null, filtroVig: "todas", listaRadar: "oportunidades", modoRadar: "acciones", listaEtf: "momentum", tabNot: "empresas", grafico: null };

/* ───────────── Formato ───────────── */
const nf = (d) => new Intl.NumberFormat("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d });
const NF = { 0: nf(0), 1: nf(1), 2: nf(2) };
function num(x, d = 2) { return x == null || !isFinite(x) ? "—" : NF[d] ? NF[d].format(x) : nf(d).format(x); }
function precio(x, divisa) {
  if (x == null || !isFinite(x)) return "—";
  const d = Math.abs(x) >= 1000 ? 0 : Math.abs(x) < 10 ? 3 : 2;
  const s = { USD: "$", EUR: "€", GBP: "£", JPY: "¥" }[divisa] || "";
  return divisa === "USD" ? `${s}${num(x, d)}` : `${num(x, d)}${s ? " " + s : ""}`;
}
function pct(x, d = 1, signo = true) { return x == null || !isFinite(x) ? "—" : `${signo && x > 0 ? "+" : ""}${num(x, d)} %`; }
function eur(x) { return x == null || !isFinite(x) ? "—" : `${num(x, 0)} €`; }
function eurS(x) { return x == null || !isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${num(x, 0)} €`; }
function clsVar(x) { return x == null ? "" : x >= 0 ? "sube" : "baja"; }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function hace(iso) {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "ahora";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}
function fechaCorta(iso) { return new Date(iso).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }

/* ───────────── Cifrado ───────────── */
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function derivarClave(password, meta) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64(meta.sal), iterations: meta.iteraciones, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}
async function descifrarUrl(url, clave) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`No se pudo descargar ${url} (${r.status})`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const plano = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, clave, buf.slice(12));
  const flujo = new Blob([plano]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(flujo).text());
}

/* ───────────── Carga ───────────── */
async function cargar(password, recordar) {
  if (window.DEMO) { S.D = window.DEMO.principal; S.det = window.DEMO.detalles || {}; return; }
  const meta = await (await fetch("datos/meta.json", { cache: "no-store" })).json();
  const clave = await derivarClave(password, meta);
  try { S.D = await descifrarUrl("datos/principal.bin", clave); }
  catch (e) { if (e.name === "OperationError") throw new Error("Contraseña incorrecta."); throw e; }
  S.clave = clave; S.det = {};
  if (recordar) LS.set("radar_clave", password);
}
async function detalle(t) {
  if (S.det[t]) return S.det[t];
  const id = S.D.mapa && S.D.mapa[t];
  if (!id || !S.clave) return null;
  S.det[t] = await descifrarUrl(`datos/t/${id}.bin`, S.clave);
  return S.det[t];
}

async function entrar(password, recordar) {
  $("#btn-entrar").disabled = true; $("#error-acceso").textContent = "";
  try {
    await cargar(password, recordar);
    $("#acceso").classList.add("oculto"); $("#app").classList.remove("oculto");
    pintarCabecera(); ir(S.vista, false); conectarVivo();
  } catch (e) {
    $("#error-acceso").textContent = e.message || "No se pudieron abrir los datos.";
    $("#acceso").classList.remove("oculto"); $("#app").classList.add("oculto");
  } finally { $("#btn-entrar").disabled = false; }
}

/* ───────────── Precios en directo ───────────── */
function fichaDe(t) { return (S.D.fichas || {})[t] || (S.D.radar_fichas || {})[t] || null; }
function prevCierre(f) { return f && f.precio != null && f.cambio_dia != null ? f.precio / (1 + f.cambio_dia / 100) : null; }
function precioAhora(t, base) { return S.vivo[t] ? S.vivo[t].p : base; }
function cambioAhora(t) {
  const f = fichaDe(t); if (!f) return null;
  if (!S.vivo[t]) return f.cambio_dia;
  const pc = prevCierre(f); return pc ? (S.vivo[t].p / pc - 1) * 100 : f.cambio_dia;
}
function tickersVivo() {
  const fichas = S.D.fichas || {};
  const cart = Object.values(fichas).filter((f) => f.en_cartera && f.en_directo).map((f) => f.ticker);
  const resto = Object.values(fichas).filter((f) => !f.en_cartera && f.en_directo).map((f) => f.ticker);
  return [...cart, ...resto].slice(0, 50);
}
async function conectarVivo() {
  const key = S.D.meta && S.D.meta.finnhub_key;
  if (!key || window.DEMO) { pintarEstado(); return; }
  const lista = tickersVivo();
  // Foto inicial: último precio de cada acción (respeta el límite gratuito de 60/min)
  (async () => {
    for (const t of lista) {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(t)}&token=${key}`);
        const q = await r.json();
        if (q && q.c > 0 && q.t && q.t * 1000 > new Date(S.D.meta.actualizado).getTime()) { S.vivo[t] = { p: q.c, ts: q.t * 1000 }; refrescarVivo(); }
      } catch { /* sin conexión */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  try {
    if (S.ws) S.ws.close();
    const ws = new WebSocket(`wss://ws.finnhub.io?token=${key}`);
    S.ws = ws;
    ws.onopen = () => { lista.forEach((t) => ws.send(JSON.stringify({ type: "subscribe", symbol: t }))); S.wsAbierto = true; pintarEstado(); };
    ws.onclose = () => { S.wsAbierto = false; pintarEstado(); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type !== "trade" || !m.data) return;
      for (const tr of m.data) { S.vivo[tr.s] = { p: tr.p, ts: tr.t }; S.ultimoTick = Date.now(); }
      programarRefresco();
    };
  } catch { /* WebSocket no disponible */ }
}
let refrescoPend = null;
function programarRefresco() { if (!refrescoPend) refrescoPend = setTimeout(() => { refrescoPend = null; refrescarVivo(); }, 1500); }
function refrescarVivo() {
  for (const el of $$("[data-p]")) { const t = el.dataset.p, f = fichaDe(t); if (f && S.vivo[t]) el.textContent = precio(S.vivo[t].p, f.divisa); }
  for (const el of $$("[data-v]")) { const c = cambioAhora(el.dataset.v); if (c != null) { el.textContent = pct(c, 2); el.className = el.className.replace(/\b(sube|baja)\b/g, "") + " " + clsVar(c); } }
  for (const el of $$("[data-pnl]")) { const r = posVivo(el.dataset.pnl); if (r) { el.textContent = pct(r.pnl_pct); el.className = el.className.replace(/\b(sube|baja)\b/g, "") + " " + clsVar(r.pnl_pct); } }
  const tot = totalesVivo();
  for (const el of $$("[data-tot]")) {
    const k = el.dataset.tot;
    if (k === "valor") el.textContent = eur(tot.valor_eur);
    if (k === "dia") { el.textContent = `${eurS(tot.dia_eur)} (${pct(tot.dia_pct, 2)}) hoy`; el.className = "delta " + clsVar(tot.dia_eur); }
    if (k === "pnl") { el.textContent = `${eurS(tot.pnl_eur)} · ${pct(tot.pnl_pct)}`; el.className = clsVar(tot.pnl_eur); }
  }
  pintarEstado();
}
function posVivo(t) {
  const p = (S.D.cartera.posiciones || []).find((x) => x.ticker === t);
  if (!p) return null;
  const pr = precioAhora(t, p.precio);
  return { ...p, precio: pr, pnl_pct: p.coste_medio ? (pr / p.coste_medio - 1) * 100 : p.pnl_pct, valor: pr * p.acciones };
}
function totalesVivo() {
  const r = S.D.cartera.resumen, fx = r.eurusd || 1;
  let valor = 0, inv = 0, dia = 0;
  for (const p of S.D.cartera.posiciones || []) {
    const pr = precioAhora(p.ticker, p.precio), conv = p.divisa === "USD" ? 1 / fx : 1;
    const v = pr * p.acciones * conv; valor += v; inv += (p.invertido || 0) * conv;
    const f = fichaDe(p.ticker), pc = prevCierre(f);
    if (pc) dia += (pr - pc) * p.acciones * conv;
  }
  return { valor_eur: valor, pnl_eur: valor - inv, pnl_pct: inv ? (valor / inv - 1) * 100 : null, dia_eur: dia, dia_pct: valor - dia ? dia / (valor - dia) * 100 : null };
}

/* ───────────── Cabecera ───────────── */
function pintarCabecera() { pintarEstado(); }
function pintarEstado() {
  if (!S.D) return;
  const vivo = S.wsAbierto && S.ultimoTick && Date.now() - S.ultimoTick < 120000;
  $("#estado-datos").innerHTML = `<span class="punto-vivo ${vivo ? "on" : ""}"></span>${vivo ? "En directo" : "Análisis"}<br>${hace(S.D.meta.actualizado)}`;
}

/* ───────────── Navegación ───────────── */
const TITULOS = { inicio: "Hoy", cartera: "Cartera", vigilancia: "Vigilancia", radar: "Radar", noticias: "Noticias" };
function ir(vista, scroll = true) {
  S.vista = vista;
  $$(".pestanas button").forEach((b) => { if (b.dataset.vista !== vista) b.removeAttribute("aria-current"); else b.setAttribute("aria-current", "page"); });
  $("#titulo-vista").textContent = TITULOS[vista];
  const html = { inicio: vistaInicio, cartera: vistaCartera, vigilancia: vistaVigilancia, radar: vistaRadar, noticias: vistaNoticias }[vista]();
  $("#vista").innerHTML = (S.D.meta.demo ? `<div class="aviso-demo"><b>Modo demostración:</b> precios, noticias y señales SIMULADOS para enseñarte la app. Tus posiciones son reales; las cotizaciones no.</div>` : "") + html;
  if (scroll) window.scrollTo(0, 0);
  LS.set("radar_vista", vista);
  const n = (S.D.avisos || []).filter((a) => a.fecha && Date.now() - new Date(a.fecha).getTime() < 86400000).length;
  const btn = $('.pestanas [data-vista="inicio"]');
  const g = btn.querySelector(".globo");
  if (g) g.remove();
  if (n) btn.insertAdjacentHTML("beforeend", `<span class="globo">${n}</span>`);
}

/* ───────────── Componentes ───────────── */
function sello(a) { return a ? `<span class="sello c-${a.color}">${esc(a.titulo)}</span>` : ""; }
function pos(v, min, max) { return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100)); }

// Regla stop · zona · precio · objetivo (para comprar)
function reglaNiveles(n, t, divisa) {
  if (!n || n.zona_inf == null) return "";
  const pr = precioAhora(t, n.precio);
  const vals = [n.stop, n.zona_inf, n.zona_sup, pr, n.objetivo].filter((x) => x != null);
  let min = Math.min(...vals), max = Math.max(...vals); const pad = (max - min) * 0.06; min -= pad; max += pad;
  const zi = pos(n.zona_inf, min, max), zs = pos(n.zona_sup, min, max);
  return `<div class="regla" role="img" aria-label="Stop ${num(n.stop)}, zona de compra ${num(n.zona_inf)} a ${num(n.zona_sup)}, precio ${num(pr)}, objetivo ${num(n.objetivo)}">
    <div class="pista"></div>
    <div class="marca-stop" style="left:${pos(n.stop, min, max)}%"></div>
    <div class="zona" style="left:${zi}%;width:${Math.max(1.5, zs - zi)}%"></div>
    <div class="marca-obj" style="left:${pos(n.objetivo, min, max)}%"></div>
    <div class="bola" style="left:${pos(pr, min, max)}%"></div>
    <span class="eti izq" style="left:${pos(n.stop, min, max)}%">Stop ${precio(n.stop, divisa)}</span>
    <span class="eti dch" style="left:${pos(n.objetivo, min, max)}%">Objetivo ${precio(n.objetivo, divisa)}</span>
  </div>`;
}

// Regla de tu metodología: −15 · −8 · coste · +20 · +30 · +40 y dónde está el precio
function reglaTramos(p, divisa) {
  const cm = p.coste_medio; if (!cm) return "";
  const pr = precioAhora(p.ticker, p.precio);
  const nt = p.niveles_tramos || {};
  const marcas = Object.entries(nt).map(([k, v]) => ({ k, v }));
  const vals = [cm, pr, ...marcas.map((m) => m.v)];
  if (p.niveles && p.niveles.trailing) vals.push(p.niveles.trailing);
  let min = Math.min(...vals), max = Math.max(...vals); const pad = (max - min) * 0.05; min -= pad; max += pad;
  const xc = pos(cm, min, max), xp = pos(pr, min, max), ganando = pr >= cm;
  const tr = p.niveles && p.niveles.trailing;
  return `<div class="regla tramos" role="img" aria-label="Coste medio ${num(cm)}, precio ${num(pr)}">
    <div class="pista"></div>
    <div class="relleno" style="left:${Math.min(xc, xp)}%;width:${Math.abs(xp - xc)}%;background:${ganando ? "var(--verde)" : "var(--rojo)"}"></div>
    ${marcas.map((m) => `<div class="marca-tramo ${m.k.startsWith("-") ? (parseFloat(m.k) <= -15 ? "grave" : "neg") : ""}" style="left:${pos(m.v, min, max)}%"></div><span class="eti-sup" style="left:${pos(m.v, min, max)}%">${m.k.replace("-", "−")}</span>`).join("")}
    ${tr ? `<div class="marca-trail" style="left:${pos(tr, min, max)}%" title="Stop dinámico"></div>` : ""}
    <div class="marca-coste" style="left:${xc}%"></div>
    <div class="bola" style="left:${xp}%"></div>
    <span class="eti ${xc < 20 ? "izq" : xc > 80 ? "dch" : ""}" style="left:${xc}%">Coste ${precio(cm, divisa)}</span>
  </div>`;
}

function spark(serie, color) {
  if (!serie || serie.length < 2) return "";
  const min = Math.min(...serie), max = Math.max(...serie), w = 120, h = 26;
  const pts = serie.map((v, i) => `${(i / (serie.length - 1)) * w},${h - ((v - min) / (max - min || 1)) * (h - 4) - 2}`).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

function filaFicha(f, extra = "") {
  const a = f.accion;
  return `<button class="fila" data-abrir="${esc(f.ticker)}">
    <div class="fila-sup"><span class="tk">${esc(f.ticker)}</span><span class="nom">${esc(f.nombre || "")}</span>
      <span class="der"><span class="precio" data-p="${esc(f.ticker)}">${precio(precioAhora(f.ticker, f.precio), f.divisa)}</span><br>
      <span class="var ${clsVar(cambioAhora(f.ticker))}" data-v="${esc(f.ticker)}">${pct(cambioAhora(f.ticker), 2)}</span></span></div>
    ${retsFila(f.ticker, f.ind)}
    <div class="fila-sup" style="margin-top:8px">${sello(a)}<span class="nom" style="color:var(--tinta)">${esc(a.frase)}</span></div>
    ${f.en_cartera && f.posicion ? reglaTramos({ ...f.posicion, ticker: f.ticker, precio: f.precio, niveles: f.niveles }, f.divisa) : reglaNiveles(f.niveles, f.ticker, f.divisa)}
    <div class="chips">${semaforoTag(f.semaforo)}${f.en_cartera ? chipUmbral(f.posicion) : ""}${chipRes(f)}</div>
    ${extra}
  </button>`;
}

/* ───────────── Semáforo, resultados y umbrales ───────────── */
function diasHasta(fecha) { if (!fecha) return null; const h = new Date(); h.setHours(0, 0, 0, 0); return Math.round((new Date(fecha + "T00:00:00") - h) / 86400000); }
function cuandoTxt(d) { return d === 0 ? "hoy" : d === 1 ? "mañana" : d > 1 ? `en ${d} días` : ""; }
const MOMENTO = { antes: "antes de la apertura", despues: "tras el cierre" };
const COLOR_TXT = { verde: "Sigue subiendo", ambar: "Pierde fuerza", rojo: "Giro bajista confirmado" };
function semaforoTag(sem) {
  if (!sem || !sem.color) return "";
  const txt = sem.pendiente ? "Posible giro, sin confirmar" : COLOR_TXT[sem.color];
  return `<span class="semaforo c-${sem.color}${sem.pendiente ? " pendiente" : ""}"><i></i>${txt}${sem.etapa ? ` · etapa ${sem.etapa}` : ""}</span>`;
}
function chipRes(f) {
  const px = f && f.resultados && f.resultados.proxima; if (!px) return "";
  const d = diasHasta(px.fecha); if (d == null || d < 0 || d > 14) return "";
  return `<span class="chip res">Resultados ${cuandoTxt(d)}</span>`;
}
function chipUmbral(pos) {
  const u = pos && pos.proximo_umbral; if (!u || u.puntos > 5) return "";
  return `<span class="chip ${u.tipo === "ganancia" ? "aviso" : "neg"}">A ${num(u.puntos, u.puntos < 1 ? 2 : 1)} puntos de ${u.nivel.replace("-", "−")} %</span>`;
}
// Rentabilidad por periodos + fuerza frente al S&P 500
function retsFila(t, ind) {
  if (!ind) return "";
  const c = (x, d = 1) => `<b class="${clsVar(x)}">${pct(x, d)}</b>`;
  return `<div class="rets"><span>Día <b class="${clsVar(cambioAhora(t))}" data-v="${esc(t)}">${pct(cambioAhora(t), 1)}</b></span><span>Semana ${c(ind.ret_1s)}</span>
    <span>Mes ${c(ind.ret_1m)}</span><span>Trimestre ${c(ind.ret_3m)}</span>${ind.rs_3m != null ? `<span>vs S&P ${c(ind.rs_3m, 0)}</span>` : ""}</div>`;
}
function barraRiesgo(r, color) { return `<span class="riesgo c-${color}" aria-hidden="true"><span style="width:${Math.max(3, r)}%"></span></span>`; }

/* ───────────── Vista: Hoy ───────────── */
const ICONOS = { globo: "i-globo", cartera: "i-cartera-s", alerta: "i-alerta", ok: "i-ok", diana: "i-diana", radar: "i-diana", amplitud: "i-amplitud", calendario: "i-calendario" };
function vistaInicio() {
  const D = S.D, tot = totalesVivo(), r = D.cartera.resumen;
  const urg = (D.cartera.posiciones || []).filter((p) => p.accion && ["VENDER", "EJECUTAR", "REDUCIR", "RECORTAR", "REVISAR", "PROTEGER", "AMPLIAR"].includes(p.accion.codigo));
  const opor = Object.values(D.fichas || {}).filter((f) => !f.en_cartera && ["COMPRAR", "ACUMULAR", "GIRO", "TRAMOS"].includes(f.accion.codigo));
  const avisos = (D.avisos || []).slice(0, 8);
  return `
  <div class="resumen-cartera">
    <span class="valor" data-tot="valor">${eur(tot.valor_eur)}</span>
    <span class="delta ${clsVar(tot.dia_eur)}" data-tot="dia">${eurS(tot.dia_eur)} (${pct(tot.dia_pct, 2)}) hoy</span>
    <span class="sub">Total <span data-tot="pnl" class="${clsVar(tot.pnl_eur)}">${eurS(tot.pnl_eur)} · ${pct(tot.pnl_pct)}</span> · realizado ${eurS(r.realizado_eur)}</span>
  </div>

  <section class="seccion"><h2>En 30 segundos</h2>
    <ul class="puntos grupo">${(D.resumen || []).map((p) => `<li><span class="ic c-${p.color}"><svg><use href="#${ICONOS[p.icono] || "i-diana"}"/></svg></span><div>${esc(p.texto)}${p.detalle ? `<small>${esc(p.detalle)}</small>` : ""}</div></li>`).join("")}</ul>
  </section>

  ${agenda(7)}

  ${urg.length ? `<section class="seccion"><h2>Toca decidir <small>en tu cartera</small></h2><div class="grupo">${urg.map((p) => filaFicha(fichaDe(p.ticker) || p)).join("")}</div></section>` : ""}

  ${opor.length ? `<section class="seccion"><h2>Oportunidades <small>en tu vigilancia</small></h2><div class="grupo">${opor.map((f) => filaFicha(f)).join("")}</div></section>` : ""}

  <section class="seccion"><h2>Mercados del mundo</h2>
    <div class="mundo">${(D.mercado || []).map((m) => `<div class="indice"><div class="n">${esc(m.nombre)}</div><div class="p">${num(m.precio, m.precio > 100 ? 0 : 2)}</div>
      <div class="var ${clsVar(m.cambio_dia)}">${pct(m.cambio_dia, 2)}</div>${spark(m.spark, m.cambio_dia >= 0 ? "var(--verde)" : "var(--rojo)")}</div>`).join("")}</div>
  </section>

  <section class="seccion"><h2>Últimos avisos <small>también te llegan por Telegram</small></h2>
    <div class="grupo">${avisos.length ? avisos.map((a) => `<button class="fila" ${a.ticker ? `data-abrir="${esc(a.ticker)}"` : ""}>
      <div class="fila-sup"><span class="sello c-${a.color}" style="padding:2px 8px">${a.prioridad === "alta" ? "Importante" : "Aviso"}</span><span class="nom">${hace(a.fecha)}</span></div>
      <div style="font-weight:600;margin-top:6px">${esc(a.titulo)}</div><div class="frase">${esc(a.texto)}</div></button>`).join("")
      : `<div class="vacio">Sin avisos en los últimos días. Cuando una acción entre en zona de compra, cruce un tramo o haga un movimiento anómalo, aparecerá aquí.</div>`}</div>
  </section>
  ${pie()}`;
}

function agendaSimple(maxDias) {
  const items = [];
  for (const m of S.D.macro || []) {
    const d = diasHasta(m.fecha); if (d == null || d < 0 || d > maxDias) continue;
    items.push({ fecha: m.fecha, d, titulo: `${m.nombre} decide tipos`, sub: `${m.hora} (hora de España) · volatilidad en todo el mercado`, tag: "" });
  }
  for (const c of S.D.calendario || []) {
    const d = diasHasta(c.fecha); if (d == null || d < 0 || d > maxDias) continue;
    const f = fichaDe(c.ticker);
    items.push({ fecha: c.fecha, d, ticker: c.ticker, titulo: `${c.ticker} presenta resultados`,
      sub: [MOMENTO[c.momento] || "hora sin confirmar", c.mov_tipico != null ? `movimiento típico ±${num(c.mov_tipico, 1)} %` : ""].filter(Boolean).join(" · "),
      tag: (c.en_cartera ? `<span class="chip pos">En cartera</span>` : "") + (f && c.en_cartera ? semaforoTag(f.semaforo) : "") });
  }
  if (!items.length) return "";
  items.sort((a, b) => a.fecha.localeCompare(b.fecha) || (b.tag ? 1 : 0) - (a.tag ? 1 : 0));
  return `<section class="seccion"><h2>Esta semana <small>resultados y bancos centrales</small></h2><div class="grupo">${items.map((it) => {
    const dt = new Date(it.fecha + "T12:00:00");
    return `<${it.ticker ? `button class="cal fila-cal" data-abrir="${esc(it.ticker)}"` : `div class="cal"`}><div class="dia"><b>${dt.getDate()}</b><small>${dt.toLocaleDateString("es-ES", { month: "short" })}</small></div>
      <div><b>${esc(it.titulo)}</b> <small style="color:var(--tenue)">${cuandoTxt(it.d)}</small><br><small style="color:var(--tenue)">${esc(it.sub)}</small>${it.tag ? `<div class="chips" style="margin-top:4px">${it.tag}</div>` : ""}</div>
      <span class="nom" style="flex:none">${dt.toLocaleDateString("es-ES", { weekday: "short" })}</span></${it.ticker ? "button" : "div"}>`;
  }).join("")}</div></section>`;
}


// Agenda semanal: datos macro, bancos centrales y resultados (tus empresas + las más relevantes del índice)
function agenda(maxDias, conPasado = false, titulo = "Esta semana") {
  const A = S.D.agenda;
  if (!A || !A.length) return agendaSimple(maxDias);
  const dias = A.filter((d) => { const x = diasHasta(d.fecha); return x != null && x <= maxDias && (conPasado ? x >= -7 : x >= 0); });
  if (!dias.length) return "";
  const fmtUlt = (u) => u ? ` · último: ${num(u.valor, Math.abs(u.valor) >= 100 ? 0 : 1)}${u.unidad === "%" ? " %" : " " + esc(u.unidad)} (antes ${num(u.previo, Math.abs(u.previo) >= 100 ? 0 : 1)})` : "";
  return `<section class="seccion"><h2>${titulo} <small>hora de España</small></h2><div class="grupo">${dias.map((d) => {
    const x = diasHasta(d.fecha), dt = new Date(d.fecha + "T12:00:00");
    const propios = d.resultados.filter((r) => r.seguida), otros = d.resultados.filter((r) => !r.seguida);
    const filaRes = (r) => {
      const f = fichaDe(r.ticker);
      const hecho = r.bpa_real != null;
      return `<button class="res-fila" data-abrir="${esc(r.ticker)}"><div><b>${esc(r.ticker)}</b> <span class="m">${esc((r.nombre || "").slice(0, 26))} · ${MOMENTO[r.momento] || "hora sin confirmar"}</span>
        <div class="chips" style="margin-top:3px">${r.en_cartera ? `<span class="chip pos">En cartera</span>` : `<span class="chip">Vigilancia</span>`}${f && r.en_cartera ? semaforoTag(f.semaforo) : ""}</div></div>
        <div class="r">${hecho ? `BPA ${num(r.bpa_real, 2)} <span class="${clsVar(r.sorpresa)}">${r.sorpresa != null ? pct(r.sorpresa, 0) : ""}</span><br><span class="m">esperado ${num(r.bpa_est, 2)}</span>` : r.bpa_est != null ? `BPA esperado<br><b>${num(r.bpa_est, 2)}</b>` : ""}</div></button>`;
    };
    return `<div class="agenda-dia${x === 0 ? " hoy" : ""}"><h3>${dt.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "short" })}<small>${d.macro.length ? `${d.macro.length} macro · ` : ""}${d.resultados.length + (d.mas || 0)} resultados</small></h3>
      ${d.macro.map((m) => `<div class="evento"><span class="h">${esc(m.hora)}</span><div><b>${esc(m.nombre)}</b>${m.importancia === "alta" ? `<span class="imp">Alto impacto</span>` : ""}<small>${esc(m.periodo || "")}${fmtUlt(m.ultimo)}</small></div></div>`).join("")}
      ${propios.map(filaRes).join("")}
      ${otros.length ? `<div class="res-otros">${otros.map((r) => `<span title="${esc(r.nombre || "")}"><b>${esc(r.ticker)}</b> ${r.momento === "antes" ? "antes" : r.momento === "despues" ? "tras cierre" : ""}${r.bpa_real != null && r.sorpresa != null ? ` <b class="${clsVar(r.sorpresa)}">${pct(r.sorpresa, 0)}</b>` : r.bpa_est != null ? ` · ${num(r.bpa_est, 2)}` : ""}</span>`).join("")}${d.mas ? `<span>y ${d.mas} más</span>` : ""}</div>` : ""}
    </div>`;
  }).join("")}</div>
  <p class="explica">Resultados: tus empresas y las más negociadas del S&P 500 y Nasdaq 100. Entre paréntesis, la sorpresa del BPA frente a lo esperado cuando ya han presentado. Los datos macro muestran el último valor publicado; el consenso esperado no está disponible gratis.</p></section>`;
}

/* ───────────── Vista: Cartera ───────────── */
const PALETA = ["#2B6CB0", "#1B8A5A", "#A87407", "#7A4FB5", "#C2531B", "#0F6E8C", "#B23A70", "#5B6B82", "#3E8E3E", "#8C6D1F", "#4A5DB0", "#9B4D2E"];
function vistaCartera() {
  const D = S.D, r = D.cartera.resumen, tot = totalesVivo();
  const ps = D.cartera.posiciones || [];
  const real = D.cartera.realizadas || [];
  return `
  <div class="seccion" style="margin-top:12px"><div class="grupo"><div class="cifras">
    <div><small>Valor</small><b data-tot="valor">${eur(tot.valor_eur)}</b></div>
    <div><small>Rentabilidad total</small><b data-tot="pnl" class="${clsVar(tot.pnl_eur)}">${eurS(tot.pnl_eur)} · ${pct(tot.pnl_pct)}</b></div>
    <div><small>Hoy</small><b class="${clsVar(tot.dia_eur)}">${eurS(tot.dia_eur)}</b></div>
    <div><small>Beneficio realizado</small><b class="${clsVar(r.realizado_eur)}">${eurS(r.realizado_eur)}</b></div>
  </div></div>
  <div class="reparto" aria-hidden="true">${ps.map((p, i) => `<span style="width:${p.peso || 0}%;background:${PALETA[i % PALETA.length]}"></span>`).join("")}</div>
  <div class="leyenda">${ps.map((p, i) => `<span><i style="background:${PALETA[i % PALETA.length]}"></i>${esc(p.ticker)} ${num(p.peso, 0)} %</span>`).join("")}</div>
  <p class="explica">${esc(r.nota_divisa || "")} EUR/USD ${num(r.eurusd, 4)}.</p></div>

  <section class="seccion"><h2>¿Siguen subiendo? <small>riesgo de giro de 0 a 100</small></h2><div class="grupo">
  ${[...ps].sort((a, b) => ((b.semaforo || {}).riesgo || 0) - ((a.semaforo || {}).riesgo || 0)).map((p) => {
    const sm = p.semaforo || {};
    const nivel = sm.color === "rojo" ? `Señales: ${(sm.senales || []).slice(0, 2).map((x) => x.nombre.toLowerCase()).join(", ")}`
      : sm.nivel_rojo ? `Venta si cierra bajo ${precio(sm.nivel_rojo, p.divisa)} (${esc(sm.motivo_rojo || "")})` : "";
    return `<button class="fila" data-abrir="${esc(p.ticker)}"><div class="fila-sup"><span class="tk" style="min-width:58px">${esc(p.ticker)}</span>${semaforoTag(sm)}
      <span class="der" style="display:flex;align-items:center;gap:8px">${barraRiesgo(sm.riesgo || 0, sm.color || "gris")}<b style="min-width:22px">${sm.riesgo ?? "—"}</b></span></div>
      ${nivel ? `<div class="detalle-pos" style="margin-top:4px">${nivel}</div>` : ""}</button>`;
  }).join("")}</div>
  <p class="explica">Verde: la tendencia sigue sana. Ámbar: señales tempranas de giro, momento de proteger (con borde rojo, posible giro pendiente de confirmar). Rojo: giro bajista confirmado en dos cierres seguidos. Para salir del rojo el riesgo debe bajar de 45, no de 55, para evitar cambios de color diarios. En largo plazo, el rojo pide revisar la tesis; solo es señal de venta si también se confirma en gráfico semanal. Etapas de Weinstein: 1 suelo, 2 alcista, 3 techo, 4 bajista.</p></section>

  <section class="seccion"><h2>Posiciones <small>regla: −15 · −8 · coste · +20 · +30 · +40</small></h2><div class="grupo">
  ${ps.map((p) => {
    const vv = posVivo(p.ticker), f = fichaDe(p.ticker);
    return `<button class="fila" data-abrir="${esc(p.ticker)}">
      <div class="fila-sup"><span class="tk">${esc(p.ticker)}</span><span class="nom">${esc(p.nombre || "")}</span>
        <span class="der"><span class="pnl-grande ${clsVar(vv.pnl_pct)}" data-pnl="${esc(p.ticker)}">${pct(vv.pnl_pct)}</span></span></div>
      <div class="detalle-pos">${num(p.acciones, p.acciones % 1 ? 3 : 0)} acc. · coste ${precio(p.coste_medio, p.divisa)} · ahora <span data-p="${esc(p.ticker)}">${precio(vv.precio, p.divisa)}</span>
        · ${esc(p.broker || "")}${p.coste_implicito ? " · coste aproximado" : ""}</div>
      ${retsFila(p.ticker, (f || {}).ind)}
      ${reglaTramos({ ...p, niveles: p.niveles }, p.divisa)}
      <div class="chips">${semaforoTag(p.semaforo)}${chipUmbral(p)}${chipRes(p)}${(p.tramos_cumplidos || []).length ? `<span class="chip">Tramo +${Math.max(...p.tramos_cumplidos)} % ya ejecutado</span>` : ""}</div>
      <div class="fila-sup" style="margin-top:6px">${sello(p.accion)}<span class="nom" style="color:var(--tinta)">${esc(p.accion ? p.accion.frase : "")}</span></div>
    </button>`;
  }).join("")}</div></section>

  ${real.length ? `<section class="seccion"><h2>Ventas realizadas</h2><div class="grupo">${real.map((v) => `<div class="fila"><div class="fila-sup"><span class="tk">${esc(v.ticker)}</span>
    <span class="nom">${esc(v.fecha)} · ${num(v.acciones, 0)} acc. a ${num(v.precio)}</span><span class="der ${clsVar(v.ganancia)}"><b>${pct(v.ganancia_pct)}</b><br><small>${num(v.ganancia, 0)} $</small></span></div></div>`).join("")}</div></section>` : ""}
  ${pie()}`;
}

/* ───────────── Vista: Vigilancia ───────────── */
const ORDEN = { COMPRAR: 0, GIRO: 1, TRAMOS: 1, ACUMULAR: 2, AMPLIAR: 3, VIGILAR: 4, NEUTRAL: 5, MANTENER: 6, PROTEGER: 7, REDUCIR: 8, RECORTAR: 8, REVISAR: 9, VENDER: 10, EJECUTAR: 11, EVITAR: 12 };
function vistaVigilancia() {
  const todas = Object.values(S.D.fichas || {}).filter((f) => !f.en_cartera);
  const filtros = { todas: "Todas", comprar: "Comprar o giro", esperar: "Esperar", evitar: "Evitar" };
  const sel = todas.filter((f) => {
    const c = f.accion.codigo;
    if (S.filtroVig === "comprar") return ["COMPRAR", "ACUMULAR", "GIRO", "TRAMOS"].includes(c);
    if (S.filtroVig === "esperar") return ["VIGILAR", "NEUTRAL"].includes(c);
    if (S.filtroVig === "evitar") return c === "EVITAR";
    return true;
  }).sort((a, b) => (ORDEN[a.accion.codigo] - ORDEN[b.accion.codigo]) || (b.puntuacion - a.puntuacion));
  return `
  <div class="filtros" role="group" aria-label="Filtrar">${Object.entries(filtros).map(([k, v]) => `<button data-filtro-vig="${k}" aria-pressed="${S.filtroVig === k}">${v} (${k === "todas" ? todas.length : todas.filter((f) => ({ comprar: ["COMPRAR", "ACUMULAR", "GIRO", "TRAMOS"], esperar: ["VIGILAR", "NEUTRAL"], evitar: ["EVITAR"] }[k] || []).includes(f.accion.codigo)).length})</button>`).join("")}</div>
  <p class="explica">Añade o quita acciones desde Telegram: <b>/vigilar AMD</b> · <b>/quitar AMD</b>.</p>
  <div class="seccion" style="margin-top:10px"><div class="grupo">${sel.length ? sel.map((f) => filaFicha(f, `<div class="chips">${f.senales.filter((s) => s.tipo !== "info").slice(0, 3).map((s) => `<span class="chip ${s.tipo}">${esc(s.nombre)}</span>`).join("")}
    ${f.bt ? `<span class="chip">${esc(f.bt.fiabilidad)} · ${num(f.bt.acierto, 0)} % de ${f.bt.n}</span>` : ""}${f.nota ? `<span class="chip">${esc(f.nota)}</span>` : ""}</div>`)).join("") : `<div class="vacio">Nada en este filtro.</div>`}</div></div>
  ${pie()}`;
}

/* ───────────── Vista: Radar ───────────── */
const LISTAS = {
  oportunidades: ["Mejores oportunidades", "Acciones del S&P 500, Nasdaq 100, Euro Stoxx 50 e IBEX 35 con configuración de compra o de giro, ordenadas por puntuación."],
  giros: ["Giros alcistas", "Posibles cambios de tendencia: superan su media de 30 semanas, recuperan la EMA50 o muestran divergencia alcista, con volumen que lo confirma."],
  momentum: ["Momentum", "Las más fuertes a 12 meses (sin contar el último) en etapa 2: el momentum tiende a persistir mientras la tendencia aguante."],
  acumulando: ["Acumulando volumen", "Entra más dinero en días de subida que sale en días de bajada: posible compra de grandes inversores."],
  rupturas: ["Rupturas con volumen", "Superan su máximo de 55 sesiones con volumen al menos 1,5 veces el normal."],
  ema200_retroceso: ["EMA200 estable + retroceso", "Tendencia de fondo sólida y el precio ha retrocedido a su media de 50 o 200: compras clásicas de bajo riesgo."],
  volumen_inusual: ["Volumen inusual hoy", "Volumen más de 2,5 veces superior a su media. Algo está pasando: mira la noticia antes de actuar."],
  sobreventa: ["Sobreventa en tendencia alcista", "RSI muy bajo sin perder la tendencia de fondo: caídas exageradas que suelen rebotar."],
  subidas: ["Mayores subidas hoy", ""],
  bajadas: ["Mayores caídas hoy", ""],
};
const LISTAS_ETF = {
  momentum: ["Más momentum", "ETFs que puedes comprar (UCITS, en euros) en etapa 2, ordenados por fuerza a 3, 6 y 12 meses."],
  giros: ["Giros alcistas", "ETFs que empiezan a girar al alza tras caer o lateralizar: entradas tempranas y pequeñas, con stop."],
  rotacion: ["Rotación de sectores", "Termómetro con los ETFs de EE. UU. por sector y tema. Desde España no se pueden comprar (normativa PRIIPs): usa su equivalente UCITS."],
  todos: ["Todos por tema", "Todos los ETFs UCITS de la lista, agrupados por tema."],
};
function filaEtf(r) {
  const corto = r.ticker.replace(".DE", "");
  return `<button class="fila" data-radar="${esc(r.ticker)}">
    <div class="fila-sup"><span class="tk">${esc(corto)}</span><span class="nom">${esc(r.nombre)}</span>
    <span class="der"><span class="precio">${precio(r.precio, r.divisa)}</span><br><span class="var ${clsVar(r.cambio_dia)}">${pct(r.cambio_dia, 2)}</span></span></div>
    <div class="fila-sup" style="margin-top:8px"><span class="sello c-${r.color}">${esc(r.accion)}</span><span class="nom">${esc(r.tema)} · momentum ${num(r.momentum, 0)}/100</span></div>
    <div class="rets"><span>1 mes <b class="${clsVar(r.ret_1m)}">${pct(r.ret_1m, 1)}</b></span><span>3 meses <b class="${clsVar(r.ret_3m)}">${pct(r.ret_3m, 1)}</b></span><span>6 meses <b class="${clsVar(r.ret_6m)}">${pct(r.ret_6m, 1)}</b></span><span>12-1 <b class="${clsVar(r.mom_12_1)}">${pct(r.mom_12_1, 0)}</b></span></div>
    <div class="chips">${semaforoTag({ color: r.semaforo, etapa: r.etapa })}${r.tipo_etf === "eeuu" ? `<span class="chip ${r.equivalente ? "pos" : ""}">${r.equivalente ? `Cómpralo como ${esc(r.equivalente.replace(".DE", ""))}` : "Sin equivalente UCITS en tu lista"}</span>` : ""}${(r.senales || []).slice(0, 2).map((x) => `<span class="chip pos">${esc(x)}</span>`).join("")}</div>
  </button>`;
}
function vistaEtfs() {
  const E = S.D.etfs || {};
  const lista = E[S.listaEtf] || [];
  return `
  <div class="filtros" role="group" aria-label="Listas de ETFs">${Object.entries(LISTAS_ETF).map(([k, v]) => `<button data-lista-etf="${k}" aria-pressed="${S.listaEtf === k}">${v[0]}</button>`).join("")}</div>
  <p class="explica">${esc(LISTAS_ETF[S.listaEtf][1])}</p>
  <div class="seccion" style="margin-top:10px"><div class="grupo">${lista.length ? lista.map(filaEtf).join("") : `<div class="vacio">Hoy no hay ETFs en esta lista.</div>`}</div></div>
  <p class="explica">Añade cualquier ETF a tu vigilancia con <b>/vigilar SEC0.DE</b>, o edita la lista en config/universos/etfs.csv.</p>
  ${pie()}`;
}
function vistaRadar() {
  const conmutador = `<div class="segmentos" role="group" aria-label="Tipo de activo"><button data-modo-radar="acciones" aria-pressed="${S.modoRadar === "acciones"}">Acciones</button><button data-modo-radar="etfs" aria-pressed="${S.modoRadar === "etfs"}">ETFs</button></div>`;
  if (S.modoRadar === "etfs") return conmutador + vistaEtfs();
  return conmutador + vistaRadarAcciones();
}
function vistaRadarAcciones() {
  const R = S.D.radar || {};
  const lista = S.listaRadar === "oportunidades" ? (R.oportunidades || []) : ((R.listas || {})[S.listaRadar] || []);
  const amp = R.amplitud;
  const cAmp = amp == null ? "gris" : amp >= 60 ? "verde" : amp >= 40 ? "ambar" : "rojo";
  return `
  <div class="seccion" style="margin-top:12px"><div class="grupo"><div class="medidor c-${cAmp}">
    <div><b>${amp == null ? "—" : num(amp, 0) + " %"}</b><br><small style="color:var(--tenue)">sobre su EMA200</small></div>
    <div class="barra"><span style="width:${amp || 0}%"></span></div></div></div>
    <p class="explica">Amplitud del mercado: qué parte de las ${num(R.n || 0, 0)} acciones escaneadas está en tendencia alcista. Por encima del 60 % la subida es generalizada; por debajo del 40 %, hay debilidad.</p></div>
  <div class="filtros" role="group" aria-label="Listas del radar">${Object.entries(LISTAS).map(([k, v]) => `<button data-lista="${k}" aria-pressed="${S.listaRadar === k}">${v[0]}</button>`).join("")}</div>
  <p class="explica">${esc(LISTAS[S.listaRadar][1])}</p>
  <div class="seccion" style="margin-top:10px"><div class="grupo">${lista.length ? lista.map((r) => `<button class="fila" data-radar="${esc(r.ticker)}">
      <div class="fila-sup"><span class="tk">${esc(r.ticker)}</span><span class="nom">${esc(r.nombre)}</span>
      <span class="der"><span class="precio">${precio(r.precio, r.divisa)}</span><br><span class="var ${clsVar(r.cambio_dia)}">${pct(r.cambio_dia, 2)}</span></span></div>
      <div class="fila-sup" style="margin-top:8px"><span class="sello c-${r.color}">${esc(r.accion)}</span><span class="nom">Puntuación ${r.puntuacion}${r.rr ? ` · ratio ${num(r.rr, 1)}:1` : ""}${r.seguida ? " · en tu lista" : ""}</span></div>
      ${r.zona_inf ? reglaNiveles({ precio: r.precio, zona_inf: r.zona_inf, zona_sup: r.zona_sup, stop: r.stop, objetivo: r.objetivo }, "", r.divisa) : ""}
      <div class="chips">${(r.senales || []).map((s) => `<span class="chip pos">${esc(s)}</span>`).join("")}${r.bt ? `<span class="chip">${esc(r.bt.fiabilidad)} · ${num(r.bt.acierto, 0)} % de ${r.bt.n}</span>` : ""}${r.fund_puntuacion != null ? `<span class="chip">Calidad ${r.fund_puntuacion}/100</span>` : ""}</div>
    </button>`).join("") : `<div class="vacio">Hoy no hay acciones en esta lista. El radar se actualiza cada día tras el cierre de EE. UU.</div>`}</div></div>
  <p class="explica">Para seguir una de estas acciones a diario, envía <b>/vigilar TICKER</b> al bot de Telegram.</p>
  ${pie()}`;
}

/* ───────────── Vista: Noticias ───────────── */
function filaNoticia(n) {
  const c = { positivo: "verde", negativo: "rojo", neutro: "gris" }[n.tono] || "gris";
  return `<a class="noticia" href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">
    <div class="t">${esc(n.titulo)}</div>
    <div class="m">${n.tickers && n.tickers.length ? `<b style="color:var(--tinta)">${n.tickers.map(esc).join(", ")}</b>` : ""}<span>${esc(n.fuente || "")}</span><span>${hace(n.fecha)}</span>
    ${n.tono && n.tono !== "neutro" ? `<span class="tono c-${c}">${n.tono === "positivo" ? "Tono positivo" : "Tono negativo"}</span>` : ""}
    ${(n.temas || []).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div></a>`;
}
function vistaNoticias() {
  const N = S.D.noticias || {}, cal = S.D.calendario || [];
  const empresas = Object.values(N.empresas || {}).flat().sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  const propias = empresas.filter((n) => n.tickers.some((t) => (fichaDe(t) || {}).en_cartera));
  const tabs = { empresas: `Tus empresas (${empresas.length})`, bancos: "Fed y BCE", mercado: "Mercado mundial" };
  let lista = S.tabNot === "empresas" ? [...propias, ...empresas.filter((n) => !propias.includes(n))] : S.tabNot === "bancos" ? (N.bancos || []) : (N.generales || []);
  return `
  ${agenda(13, true, "Agenda")}
  <div class="filtros" role="group" aria-label="Tipo de noticia" style="margin-top:16px">${Object.entries(tabs).map(([k, v]) => `<button data-tabnot="${k}" aria-pressed="${S.tabNot === k}">${v}</button>`).join("")}</div>
  <p class="explica">Titulares en su idioma original. El tono es una estimación automática por palabras clave: léelo como pista, no como veredicto.</p>
  <div class="seccion" style="margin-top:10px"><div class="grupo">${lista.length ? lista.slice(0, 60).map(filaNoticia).join("") : `<div class="vacio">Sin noticias nuevas en esta sección.</div>`}</div></div>
  ${pie()}`;
}

function pie() {
  return `<p class="pie">Las acciones sugeridas salen de reglas fijas (tendencia, volumen, niveles con ATR y tu metodología de tramos) aplicadas igual a todas las acciones, validadas con su historial. Son orientación técnica, no asesoramiento financiero: la decisión es siempre tuya. Datos de Yahoo Finance y Finnhub; el análisis se actualiza cada 30–60 min en horario de mercado y por completo tras el cierre de EE. UU.</p>`;
}

/* ───────────── Ficha ───────────── */
async function abrirFicha(t, desdeRadar) {
  let f = fichaDe(t);
  if (!f && desdeRadar) {
    const E = S.D.etfs || {};
    const r = [...(S.D.radar.oportunidades || []), ...Object.values(S.D.radar.listas || {}).flat(),
      ...["momentum", "giros", "rotacion", "todos"].flatMap((k) => E[k] || [])].find((x) => x.ticker === t);
    if (!r) return;
    f = { ticker: r.ticker, nombre: r.nombre, divisa: r.divisa, precio: r.precio, cambio_dia: r.cambio_dia, puntuacion: r.puntuacion, tendencia: r.tendencia,
      accion: { codigo: r.codigo, titulo: r.accion, color: r.color, frase: r.frase, porque: [], plan: "Análisis completo disponible para las mejores oportunidades del radar. Añádela con /vigilar para seguirla a diario." },
      niveles: { precio: r.precio, zona_inf: r.zona_inf, zona_sup: r.zona_sup, stop: r.stop, objetivo: r.objetivo, rr: r.rr },
      semaforo: r.semaforo ? { color: r.semaforo, etapa: r.etapa, riesgo: r.riesgo, etapa_nombre: r.etapa ? `Etapa ${r.etapa}` : "", senales: [] } : null,
      senales: (r.senales || []).map((n) => ({ nombre: n, texto: "", tipo: "pos" })), claves_senales: [], ind: {} };
  }
  if (!f) return;
  $("#hoja-ticker").textContent = f.ticker;
  $("#hoja-nombre").textContent = f.nombre || "";
  $("#hoja-cuerpo").innerHTML = cuerpoFicha(f, null);
  const h = $("#hoja"); h.classList.add("abierta"); h.scrollTop = 0;
  S.conHistorial = false;
  if (!window.DEMO) { try { history.pushState({ ficha: t }, ""); S.conHistorial = true; } catch { /* sin historial */ } }
  try {
    const d = await detalle(t);
    if (d && $("#hoja-ticker").textContent === t) { $("#hoja-cuerpo").innerHTML = cuerpoFicha(f, d); pintarGrafico(f, d, 250); }
  } catch (e) { console.warn(e); }
}
function cerrarFicha() { $("#hoja").classList.remove("abierta"); if (S.grafico) { S.grafico.remove(); S.grafico = null; } }

function cuerpoFicha(f, d) {
  const a = f.accion, n = f.niveles || {}, p = f.posicion, fu = d && d.fundamental, bt = d && d.backtest, ind = f.ind || {};
  const pr = precioAhora(f.ticker, f.precio), cd = cambioAhora(f.ticker);
  const filaN = (et, sub, v) => `<div>${et}<small>${sub || ""}</small></div><div class="v">${v}</div>`;
  return `
  <div class="fila-sup" style="align-items:baseline"><span class="precio-grande" data-p="${esc(f.ticker)}">${precio(pr, f.divisa)}</span>
    <span class="var ${clsVar(cd)}" data-v="${esc(f.ticker)}" style="font-size:16px;font-weight:600">${pct(cd, 2)}</span>
    <span class="nom" style="text-align:right">${f.en_directo && S.vivo[f.ticker] ? "en directo" : f.fecha_dato ? "dato del " + esc(f.fecha_dato) : ""}</span></div>

  <div class="decision c-${a.color}">
    <div class="verbo">${esc(a.titulo)}</div><div class="que">${esc(a.frase)}</div>
    ${a.porque && a.porque.length ? `<ul>${a.porque.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${a.plan ? `<div class="plan"><b>Qué haría un gestor activo</b>${esc(a.plan)}</div>` : ""}
  </div>
  ${retsFila(f.ticker, f.ind)}

  ${seccionPlan(f)}
  ${seccionGiro(f, d)}
  ${seccionResultados(f, d)}

  ${p ? `<section class="seccion"><h2>Tu posición <small>${f.horizonte === "largo" ? "largo plazo" : "corto plazo"}</small></h2><div class="grupo">
    <div class="cifras"><div><small>Acciones</small><b>${num(p.acciones, p.acciones % 1 ? 3 : 0)}</b></div><div><small>Coste medio</small><b>${precio(p.coste_medio, f.divisa)}</b></div>
    <div><small>Rentabilidad</small><b class="${clsVar(p.pnl_pct)}" data-pnl="${esc(f.ticker)}">${pct(p.pnl_pct)}</b></div><div><small>Peso en cartera</small><b>${num(p.peso, 1)} %</b></div></div>
    <div style="padding:6px 12px 10px">${reglaTramos({ ...p, ticker: f.ticker, precio: f.precio, niveles: n }, f.divisa)}</div>
    <div class="niveles-tabla">${Object.entries(p.niveles_tramos || {}).map(([k, v]) => filaN(`Nivel ${k} %`, k.startsWith("+") ? "valorar recorte por tramos" : parseFloat(k) <= -15 ? "ejecutar estrategia" : "revisar tesis", precio(v, f.divisa))).join("")}
    ${f.recompra ? filaN("Zona de recompra", `−10/−15 % desde tu venta a ${precio(f.recompra.desde, f.divisa)}`, `${precio(f.recompra.nivel_inf, f.divisa)}–${precio(f.recompra.nivel_sup, f.divisa)}`) : ""}
    ${p.coste_implicito ? filaN("Coste aproximado", "derivado del % de Revolut; impórtalo para afinarlo", "⚠︎") : ""}</div></div></section>` : ""}

  <section class="seccion"><h2>${f.plan && (f.plan.tramos || []).length ? "Operativa de corto plazo" : "Puntos de entrada y salida"} <small>técnica</small></h2><div class="grupo">
    ${n.zona_inf != null ? `<div style="padding:8px 12px 12px">${reglaNiveles(n, f.ticker, f.divisa)}</div>
    <div class="niveles-tabla">
      ${filaN("Zona de compra", esc(n.motivo_entrada || ""), `${precio(n.zona_inf, f.divisa)}–${precio(n.zona_sup, f.divisa)}`)}
      ${filaN("Stop de protección", `${esc(n.motivo_stop || "")}${n.riesgo_pct ? ` · riesgo ${num(n.riesgo_pct, 1)} %` : ""}`, precio(n.stop, f.divisa))}
      ${filaN("Objetivo", `${esc(n.motivo_objetivo || "")}${n.nota_objetivo ? ". " + esc(n.nota_objetivo) : ""}`, precio(n.objetivo, f.divisa))}
      ${filaN("Beneficio / riesgo", "mínimo exigido 2:1", n.rr ? `${num(n.rr, 1)} : 1` : "—")}
      ${n.trailing ? filaN("Stop dinámico", "máximo de 22 sesiones − 3×ATR: protege beneficios", precio(n.trailing, f.divisa)) : ""}
      ${n.atr ? filaN("Volatilidad diaria (ATR)", "movimiento típico de un día", `${precio(n.atr, f.divisa)} · ${num(n.atr_pct, 1)} %`) : ""}
    </div>` : `<div class="vacio">Sin soporte cercano: el precio ha caído por debajo de todas sus referencias. No hay una zona de compra objetiva.</div>`}
  </div></section>

  <section class="seccion"><h2>Gráfico</h2><div class="grafico-caja">
    <div class="rangos" role="group" aria-label="Periodo">${[["3M", 63], ["6M", 126], ["1A", 250]].map(([k, v]) => `<button data-rango="${v}" aria-pressed="${v === 250}">${k}</button>`).join("")}</div>
    <div class="grafico" id="grafico">${d ? "" : `<div class="vacio">Cargando gráfico…</div>`}</div>
    <div class="leyenda-graf"><span><i style="background:var(--azul)"></i>EMA50</span><span><i style="background:var(--ambar)"></i>EMA200</span><span><i style="background:var(--verde)"></i>Zona de compra</span><span><i style="background:var(--rojo)"></i>Stop</span><span><i style="background:var(--naranja)"></i>Stop dinámico (línea de venta)</span><span><i style="background:var(--azul)"></i>Objetivo</span></div>
  </div></section>

  <section class="seccion"><h2>Señales activas <small>puntuación ${f.puntuacion} de −100 a 100 · tendencia ${esc(f.tendencia || "")}</small></h2><div class="grupo">
    ${(f.senales || []).length ? f.senales.map((s) => `<div class="senal c-${s.tipo === "pos" ? "verde" : s.tipo === "neg" ? "rojo" : "azul"}"><b>${esc(s.nombre)}</b>${s.texto ? `<p>${esc(s.texto)}</p>` : ""}</div>`).join("") : `<div class="vacio">Ninguna señal relevante hoy.</div>`}
  </div></section>

  ${Object.keys(ind).length ? `<section class="seccion"><h2>Indicadores</h2><div class="grupo"><div class="rejilla">
    <div><small>RSI (14)</small><b>${num(ind.rsi, 0)}</b></div><div><small>Flujo de dinero (MFI)</small><b>${num(ind.mfi, 0)}</b></div><div><small>Chaikin (CMF)</small><b class="${clsVar(ind.cmf)}">${num(ind.cmf, 2)}</b></div>
    <div><small>Volumen relativo</small><b>${num(ind.vol_rel, 1)}×</b></div><div><small>Vol. subida/bajada</small><b>${num(ind.vol_sube_baja, 2)}</b></div><div><small>Distancia EMA200</small><b class="${clsVar(ind.dist_ema200)}">${pct(ind.dist_ema200)}</b></div>
    <div><small>Semana</small><b class="${clsVar(ind.ret_1s)}">${pct(ind.ret_1s)}</b></div><div><small>Mes</small><b class="${clsVar(ind.ret_1m)}">${pct(ind.ret_1m)}</b></div><div><small>Trimestre</small><b class="${clsVar(ind.ret_3m)}">${pct(ind.ret_3m)}</b></div>
    <div><small>6 meses</small><b class="${clsVar(ind.ret_6m)}">${pct(ind.ret_6m)}</b></div><div><small>12 meses</small><b class="${clsVar(ind.ret_12m)}">${pct(ind.ret_12m)}</b></div><div><small>vs S&P (trimestre)</small><b class="${clsVar(ind.rs_3m)}">${pct(ind.rs_3m)}</b></div>
    <div><small>Desde máx. 52s</small><b class="${clsVar(ind.dist_max52)}">${pct(ind.dist_max52)}</b></div><div><small>EMA200 en 20 días</small><b class="${clsVar(ind.ema200_pend20)}">${pct(ind.ema200_pend20, 2)}</b></div><div><small>ATR</small><b>${num(n.atr_pct, 1)} %</b></div>
  </div></div></section>` : ""}

  ${bt ? seccionBacktest(bt, f) : d ? "" : `<section class="seccion"><h2>¿Ha funcionado antes?</h2><div class="grupo"><div class="vacio">Cargando historial…</div></div></section>`}
  ${d && d.negocio ? seccionValoracion(f, d.negocio) : ""}
  ${d && d.negocio ? seccionNegocio(f, d.negocio) : ""}
  ${fu ? seccionFundamental(fu, f) : ""}
  ${noticiasDe(f.ticker)}
  ${pie()}`;
}

function seccionGiro(f, d) {
  const sm = f.semaforo; if (!sm || sm.riesgo == null) return "";
  const bts = d && d.backtest_salida;
  const filaN = (et, sub, v) => `<div>${et}<small>${sub || ""}</small></div><div class="v">${v}</div>`;
  const cFi = { fiable: "verde", ruido: "gris", "no concluyente": "gris", "pocos casos": "ambar", "sin casos": "gris" };
  return `<section class="seccion"><h2>¿Sigue subiendo? <small>riesgo de giro ${sm.riesgo}/100</small></h2><div class="grupo">
    <div class="giro-cab c-${sm.color}">
      <div class="medidor-giro" role="img" aria-label="Riesgo de giro ${sm.riesgo} de 100"><span style="width:${Math.max(3, sm.riesgo)}%"></span><i style="left:25%"></i><i style="left:55%"></i></div>
      <div class="giro-txt"><b>${esc(sm.texto || COLOR_TXT[sm.color])}</b><small><b>${esc(sm.etapa_nombre || "")}.</b> ${esc(sm.etapa_texto || "")}</small></div>
    </div>
    ${(sm.senales || []).map((x) => `<div class="senal c-${sm.color === "verde" ? "ambar" : sm.color}"><b>${esc(x.nombre)}</b>${x.texto ? `<p>${esc(x.texto)}</p>` : ""}</div>`).join("")}
    ${(sm.nivel_ambar || sm.nivel_rojo) ? `<div class="niveles-tabla">
      ${sm.nivel_ambar ? filaN("Primer aviso si cierra por debajo de", esc(sm.motivo_ambar || ""), precio(sm.nivel_ambar, f.divisa)) : ""}
      ${sm.nivel_rojo ? filaN("Señal de venta si cierra por debajo de", esc(sm.motivo_rojo || ""), precio(sm.nivel_rojo, f.divisa)) : ""}</div>` : ""}
  </div>
  ${bts && bts.filas && bts.filas.length ? `<div class="grupo" style="margin-top:10px;overflow-x:auto"><table class="bt"><thead><tr><th>Señal de salida</th><th style="text-align:right">n</th><th style="text-align:right">Cayó &gt;${num(bts.caida, 0)} %</th></tr></thead><tbody>
    ${bts.filas.filter((r) => r.n).map((r) => `<tr class="${(sm.senales || []).some((x) => x.clave === r.clave) || (r.clave === "semaforo_rojo" && sm.color === "rojo") || (r.clave === "semaforo_ambar" && sm.color !== "verde") ? "activa" : ""}"><td>${esc(r.nombre)}<br><span class="fiab c-${cFi[r.fiabilidad] || "gris"}">${esc(r.fiabilidad)}</span></td>
      <td class="n">${r.n}</td><td class="n"><b>${num(r.tasa, 0)} %</b><br><small style="color:var(--tenue)">IC95 ${num(r.ic_inf, 0)}–${num(r.ic_sup, 0)} %<br>después ${pct(r.ret_medio)}</small></td></tr>`).join("")}
  </tbody></table></div>
  <p class="explica">Cuántas veces, tras cada señal, ${esc(f.ticker)} cayó más de un ${num(bts.caida, 0)} % en las ${bts.horizonte} sesiones siguientes. En un día cualquiera ocurre el ${num(bts.base, 0)} % de las veces: una señal es <b>fiable</b> si el extremo inferior de su intervalo supera esa tasa, y <b>ruido</b> si queda por debajo.</p>` : ""}
  </section>`;
}

function seccionResultados(f, d) {
  const r = (d && d.resultados) || f.resultados; if (!r) return "";
  const px = r.proxima, st = r.stats || {}, hist = (d && d.resultados && d.resultados.historial) || [];
  if (!px && !st.n) return "";
  const dd = px ? diasHasta(px.fecha) : null;
  const maxAbs = Math.max(1, ...hist.map((h) => Math.abs(h.reaccion)));
  return `<section class="seccion"><h2>Resultados</h2><div class="grupo">
    ${px ? `<div class="cal"><div class="dia"><b>${new Date(px.fecha + "T12:00:00").getDate()}</b><small>${new Date(px.fecha + "T12:00:00").toLocaleDateString("es-ES", { month: "short" })}</small></div>
      <div><b>Próximos resultados ${cuandoTxt(dd)}</b><br><small style="color:var(--tenue)">${esc(MOMENTO[px.momento] || "hora sin confirmar")} · ${px.confirmada ? "fecha confirmada" : "fecha estimada"}${px.fuente ? " · " + esc(px.fuente) : ""}</small></div><span></span></div>` : ""}
    ${st.n ? `<div class="rejilla">
      <div><small>Movimiento típico</small><b>±${num(st.mov_medio_abs, 1)} %</b></div><div><small>Máximo</small><b>±${num(st.mov_max_abs, 1)} %</b></div><div><small>Sube tras resultados</small><b>${num(st.pct_sube, 0)} %</b></div>
      <div><small>5 sesiones antes</small><b class="${clsVar(st.previo_medio)}">${pct(st.previo_medio)}</b></div><div><small>Sube antes</small><b>${num(st.previo_sube, 0)} %</b></div><div><small>5 sesiones después</small><b class="${clsVar(st.posterior_medio)}">${pct(st.posterior_medio)}</b></div></div>` : ""}
    ${hist.length ? `<div class="barras" role="img" aria-label="Reacción del precio a los últimos resultados">${hist.slice(0, 8).map((h) => `<div class="barra-res"><span class="f">${esc(h.fecha.slice(0, 7))}</span>
      <span class="eje"><span class="b ${h.reaccion >= 0 ? "pos" : "neg"}" style="${h.reaccion >= 0 ? "left:50%" : `right:50%`};width:${Math.abs(h.reaccion) / maxAbs * 50}%"></span></span>
      <span class="v ${clsVar(h.reaccion)}">${pct(h.reaccion, 1)}</span></div>`).join("")}</div>` : ""}
  </div>${st.n ? `<p class="explica">Reacción del precio en la primera sesión tras cada anuncio en los últimos ${st.n} trimestres. Sirve para decidir si quieres llevar la posición entera a resultados.</p>` : ""}</section>`;
}

function seccionBacktest(bt, f) {
  if (!bt.filas || !bt.filas.length) return "";
  const cFi = { fiable: "verde", desfavorable: "rojo", "no concluyente": "gris", "pocos casos": "ambar", "sin casos": "gris" };
  const activas = new Set(f.claves_senales || []);
  return `<section class="seccion"><h2>¿Ha funcionado antes? <small>${num(bt.anios, 0)} años de ${esc(f.ticker)}</small></h2><div class="grupo" style="overflow-x:auto">
    <table class="bt"><thead><tr><th>Señal</th><th style="text-align:right">n</th><th style="text-align:right">Acierto</th><th style="text-align:right">Plan</th></tr></thead><tbody>
    ${bt.filas.map((r) => `<tr class="${activas.has(r.clave) ? "activa" : ""}"><td>${esc(r.nombre)}${activas.has(r.clave) ? " · <b>activa hoy</b>" : ""}<br><span class="fiab c-${cFi[r.fiabilidad] || "gris"}">${esc(r.fiabilidad)}</span></td>
      <td class="n">${r.n}</td>
      <td class="n">${r.n ? `<b>${num(r.acierto, 0)} %</b><br><small style="color:var(--tenue)">IC95 ${num(r.ic_inf, 0)}–${num(r.ic_sup, 0)} %<br>media ${pct(r.ret_medio)}</small>` : "—"}</td>
      <td class="n">${r.plan_n ? `<b>${num(r.plan_acierto, 0)} %</b><br><small style="color:var(--tenue)">${r.plan_esperanza_r >= 0 ? "+" : ""}${num(r.plan_esperanza_r, 2)} R/operación</small>` : "—"}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="explica"><b>Acierto</b>: % de veces que la acción subía ${bt.horizonte} sesiones después de la señal. <b>Plan</b>: % de veces que se alcanzó el objetivo antes que el stop. Referencia sin señal: esta acción sube en el ${num(bt.base.acierto, 0)} % de las ventanas de ${bt.horizonte} sesiones (media ${pct(bt.base.ret_medio)}). Una señal es <b>fiable</b> si el extremo inferior de su intervalo de confianza supera esa tasa y su rentabilidad media es mayor. El plan simula entrar al cierre con stop a 2×ATR y objetivo a 2:1; "R" es lo que arriesgas por operación.</p></section>`;
}



/* ───────────── Plan de compra por tramos ───────────── */
function riesgoPct() { const v = parseFloat(LS.get("radar_riesgo")); return isFinite(v) && v > 0 ? v : (S.D.meta.riesgo_defecto_pct || 1); }
function reglaPlan(pl, divisa) {
  const tr = pl.tramos || []; if (!tr.length) return "";
  const vals = [pl.precio, ...tr.flatMap((t) => [t.inf, t.sup])];
  if (pl.invalidacion) vals.push(pl.invalidacion);
  if (pl.confirmacion) vals.push(pl.confirmacion.precio);
  let min = Math.min(...vals), max = Math.max(...vals); const pad = (max - min) * 0.06; min -= pad; max += pad;
  const P = (v) => pos(v, min, max);
  return `<div class="regla plan-regla" role="img" aria-label="Escalera de compra">
    <div class="pista"></div>
    ${pl.invalidacion ? `<div class="marca-stop" style="left:${P(pl.invalidacion)}%"></div><span class="eti izq" style="left:${P(pl.invalidacion)}%">Invalidación ${precio(pl.invalidacion, divisa)}</span>` : ""}
    ${tr.map((t) => `<div class="zona" style="left:${P(t.inf)}%;width:${Math.max(2, P(t.sup) - P(t.inf))}%"></div><span class="num-tramo" style="left:${(P(t.inf) + P(t.sup)) / 2}%">${t.n}</span>`).join("")}
    ${pl.confirmacion ? `<div class="marca-obj" style="left:${P(pl.confirmacion.precio)}%"></div>` : ""}
    <div class="bola" style="left:${P(pl.precio)}%"></div>
    <span class="eti dch" style="left:${P(pl.precio)}%">Hoy ${precio(pl.precio, divisa)}</span>
  </div>`;
}
function seccionPlan(f) {
  const pl = f.plan; if (!pl || !(pl.tramos || []).length) return "";
  const div = f.divisa, fx = (S.D.cartera.resumen || {}).eurusd || 1, tot = totalesVivo();
  const rp = riesgoPct(), riesgoEur = (tot.valor_eur || 0) * rp / 100, n = pl.tramos.length;
  const aEur = (x) => (div === "USD" ? x / fx : x);
  // Mismo dinero en cada tramo; el total se fija para que, si se llenan todos y el precio cae a la
  // invalidación, la pérdida sea el % de cartera elegido.
  const caidaMedia = pl.invalidacion ? pl.tramos.reduce((s2, t) => s2 + Math.max(0.005, (t.centro - pl.invalidacion) / t.centro), 0) / n : null;
  const limite = (S.D.meta.limite_posicion_pct || 10) / 100 * (tot.valor_eur || 0);
  const invRiesgo = caidaMedia && riesgoEur ? riesgoEur / caidaMedia : null;
  const limitada = invRiesgo && limite && invRiesgo > limite;
  const inversion = invRiesgo ? Math.min(invRiesgo, limite || invRiesgo) : null;
  const filas = pl.tramos.map((t) => {
    if (!inversion) return { ...t, acc: null, coste: null };
    const acc = (inversion / n) / aEur(t.centro);
    return { ...t, acc, coste: inversion / n };
  });
  const totalCoste = filas.reduce((s2, x) => s2 + (x.coste || 0), 0);
  const pesoFinal = tot.valor_eur ? totalCoste / (tot.valor_eur + totalCoste) * 100 : null;
  const tituloSec = f.en_cartera ? "Si quieres ampliar" : "Tu plan de compra";
  return `<section class="seccion"><h2>${tituloSec} <small>por tramos</small></h2><div class="grupo">
    <div class="plan-frase c-${pl.tipo === "tramos" || pl.tipo === "comprar" ? "verde" : "azul"}"><b>${esc(pl.frase)}</b>${pl.aviso ? `<p class="aviso-plan">${esc(pl.aviso)}</p>` : ""}</div>
    ${pl.pasa && pl.pasa.length ? `<div class="plan-bloque"><h3>Qué está pasando</h3><ul>${pl.pasa.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    <div class="plan-bloque"><h3>Dónde comprar</h3>${reglaPlan(pl, div)}
      ${filas.map((t) => `<div class="tramo">
        <div class="tramo-n">${t.n}</div>
        <div class="tramo-txt"><b>${precio(t.inf, div)} – ${precio(t.sup, div)}</b> <span class="chip ${t.puntos >= 3 ? "pos" : ""}">confluencia ${esc(t.fuerza)}</span>
          <small>${esc(t.factores.join(" · "))}</small>
          <small>${t.dist_pct ? `${pct(t.dist_pct, 1)} desde hoy` : "precio actual"}${t.per ? ` · PER ${num(t.per, 1)}` : ""}${t.per_adelantado ? ` (esperado ${num(t.per_adelantado, 1)})` : ""}${t.potencial != null ? ` · hasta el objetivo de analistas ${pct(t.potencial, 0)}` : ""}</small></div>
        <div class="tramo-acc">${t.acc != null ? `<b>${t.acc >= 10 ? num(Math.floor(t.acc), 0) : num(Math.floor(t.acc * 10) / 10, 1)}</b><small>acciones</small><small>≈ ${eur(t.coste)}</small>` : ""}</div>
      </div>`).join("")}
      ${pl.precio_medio ? `<p class="explica">Si se llenan todos los tramos, tu precio medio sería unos <b>${precio(pl.precio_medio, div)}</b>.</p>` : ""}
    </div>
    <div class="plan-bloque riesgo-bloque"><h3>Cuánto comprar</h3>
      <label class="riesgo-ctl">Si llega a la invalidación, acepto perder <input id="riesgo-pct" type="number" min="0.25" max="5" step="0.25" value="${rp}" inputmode="decimal"> % de mi cartera</label>
      <p>Eso son <b>${eur(riesgoEur)}</b>. Para no pasar de esa pérdida invertirías en total <b>${eur(totalCoste)}</b>, a partes iguales en cada tramo${pesoFinal != null ? `, un ${num(pesoFinal, 1)} % de tu cartera` : ""}.${limitada ? ` Limitado al ${num(S.D.meta.limite_posicion_pct || 10, 0)} % de tu cartera por posición: con tramos tan cerca de la invalidación, el cálculo por riesgo daría una posición demasiado grande.` : ""} Las cifras con decimales requieren acciones fraccionadas (Revolut las permite).</p>
    </div>
    ${pl.confirmacion ? `<div class="plan-bloque"><h3>Si prefieres no comprar mientras cae</h3><p>${esc(pl.confirmacion.texto)}</p></div>` : ""}
    ${pl.cuando_no && pl.cuando_no.length ? `<div class="plan-bloque"><h3>Cuándo no comprar</h3><ul>${pl.cuando_no.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    ${pl.invalidacion ? `<div class="plan-bloque"><h3>Qué invalidaría el plan</h3><p>Un cierre semanal por debajo de <b>${precio(pl.invalidacion, div)}</b>: dejar de añadir y revisar la tesis. Revisa también los resultados y las noticias de la empresa.</p></div>` : ""}
  </div>
  <p class="explica">Los tramos son zonas donde coinciden varios motivos para que aparezcan compradores (mínimos anteriores, medias, Fibonacci, mínimo anual, precios con mucho volumen, niveles propios). Más coincidencias, zona más sólida, pero ninguna garantiza el rebote. Es un plan objetivo con reglas fijas, no asesoramiento: la decisión es tuya.</p></section>`;
}

/* ───────────── Negocio trimestral ───────────── */
function dinero(x, divisa) {
  if (x == null || !isFinite(x)) return "—";
  const a = Math.abs(x), s = { USD: " $", EUR: " €" }[divisa] ?? (divisa ? " " + divisa : "");
  if (a >= 1e12) return `${num(x / 1e12, 2)} billones${s}`;
  if (a >= 1e9) return `${num(x / 1e9, a >= 1e11 ? 0 : 1)} mil M${s}`;
  if (a >= 1e6) return `${num(x / 1e6, 0)} M${s}`;
  return `${num(x, 2)}${s}`;
}
function svgBarras(vals, etiquetas, color, fmt) {
  const v = vals.map((x) => (x == null || !isFinite(x) ? null : x));
  const ok = v.filter((x) => x != null); if (!ok.length) return "";
  const W = 200, H = 64, max = Math.max(0, ...ok), min = Math.min(0, ...ok), rango = max - min || 1;
  const bw = W / v.length, y0 = H * (max / rango);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${v.map((x, i) => {
    if (x == null) return "";
    const h = Math.max(1, Math.abs(x) / rango * H), y = x >= 0 ? y0 - h : y0;
    const fill = x >= 0 ? color : "var(--rojo)";
    return `<rect x="${i * bw + bw * 0.18}" y="${y}" width="${bw * 0.64}" height="${h}" rx="1.5" fill="${fill}"><title>${esc(etiquetas[i])}: ${esc(fmt(x))}</title></rect>`;
  }).join("")}<line x1="0" x2="${W}" y1="${y0}" y2="${y0}" stroke="var(--linea)" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>`;
}
function svgLineas(series, etiquetas, fmt) {
  const todos = series.flatMap((s) => s.v.filter((x) => x != null && isFinite(x)));
  if (!todos.length) return "";
  const W = 200, H = 64, max = Math.max(...todos), min = Math.min(...todos), r = max - min || 1, n = etiquetas.length;
  const X = (i) => (n > 1 ? (i / (n - 1)) * W : W / 2), Y = (x) => H - ((x - min) / r) * (H - 6) - 3;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${series.map((s) => {
    const pts = s.v.map((x, i) => (x == null || !isFinite(x) ? null : `${X(i)},${Y(x)}`)).filter(Boolean).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"><title>${esc(s.nombre)}: ${s.v.map((x, i) => `${etiquetas[i]} ${fmt(x)}`).join(" · ")}</title></polyline>`;
  }).join("")}</svg>`;
}
function variacion(vals, desfase = 4) {
  const v = vals.filter((x) => x != null), u = vals[vals.length - 1], a = vals[vals.length - 1 - desfase];
  if (u == null || a == null || !a) return null;
  return (u / a - 1) * 100 * (a < 0 ? -1 : 1);
}
function seccionNegocio(f, n) {
  const t = n.trimestres; if (!t || !t.t) return "";
  const div = n.divisa_estados || "USD", fin = t.t[t.t.length - 1], ini = t.t[0];
  const ult = (k) => (t[k] || [])[t[k].length - 1];
  const cardBar = (titulo, k, color, fmt = (x) => dinero(x, div), desfase = 4) => {
    if (!t[k] || t[k].every((x) => x == null)) return "";
    const vr = variacion(t[k], desfase);
    return `<div class="mini"><h3>${titulo}</h3><div class="dato">${fmt(ult(k))}${vr != null ? `<small class="${clsVar(vr)}">${pct(vr, 0)} interanual</small>` : ""}</div>
      ${svgBarras(t[k], t.t, color, fmt)}<div class="ejes"><span>${ini}</span><span>${fin}</span></div></div>`;
  };
  const cardLin = (titulo, defs, fmt, dato) => {
    const series = defs.filter((d) => t[d.k] && t[d.k].some((x) => x != null)).map((d) => ({ ...d, v: t[d.k] }));
    if (!series.length) return "";
    return `<div class="mini"><h3>${titulo}</h3><div class="dato">${dato || series.map((s) => fmt(s.v[s.v.length - 1])).join(" · ")}</div>
      ${svgLineas(series, t.t, fmt)}<div class="ley">${series.length > 1 ? series.map((s) => `<span><i style="background:${s.color}"></i>${s.nombre} ${fmt(s.v[s.v.length - 1])}</span>`).join("") : ""}</div>
      <div class="ejes"><span>${ini}</span><span>${fin}</span></div></div>`;
  };
  const p1 = (x) => (x == null ? "—" : `${num(x, 1)} %`);
  const deudaCaja = (t.deuda && t.caja) ? `<div class="mini"><h3>Deuda y caja</h3><div class="dato">${dinero(ult("deuda"), div)} · ${dinero(ult("caja"), div)}</div>
      ${svgLineas([{ nombre: "Deuda", color: "var(--cat4)", v: t.deuda }, { nombre: "Caja", color: "var(--cat2)", v: t.caja }], t.t, (x) => dinero(x, div))}
      <div class="ley"><span><i style="background:var(--cat4)"></i>Deuda</span><span><i style="background:var(--cat2)"></i>Caja</span></div>
      <div class="ejes"><span>${ini}</span><span>${fin}</span></div></div>` : "";
  const deriv = (t.derivado || []).some(Boolean);
  return `<section class="seccion"><h2>El negocio, trimestre a trimestre <small>${esc(n.fuente)} · último ${fin}</small></h2>
    <div class="grupo"><div class="mini-grid">
      ${cardBar("Ingresos", "ingresos", "var(--cat1)")}
      ${cardBar("BPA (beneficio por acción)", "bpa", "var(--cat2)", (x) => (x == null ? "—" : `${num(x, 2)}`))}
      ${cardBar("Flujo de caja libre", "fcf", "var(--cat2)")}
      ${cardLin("Márgenes", [{ k: "margen_bruto", nombre: "Bruto", color: "var(--cat1)" }, { k: "margen_operativo", nombre: "Operativo", color: "var(--cat2)" },
        { k: "margen_neto", nombre: "Neto", color: "var(--cat3)" }, { k: "margen_fcf", nombre: "FCF", color: "var(--cat4)" }], p1, `${p1(ult("margen_operativo"))} operativo`)}
      ${cardBar("Beneficio neto", "neto", "var(--cat3)")}
      ${cardBar("EBITDA", "ebitda", "var(--cat4)")}
      ${cardBar("Flujo de caja operativo", "ocf", "var(--cat1)")}
      ${deudaCaja}
      ${cardLin("Acciones en circulación", [{ k: "acciones", nombre: "Acciones", color: "var(--cat1)" }], (x) => (x == null ? "—" : `${num(x / 1e6, 0)} M`),
        (() => { const v = variacion(t.acciones, 8); return `${num(ult("acciones") / 1e6, 0)} M${v != null ? ` <small class="${clsVar(-v)}">${pct(v, 1)} en 2 años</small>` : ""}`; })())}
      ${cardLin("Rentabilidad (12 meses)", [{ k: "roe", nombre: "ROE", color: "var(--cat1)" }, { k: "roa", nombre: "ROA", color: "var(--cat2)" }, { k: "roic", nombre: "ROIC", color: "var(--cat3)" }], p1, `ROE ${p1(ult("roe"))} · ROIC ${p1(ult("roic"))}`)}
      ${cardBar("Pago en acciones (SBC)", "sbc", "var(--cat3)")}
      ${cardLin("Liquidez corriente", [{ k: "liquidez", nombre: "Liquidez", color: "var(--cat1)" }], (x) => (x == null ? "—" : num(x, 2)),
        `${num(ult("liquidez"), 2)} <small style="color:var(--tenue)">deuda/patrimonio ${num(ult("deuda_patrimonio"), 2)}</small>`)}
    </div></div>
    <p class="explica">Cada barra es un trimestre (pasa el dedo o el ratón por encima para ver el valor). Interanual: frente al mismo trimestre del año anterior. ${div !== "USD" ? `Cifras en ${esc(div)}. ` : ""}${deriv ? "Algunos trimestres (normalmente el cuarto) se calculan restando del dato anual los trimestres publicados. " : ""}ROIC aproximado: resultado operativo después de impuestos sobre deuda + patrimonio − caja.</p></section>`;
}

/* ───────────── Valoración frente a su historia ───────────── */
S.multiplo = "per";
function seccionValoracion(f, n) {
  const v = n.valoracion || {}, act = v.actual || {}, c = n.crecimiento || {};
  const fila = (nombre, k) => {
    const g = c[k]; if (!g) return "";
    const cel = (x) => (x == null ? "—" : `<span class="${clsVar(x)}">${pct(x, 0)}</span>`);
    return `<tr><td>${nombre}</td><td>${cel(g["5a"])}</td><td>${cel(g["3a"])}</td><td>${cel(g["1a"])}</td><td>${cel(g.e_actual)}</td><td>${cel(g.e_siguiente)}</td></tr>`;
  };
  const crec = (c.ingresos || c.bpa) ? `<div class="grupo" style="overflow-x:auto"><table class="val"><thead><tr><th>Crece</th><th>5a</th><th>3a</th><th>12 m</th><th>Ej. (e)</th><th>Próx. (e)</th></tr></thead>
    <tbody>${fila("Ingresos", "ingresos")}${fila("BPA", "bpa")}${fila("Flujo de caja libre", "fcf")}</tbody></table></div>
    <p class="explica">5a y 3a: crecimiento anual compuesto a 5 y 3 años. 12 m: últimos 12 meses frente a los 12 anteriores. Ej. (e) y Próx. (e): estimación media de los analistas para el ejercicio en curso y el siguiente. P/FCF: precio / flujo de caja libre · P/FCO: precio / flujo de caja operativo · P/EBIT: precio / resultado operativo.</p>` : "";
  const corto = { per: "PER", p_ventas: "P/Ventas", p_fcf: "P/FCF", p_ocf: "P/FCO", p_ebit: "P/EBIT" };
  const filas = Object.entries(act).map(([k, m]) => `<tr><td title="${esc(m.nombre)}">${corto[k] || esc(m.nombre)}</td><td><b>${num(m.actual, 1)}</b></td><td>${m.mediana_hist != null ? num(m.mediana_hist, 1) : "—"}</td>
    <td>${m.percentil_hist != null ? `<div style="display:flex;gap:8px;align-items:center;justify-content:flex-end"><span class="pctl"><i style="left:${m.percentil_hist}%"></i></span>${num(m.percentil_hist, 0)}</div>` : "—"}</td></tr>`).join("");
  const aniosH = Math.max(0, ...Object.values(act).map((m) => m.anios_hist || 0));
  const aniosTxt = aniosH >= 1.5 ? `${num(aniosH, 0)} años` : aniosH ? `${num(aniosH * 12, 0)} meses` : "";
  const ver = v.veredicto;
  if (!filas && !crec) return "";
  return `<section class="seccion"><h2>Valoración frente a su historia</h2>
    ${ver ? `<div class="grupo"><div class="veredicto c-${ver.color}"><div><b>${esc(ver.texto)}</b><small>${esc(ver.multiplo)} en el percentil ${num(ver.percentil, 0)} de los últimos ${aniosTxt}: más cara que el ${num(ver.percentil, 0)} % de los días.${aniosH < 3 ? " Historia corta: tómalo como orientación." : ""}</small></div></div></div>` : ""}
    ${filas ? `<div class="grupo" style="margin-top:10px;overflow-x:auto"><table class="val"><thead><tr><th>Múltiplo</th><th>Hoy</th><th>Mediana</th><th>Percentil</th></tr></thead><tbody>${filas}</tbody></table>
      <div class="rangos" role="group" aria-label="Múltiplo" style="padding-top:8px">${Object.entries(act).map(([k, m]) => `<button data-multiplo="${k}" aria-pressed="${S.multiplo === k}">${esc({ per: "PER", p_ventas: "P/Ventas", p_fcf: "P/FCF", p_ocf: "P/FCO", p_ebit: "P/EBIT" }[k] || k)}</button>`).join("")}</div>
      <div class="graf-mult" id="graf-mult">${graficoMultiplo(n, S.multiplo in act ? S.multiplo : Object.keys(act)[0])}</div></div>
      <p class="explica">Línea: el múltiplo cada semana con los datos que ya se conocían en esa fecha. Banda: rango habitual (percentiles 25–75). Discontinua: mediana. Un percentil bajo indica que hoy cotiza más barata que su propia historia, no necesariamente que sea una ganga: compruébalo con el crecimiento.</p>` : ""}
    ${crec}</section>`;
}
function graficoMultiplo(n, k) {
  const v = n.valoracion || {}, sem = v.semanal || {}, m = (v.actual || {})[k];
  if (!sem.t || !sem[k] || !m) return "";
  const pts = sem.t.map((t, i) => [t, sem[k][i]]).filter((x) => x[1] != null);
  if (pts.length < 5) return "";
  const W = 600, H = 170, padL = 34, padB = 18, vals = pts.map((x) => x[1]);
  const lo = Math.min(...vals, m.p25_hist ?? Infinity), hi = Math.max(...vals, m.p75_hist ?? -Infinity), r = hi - lo || 1;
  const X = (i) => padL + (i / (pts.length - 1)) * (W - padL - 4), Y = (x) => (H - padB) - ((x - lo) / r) * (H - padB - 8);
  const ticks = [lo, lo + r / 2, hi];
  const band = m.p25_hist != null ? `<rect x="${padL}" y="${Y(m.p75_hist)}" width="${W - padL - 4}" height="${Math.max(1, Y(m.p25_hist) - Y(m.p75_hist))}" fill="var(--azul-suave)"/>` : "";
  const med = m.mediana_hist != null ? `<line x1="${padL}" x2="${W - 4}" y1="${Y(m.mediana_hist)}" y2="${Y(m.mediana_hist)}" stroke="var(--tenue)" stroke-dasharray="4 4" stroke-width="1"/><text x="${W - 6}" y="${Y(m.mediana_hist) - 4}" text-anchor="end">mediana ${num(m.mediana_hist, 1)}</text>` : "";
  const anios = [...new Set(pts.map((x) => x[0].slice(0, 4)))];
  let ultX = -99;
  const ejeX = anios.map((a) => { const i = pts.findIndex((x) => x[0].startsWith(a)); const xx = X(i);
    if (xx - ultX < 48) return ""; ultX = xx; return `<text x="${xx}" y="${H - 4}">${a}</text>`; }).join("");
  const ultimo = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.nombre)} semanal, 5 años">
    ${band}${ticks.map((tk) => `<text x="${padL - 6}" y="${Y(tk) + 3}" text-anchor="end">${num(tk, 0)}</text>`).join("")}
    ${med}<polyline points="${pts.map((x, i) => `${X(i)},${Y(x[1])}`).join(" ")}" fill="none" stroke="var(--cat1)" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${X(pts.length - 1)}" cy="${Y(ultimo[1])}" r="4" fill="var(--cat1)" stroke="var(--superficie)" stroke-width="2"><title>${esc(m.nombre)} actual: ${num(ultimo[1], 1)}</title></circle>
    ${ejeX}</svg>`;
}

function seccionFundamental(fu, f) {
  if (!fu.aplica) return `<section class="seccion"><h2>Fundamentales</h2><div class="grupo"><div class="vacio">${fu.tipo === "ETF" ? "Es un fondo cotizado (ETF): no aplica el análisis de empresa." : "Sin datos fundamentales."}</div></div></section>`;
  const cons = { strong_buy: "Compra fuerte", buy: "Comprar", hold: "Mantener", sell: "Vender", strong_sell: "Venta fuerte", underperform: "Infraponderar", outperform: "Sobreponderar" }[fu.consenso] || fu.consenso || "—";
  return `<section class="seccion"><h2>Calidad estilo Buffett <small>${fu.puntuacion ?? "—"}/100</small></h2><div class="grupo">
    <div class="rejilla"><div><small>PER</small><b>${num(fu.per, 1)}</b></div><div><small>PER adelantado</small><b>${num(fu.per_adelantado, 1)}</b></div><div><small>PEG</small><b>${num(fu.peg, 2)}</b></div>
    <div><small>BPA (EPS)</small><b>${num(fu.eps, 2)}</b></div><div><small>BPA esperado</small><b>${num(fu.eps_adelantado, 2)}</b></div><div><small>Crec. BPA esp.</small><b class="${clsVar(fu.eps_crecimiento_esperado)}">${pct(fu.eps_crecimiento_esperado, 0)}</b></div></div>
    ${(fu.criterios || []).map((c) => `<div class="criterio c-${c.ok ? "verde" : "rojo"}"><span class="ok">${c.ok ? "✓" : "✕"}</span><div>${esc(c.nombre)}<small>${esc(c.texto)}</small></div><span class="v">${esc(c.valor)}</span></div>`).join("")}
    <div class="criterio c-azul"><span class="ok">i</span><div>Consenso de analistas<small>${fu.n_analistas ? fu.n_analistas + " analistas · " : ""}precio objetivo medio ${precio(fu.precio_objetivo_analistas, f.divisa)}</small></div><span class="v">${esc(cons)}${fu.potencial_analistas != null ? `<br><small class="${clsVar(fu.potencial_analistas)}">${pct(fu.potencial_analistas, 0)}</small>` : ""}</span></div>
  </div></section>`;
}

function noticiasDe(t) {
  const N = S.D.noticias || {};
  const lista = [...((N.empresas || {})[t] || []), ...(N.generales || []).filter((n) => (n.tickers || []).includes(t))];
  if (!lista.length) return "";
  return `<section class="seccion"><h2>Noticias</h2><div class="grupo">${lista.slice(0, 8).map(filaNoticia).join("")}</div></section>`;
}

/* ───────────── Gráfico ───────────── */
function color(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function pintarGrafico(f, d, dias) {
  const el = $("#grafico");
  if (!el || !d || !d.grafico || !window.LightweightCharts) return;
  el.innerHTML = "";
  if (S.grafico) { S.grafico.remove(); S.grafico = null; }
  const g = d.grafico, n = f.niveles || {};
  const ch = LightweightCharts.createChart(el, {
    autoSize: true, layout: { background: { color: "transparent" }, textColor: color("--tenue"), fontFamily: color("--fuente") || "system-ui" },
    grid: { vertLines: { visible: false }, horzLines: { color: color("--linea") } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, rightOffset: 4 },
    crosshair: { mode: 0 }, handleScroll: { vertTouchDrag: false },
  });
  S.grafico = ch;
  const velas = ch.addCandlestickSeries({ upColor: color("--verde"), downColor: color("--rojo"), borderVisible: false, wickUpColor: color("--verde"), wickDownColor: color("--rojo") });
  velas.setData(g.t.map((t, i) => ({ time: t, open: g.o[i], high: g.h[i], low: g.l[i], close: g.c[i] })));
  const linea = (datos, c) => { const s = ch.addLineSeries({ color: c, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); s.setData(g.t.map((t, i) => ({ time: t, value: datos[i] })).filter((x) => x.value != null)); };
  linea(g.e50, color("--azul")); linea(g.e200, color("--ambar"));
  if (g.tr) { const st = ch.addLineSeries({ color: color("--naranja"), lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    st.setData(g.t.map((t, i) => ({ time: t, value: g.tr[i] })).filter((x) => x.value != null)); }
  const vol = ch.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "", color: color("--gris") });
  vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  vol.setData(g.t.map((t, i) => ({ time: t, value: g.v[i], color: g.c[i] >= g.o[i] ? color("--verde") + "66" : color("--rojo") + "66" })));
  const pl = (precio, c, titulo, estilo = 2) => precio != null && velas.createPriceLine({ price: precio, color: c, lineWidth: 1, lineStyle: estilo, axisLabelVisible: true, title: titulo });
  pl(n.zona_sup, color("--verde"), "Zona", 0); pl(n.zona_inf, color("--verde"), "", 0);
  pl(n.stop, color("--rojo"), "Stop"); pl(n.objetivo, color("--azul"), "Objetivo"); 
  if (f.posicion && f.posicion.coste_medio) pl(f.posicion.coste_medio, color("--tinta"), "Coste", 3);
  const total = g.t.length;
  ch.timeScale().setVisibleLogicalRange({ from: Math.max(0, total - dias), to: total + 3 });
}

/* ───────────── Eventos ───────────── */
document.addEventListener("click", (e) => {
  const b = e.target.closest("button, a");
  if (!b) return;
  if (b.dataset.vista) { ir(b.dataset.vista); return; }
  if (b.dataset.abrir) { abrirFicha(b.dataset.abrir); return; }
  if (b.dataset.radar) { abrirFicha(b.dataset.radar, true); return; }
  if (b.dataset.filtroVig) { S.filtroVig = b.dataset.filtroVig; ir("vigilancia", false); return; }
  if (b.dataset.lista) { S.listaRadar = b.dataset.lista; ir("radar", false); return; }
  if (b.dataset.listaEtf) { S.listaEtf = b.dataset.listaEtf; ir("radar", false); return; }
  if (b.dataset.modoRadar) { S.modoRadar = b.dataset.modoRadar; ir("radar", false); return; }
  if (b.dataset.tabnot) { S.tabNot = b.dataset.tabnot; ir("noticias", false); return; }
  if (b.dataset.multiplo) {
    S.multiplo = b.dataset.multiplo;
    $$("[data-multiplo]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    const t = $("#hoja-ticker").textContent; const d = S.det[t];
    if (d && d.negocio) $("#graf-mult").innerHTML = graficoMultiplo(d.negocio, S.multiplo);
    return;
  }
  if (b.dataset.rango) {
    $$("[data-rango]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    const t = $("#hoja-ticker").textContent; const f = fichaDe(t);
    if (S.det[t] && f) pintarGrafico(f, S.det[t], +b.dataset.rango);
  }
});
document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "riesgo-pct") {
    const v = parseFloat(String(e.target.value).replace(",", "."));
    if (isFinite(v) && v > 0) { LS.set("radar_riesgo", String(v)); const t = $("#hoja-ticker").textContent; const f = fichaDe(t);
      if (f) { const y = $("#hoja").scrollTop; $("#hoja-cuerpo").innerHTML = cuerpoFicha(f, S.det[t] || null); if (S.det[t]) pintarGrafico(f, S.det[t], 250); $("#hoja").scrollTop = y; } }
  }
});
$("#btn-cerrar-hoja").addEventListener("click", () => { if (S.conHistorial) history.back(); else cerrarFicha(); });
window.addEventListener("popstate", () => { if ($("#hoja").classList.contains("abierta")) cerrarFicha(); });
$("#form-acceso").addEventListener("submit", (e) => { e.preventDefault(); entrar($("#clave").value, $("#recordar").checked); });
$("#btn-salir").addEventListener("click", () => { LS.del("radar_clave"); location.reload(); });
$("#btn-recargar").addEventListener("click", async () => {
  const c = LS.get("radar_clave"); if (window.DEMO) { ir(S.vista, false); return; }
  if (c) { await cargar(c, true); ir(S.vista, false); conectarVivo(); } else location.reload();
});
$("#btn-tema").addEventListener("click", () => {
  const ciclo = { "": "dark", dark: "light", light: "" };
  const actual = document.documentElement.dataset.theme || "";
  const nuevo = ciclo[actual];
  if (nuevo) document.documentElement.dataset.theme = nuevo; else delete document.documentElement.dataset.theme;
  LS.set("radar_tema", nuevo);
  if (S.grafico && $("#hoja").classList.contains("abierta")) { const t = $("#hoja-ticker").textContent; pintarGrafico(fichaDe(t), S.det[t], 250); }
});
window.addEventListener("scroll", () => $("#cabecera").classList.toggle("con-borde", window.scrollY > 4), { passive: true });
setInterval(pintarEstado, 30000);
document.addEventListener("visibilitychange", async () => {
  // Al volver a la app tras un rato, recargar el último análisis
  if (document.visibilityState === "visible" && S.D && !window.DEMO && Date.now() - (S.cargado || 0) > 10 * 60000) {
    const c = LS.get("radar_clave"); if (c) { try { await cargar(c, true); S.cargado = Date.now(); ir(S.vista, false); } catch { /* sin conexión */ } }
  }
});

/* ───────────── Arranque ───────────── */
(function iniciar() {
  const tema = LS.get("radar_tema"); if (tema) document.documentElement.dataset.theme = tema;
  S.vista = LS.get("radar_vista") || "inicio";
  if ("serviceWorker" in navigator && !window.DEMO && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  if (window.DEMO) { entrar("", false); return; }
  if (!window.crypto || !crypto.subtle || !window.DecompressionStream) {
    $("#acceso").classList.remove("oculto");
    $("#error-acceso").textContent = "Tu navegador es demasiado antiguo para descifrar los datos. Actualízalo (iOS 16.4 o superior).";
    return;
  }
  const guardada = LS.get("radar_clave");
  if (guardada) { S.cargado = Date.now(); entrar(guardada, true); } else $("#acceso").classList.remove("oculto");
})();
