// ════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════
const API        = "/api";
const NOMINATIM  = "https://nominatim.openstreetmap.org/search";
const BLURU_BOX  = "77.3,12.7,77.9,13.3";

const OPT = {
  safety:  {color:"#22c55e", icon:"🛡", label:"Safety"},
  road:    {color:"#3b82f6", icon:"🛣", label:"Better Roads"},
  deadend: {color:"#f59e0b", icon:"🚫", label:"No Dead Ends"},
};

const FALLBACK_PRESETS = {
  "":                   {w_safety:0.00, w_road:0.00, w_deadend:0.00, w_distance:1.00},
  "shortest":           {w_safety:0.00, w_road:0.00, w_deadend:0.00, w_distance:1.00},
  "safety":             {w_safety:0.90, w_road:0.00, w_deadend:0.00, w_distance:0.10},
  "road":               {w_safety:0.00, w_road:0.90, w_deadend:0.00, w_distance:0.10},
  "deadend":            {w_safety:0.00, w_road:0.05, w_deadend:0.90, w_distance:0.05},
  "road+safety":        {w_safety:0.50, w_road:0.40, w_deadend:0.00, w_distance:0.10},
  "deadend+safety":     {w_safety:0.50, w_road:0.00, w_deadend:0.40, w_distance:0.10},
  "deadend+road":       {w_safety:0.00, w_road:0.45, w_deadend:0.45, w_distance:0.10},
  "deadend+road+safety":{w_safety:0.30, w_road:0.30, w_deadend:0.30, w_distance:0.10},
};

const RQ = [
  {keys:["motorway","trunk"],                                     color:"#22c55e", label:"Motorway / Trunk"},
  {keys:["primary"],                                              color:"#84cc16", label:"Primary"},
  {keys:["secondary","tertiary"],                                 color:"#eab308", label:"Secondary / Tertiary"},
  {keys:["residential","living_street"],                          color:"#f97316", label:"Residential"},
  {keys:["service","unclassified","road","track","construction"], color:"#ef4444", label:"Service / Other"},
];
const RQ_COLOR_MAP = {};
RQ.forEach(r => r.keys.forEach(k => { RQ_COLOR_MAP[k] = r.color; }));

// ════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════
let src = null, dst = null, clickMode = null;
let activeOptions  = new Set();
let activeOverlays = new Set();
let currentRoute   = null;
let isFetching     = false;
let learnedWeights = null;
let allTodWeights  = {};  // {morning:{...}, afternoon:{...}, ...}
let fbSessionStart = 0;

// Report-an-issue state
const ISSUE_TYPES = [
  {key:"pothole",        icon:"🕳",  label:"Pothole"},
  {key:"lighting",       icon:"💡",  label:"Broken/No Light"},
  {key:"road_condition", icon:"🛣",  label:"Poor Road"},
  {key:"dead_end",       icon:"🚧",  label:"Dead End"},
  {key:"obstruction",    icon:"⛔",  label:"Obstruction"},
  {key:"crime",          icon:"🚨",  label:"Unsafe / Crime"},
  {key:"flooding",       icon:"🌊",  label:"Flooding"},
  {key:"other",          icon:"❓",  label:"Other"},
];
const SEVERITIES = ["low","medium","high"];
let reportMode        = false;
let reportLatLng       = null;
let reportIssueType    = null;
let reportSeverity     = "medium";

// Feedback state — reset on each open
let fbRatings         = {safety_rating:3, road_rating:3, deadend_rating:3, overall_rating:3};
let fbWouldUseAgain   = null;  // true | false | null
let fbPerceivedDur    = null;

const searchState = {src:{timer:null,results:[],focusIdx:-1}, dst:{timer:null,results:[],focusIdx:-1}};

// ════════════════════════════════════════════
// MAP
// ════════════════════════════════════════════
const map         = L.map("map").setView([12.9716,77.5946],13);
const routeLayer  = L.layerGroup().addTo(map);
const overlayLayerMap = {
  crime:L.layerGroup(), deadendovl:L.layerGroup(), roadquality:L.layerGroup(), reportsovl:L.layerGroup(), newsovl:L.layerGroup()
};
let srcMarker = null, dstMarker = null;
const GREEN_ICON = L.divIcon({className:"",html:"<div style='font-size:20px;line-height:1'>📍</div>",iconAnchor:[10,20]});
const RED_ICON   = L.divIcon({className:"",html:"<div style='font-size:20px;line-height:1'>🏁</div>",iconAnchor:[10,20]});
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(map);

// ════════════════════════════════════════════
// WEIGHT FETCHING
// ════════════════════════════════════════════
function _timeOfDayLabel(h) {
  if(h>=5&&h<12)  return "morning";
  if(h>=12&&h<17) return "afternoon";
  if(h>=17&&h<21) return "evening";
  return "night";
}

function _optionsKey() {
  const k = [...activeOptions].sort().join("+");
  return k || "shortest";
}

async function fetchLearnedWeights() {
  const opts = [...activeOptions].sort().join(",");
  const tod  = _timeOfDayLabel(new Date().getHours());
  const qs   = new URLSearchParams({time_of_day: tod, ...(opts ? {options: opts} : {})});
  try {
    const res = await fetch(`${API}/weights?${qs}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    learnedWeights = await res.json();
    updateWeightsUI(learnedWeights);
  } catch(e) {
    console.warn("Weights fetch failed:", e.message);
    learnedWeights = null;
    document.getElementById("weights-source").textContent = "Using default weights";
  }
}

async function fetchAllTodWeights() {
  const opts = [...activeOptions].sort().join(",");
  const qs   = opts ? new URLSearchParams({options: opts}) : "";
  try {
    const res = await fetch(`${API}/weights/all${qs?"?"+qs:""}`);
    if (!res.ok) throw new Error();
    allTodWeights = await res.json();
    const currentTod = _timeOfDayLabel(new Date().getHours());
    switchTod(currentTod);
    document.getElementById("tod-preview").classList.add("visible");
  } catch(e) {
    allTodWeights = {};
    document.getElementById("tod-preview").classList.remove("visible");
  }
}

function updateWeightsUI(w) {
  const ws   = Math.round((w.w_safety  ||0)*100);
  const wr   = Math.round((w.w_road    ||0)*100);
  const wd   = Math.round((w.w_deadend ||0)*100);
  const wdst = Math.max(0, 100-ws-wr-wd);

  document.getElementById("wb-safety") .style.width = ws   +"%";
  document.getElementById("wb-road")   .style.width = wr   +"%";
  document.getElementById("wb-deadend").style.width = wd   +"%";
  document.getElementById("wb-dist")   .style.width = wdst +"%";
  document.getElementById("weights-bar").classList.add("loaded");

  const srcLabel = w.source === "learned"
    ? `Learned · ${w.based_on} ratings · ${Math.round((w.confidence||0)*100)}% confidence`
    : "Default weights";
  document.getElementById("weights-source").textContent = srcLabel;

  // Breakdown
  document.getElementById("wbd-safety") .style.width = ws+"%";
  document.getElementById("wbd-road")   .style.width = wr+"%";
  document.getElementById("wbd-deadend").style.width = wd+"%";
  document.getElementById("wbp-safety") .textContent = ws+"%";
  document.getElementById("wbp-road")   .textContent = wr+"%";
  document.getElementById("wbp-deadend").textContent = wd+"%";

  // Consistency dots
  const cons = w.consistency || {};
  _setConsistencyDot("wbc-safety",  cons.safety);
  _setConsistencyDot("wbc-road",    cons.road);
  _setConsistencyDot("wbc-deadend", cons.deadend);

  document.getElementById("weight-breakdown").classList.toggle("visible", w.source === "learned");
}

function _setConsistencyDot(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  const v = val ?? 0.5;
  const color = v > 0.7 ? "#22c55e" : v > 0.4 ? "#f59e0b" : "#ef4444";
  el.style.background = color;
  el.title = `Consistency: ${Math.round(v*100)}%`;
}

// Time-of-day preview
let activeTod = "morning";
function switchTod(band) {
  activeTod = band;
  ["morning","afternoon","evening","night"].forEach(b => {
    document.getElementById("tod-"+b).classList.toggle("active", b === band);
  });
  const w = allTodWeights[band] || {};
  document.getElementById("tod-s").textContent = w.w_safety  != null ? Math.round(w.w_safety *100)+"%" : "—";
  document.getElementById("tod-r").textContent = w.w_road    != null ? Math.round(w.w_road   *100)+"%" : "—";
  document.getElementById("tod-d").textContent = w.w_deadend != null ? Math.round(w.w_deadend*100)+"%" : "—";
}

// ════════════════════════════════════════════
// COMPUTE WEIGHTS (blend learned + options)
// ════════════════════════════════════════════
function computeWeights() {
  const key = _optionsKey();
  if (key === "shortest") return {w_safety:0,w_road:0,w_deadend:0,w_distance:1,mode:"shortest"};

  const emphasisMap = {
    safety:  {safety:1.0, road:0.0, deadend:0.0},
    road:    {safety:0.0, road:1.0, deadend:0.0},
    deadend: {safety:0.0, road:0.1, deadend:1.0},
  };
  let es=0,er=0,ed=0;
  for (const opt of activeOptions) {
    const e = emphasisMap[opt];
    es+=e.safety; er+=e.road; ed+=e.deadend;
  }
  const et = es+er+ed||1; es/=et; er/=et; ed/=et;

  if (learnedWeights && learnedWeights.source === "learned") {
    const lw=learnedWeights, b=0.7;
    let ws=b*lw.w_safety+(1-b)*es, wr=b*lw.w_road+(1-b)*er, wd=b*lw.w_deadend+(1-b)*ed;
    const tot=ws+wr+wd||1; ws/=tot; wr/=tot; wd/=tot;
    return {w_safety:+(ws*0.9).toFixed(3),w_road:+(wr*0.9).toFixed(3),w_deadend:+(wd*0.9).toFixed(3),w_distance:0.10,mode:key};
  }
  return {...(FALLBACK_PRESETS[key]||FALLBACK_PRESETS[""]), mode:key};
}

// ════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════
function setStatus(msg,cls="") {
  const el=document.getElementById("status"); el.textContent=msg; el.className="status "+cls;
}
function setFindEnabled() {
  document.getElementById("find-btn").disabled=!(src&&dst);
}
function showConfirmed(f,show) {
  document.getElementById(f+"-confirmed").classList.toggle("show",show);
}
function placePin(f,lat,lon,label) {
  if(f==="src"){src={lat,lon,label};if(srcMarker)map.removeLayer(srcMarker);srcMarker=L.marker([lat,lon],{icon:GREEN_ICON}).addTo(map).bindTooltip(label||"Source");}
  else{dst={lat,lon,label};if(dstMarker)map.removeLayer(dstMarker);dstMarker=L.marker([lat,lon],{icon:RED_ICON}).addTo(map).bindTooltip(label||"Destination");}
  document.getElementById(f+"-input").value=label||`${lat.toFixed(5)},${lon.toFixed(5)}`;
  showConfirmed(f,true);closeDropdown(f);setFindEnabled();map.panTo([lat,lon]);
}
function esc(s){return(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}

// ════════════════════════════════════════════
// MAP CLICK
// ════════════════════════════════════════════
function setClickMode(mode) {
  clickMode=mode;
  document.getElementById("src-btn").classList.toggle("active",mode==="src");
  document.getElementById("dst-btn").classList.toggle("active",mode==="dst");
  setStatus(mode==="src"?"Click map to set source":"Click map to set destination");
}
map.on("click", async e=>{
  if(reportMode){
    const {lat,lng:lon}=e.latlng;
    openReportModal(lat,lon);
    toggleReportMode(false);
    return;
  }
  if(!clickMode)return;
  const {lat,lng:lon}=e.latlng, field=clickMode;
  // Show coordinate instantly, upgrade to human label asynchronously
  placePin(field,lat,lon,`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
  const label=await reverseGeocode(lat,lon);
  placePin(field,lat,lon,label);
  if(field==="src"&&!dst){setClickMode("dst");}
  else{clickMode=null;document.getElementById("src-btn").classList.remove("active");document.getElementById("dst-btn").classList.remove("active");if(src&&dst)setStatus("Ready — tap Find Route","ok");}
});

// ════════════════════════════════════════════
// ADDRESS PARSING  (Bangalore-aware)
// ════════════════════════════════════════════
const TYPE_ICON = {
  hospital:"🏥",school:"🏫",college:"🎓",university:"🎓",
  restaurant:"🍽",cafe:"☕",fast_food:"🍔",bar:"🍺",
  hotel:"🏨",hostel:"🏨",motel:"🏨",supermarket:"🛒",mall:"🏬",shop:"🛍",
  park:"🌳",garden:"🌳",stadium:"🏟",bus_stop:"🚌",metro_station:"🚇",
  railway_station:"🚂",temple:"🛕",mosque:"🕌",church:"⛪",
  pharmacy:"💊",bank:"🏦",atm:"💳",police:"👮",fire_station:"🚒",
  residential:"🏘",suburb:"🏘",neighbourhood:"🏘",road:"🛣",street:"🛣",
  amenity:"📍",default:"📍",
};
function _placeIcon(r){const t=r.type||r.class||"";const a=r.addresstype||"";return TYPE_ICON[t]||TYPE_ICON[a]||TYPE_ICON["default"];}
function _typeLabel(r){
  const map={"residential":"Area","suburb":"Area","neighbourhood":"Locality","quarter":"Locality","city_district":"District","road":"Road","street":"Road","motorway":"Highway","amenity":"Place","shop":"Shop","tourism":"Place","hospital":"Hospital","school":"School","college":"College","university":"University","park":"Park","bus_stop":"Bus Stop","metro_station":"Metro","railway":"Railway"};
  const t=r.type||r.class||r.addresstype||"";
  return map[t]||(t?t.charAt(0).toUpperCase()+t.slice(1).replace(/_/g," "):"Place");
}
function _mainLabel(r){
  const a=r.address||{};const name=r.name||r.display_name?.split(",")[0]?.trim()||"";
  if(name&&!_isAdminName(name))return name;
  return a.neighbourhood||a.quarter||a.suburb||a.village||a.city_district||(a.road?(a.road+(a.suburb?", "+a.suburb:""))  :null)||name||r.display_name?.split(",")[0]?.trim()||"Unknown";
}
function _isAdminName(name){const admin=["bruhat","bbmp","mahanagara","palike","karnataka","india","bangalore urban"];return admin.some(a=>name.toLowerCase().includes(a));}
function _subLabel(r,main){
  const a=r.address||{};
  const candidates=[a.suburb,a.neighbourhood,a.quarter,a.city_district,a.county,a.city||a.town||"Bengaluru"].filter(Boolean).filter(v=>v!==main&&!_isAdminName(v));
  return candidates.filter((v,i)=>candidates.indexOf(v)===i).slice(0,2).join(", ");
}
function _dedup(results){
  const seen=new Set();
  return results.filter(r=>{const lat=parseFloat(r.lat).toFixed(3);const lon=parseFloat(r.lon).toFixed(3);const main=_mainLabel(r).toLowerCase();const key=`${lat},${lon}|${main}`;if(seen.has(key))return false;seen.add(key);return true;});
}
function _highlight(text,query){
  if(!query)return esc(text);
  const eq=query.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  return esc(text).replace(new RegExp(`(${eq})`,"gi"),"<mark>$1</mark>");
}

// ════════════════════════════════════════════
// GEOCODING (progressive fallback)
// ════════════════════════════════════════════
const REVERSE="https://nominatim.openstreetmap.org/reverse";
const BLURU_CENTER=[12.9716,77.5946];
// Recent searches (sessionStorage, max 5 per field)
const RECENT_KEY="sr_recent";
function loadRecent(){try{return JSON.parse(sessionStorage.getItem(RECENT_KEY))||{src:[],dst:[]};}catch(_){return{src:[],dst:[]};}}
function saveRecent(field,item){const r=loadRecent();r[field]=[item,...r[field].filter(x=>x.label!==item.label)].slice(0,5);try{sessionStorage.setItem(RECENT_KEY,JSON.stringify(r));}catch(_){}}
function clearRecent(field){const r=loadRecent();r[field]=[];try{sessionStorage.setItem(RECENT_KEY,JSON.stringify(r));}catch(_){}}
async function geocode(q) {
  const headers={"Accept-Language":"en"};
  const qBlr=/bangalore|bengaluru|blr/i.test(q)?q:`${q}, Bangalore`;
  const url1=`${NOMINATIM}?q=${encodeURIComponent(qBlr)}&format=json&limit=8&viewbox=${BLURU_BOX}&bounded=1&countrycodes=in&addressdetails=1&extratags=1&namedetails=1`;
  let data=await(await fetch(url1,{headers})).json();
  if(data.length<2){
    const url2=`${NOMINATIM}?q=${encodeURIComponent(qBlr)}&format=json&limit=8&viewbox=${BLURU_BOX}&bounded=0&countrycodes=in&addressdetails=1&extratags=1&namedetails=1`;
    const data2=await(await fetch(url2,{headers})).json();
    data=_dedup([...data,...data2]).slice(0,8);
  }else{data=_dedup(data);}
  return data;
}
async function reverseGeocode(lat,lon){
  try{
    const d=await(await fetch(`${REVERSE}?lat=${lat}&lon=${lon}&format=json&zoom=17&addressdetails=1`,{headers:{"Accept-Language":"en"}})).json();
    if(!d?.address)return`${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const a=d.address;const name=d.name||"";const locality=a.neighbourhood||a.suburb||a.quarter||a.city_district||"";
    if(name&&!_isAdminName(name))return locality?`${name}, ${locality}`:name;
    const area=a.city_district||a.county||"Bengaluru";
    return locality?`${locality}, ${area}`:area;
  }catch(_){return`${lat.toFixed(5)}, ${lon.toFixed(5)}`;}
}
function onSearchInput(f) {
  const val=document.getElementById(f+"-input").value.trim(), st=searchState[f];
  st.query=val; showConfirmed(f,false); if(f==="src")src=null;else dst=null; setFindEnabled();
  updateClearBtn(f,val); clearTimeout(st.timer);
  if(val.length<1){showRecents(f);return;}
  if(val.length<2){closeDropdown(f);return;}
  openDropdown(f,'<div class="dd-loading">Searching…</div>');
  st.timer=setTimeout(async()=>{
    try{const r=await geocode(val);st.results=r;st.focusIdx=-1;renderDropdown(f,r,val);}
    catch(_){openDropdown(f,'<div class="dd-none">Search failed — check connection</div>');}
  },300);
}
function onSearchFocus(f){
  const st=searchState[f], val=document.getElementById(f+"-input").value.trim();
  if(val.length>=2&&st.results.length){renderDropdown(f,st.results,val);}
  else if(!val){showRecents(f);}
}
function onSearchKey(e,f) {
  const st=searchState[f], dd=document.getElementById(f+"-dropdown"), items=dd.querySelectorAll(".dd-item");
  if(e.key==="ArrowDown"){e.preventDefault();st.focusIdx=Math.min(st.focusIdx+1,items.length-1);hilite(items,st.focusIdx);}
  else if(e.key==="ArrowUp"){e.preventDefault();st.focusIdx=Math.max(st.focusIdx-1,0);hilite(items,st.focusIdx);}
  else if(e.key==="Enter"){e.preventDefault();if(st.focusIdx>=0&&items[st.focusIdx])items[st.focusIdx].click();else if(st.results.length)selectResult(f,st.results[0]);}
  else if(e.key==="Escape"){closeDropdown(f);document.getElementById(f+"-input").blur();}
}
function hilite(items,idx){items.forEach((el,i)=>el.classList.toggle("focused",i===idx));if(items[idx])items[idx].scrollIntoView({block:"nearest"});}
function renderDropdown(f,results,query="") {
  if(!results||!results.length){
    openDropdown(f,`<div class="dd-no-results"><div class="dd-nr-icon">🔍</div><div class="dd-nr-text">No results in Bangalore</div><div class="dd-nr-hint">Try a neighbourhood, landmark or road name</div></div>`);
    return;
  }
  const html=results.map((r,i)=>{
    const main=_mainLabel(r);const sub=_subLabel(r,main);const icon=_placeIcon(r);const type=_typeLabel(r);const hl=_highlight(main,query);
    return `<div class="dd-item" data-idx="${i}"><span class="dd-item-icon">${icon}</span><span class="dd-item-body"><div class="dd-main">${hl}</div>${sub?`<div class="dd-sub">${esc(sub)}</div>`:""}</span><span class="dd-type">${esc(type)}</span></div>`;
  }).join("");
  openDropdown(f,html);
  dd_bindClicks(f,results);
}
function showRecents(f) {
  const recent=loadRecent()[f];
  if(!recent||!recent.length){closeDropdown(f);return;}
  const rows=recent.map((item,i)=>`<div class="dd-item" data-recent="${i}"><span class="dd-item-icon">🕐</span><span class="dd-item-body"><div class="dd-main">${esc(item.label)}</div>${item.sub?`<div class="dd-sub">${esc(item.sub)}</div>`:""}</span><span class="dd-type">Recent</span></div>`).join("");
  const header=`<div class="dd-section-hd"><span>Recent</span><button onclick="clearRecent('${f}');closeDropdown('${f}')">Clear</button></div>`;
  openDropdown(f,header+rows);
  document.getElementById(f+"-dropdown").querySelectorAll(".dd-item[data-recent]").forEach(el=>{
    el.addEventListener("mousedown",e=>{e.preventDefault();const item=recent[parseInt(el.dataset.recent)];placePin(f,item.lat,item.lon,item.label);});
  });
}
function dd_bindClicks(f,results){
  document.getElementById(f+"-dropdown").querySelectorAll(".dd-item[data-idx]").forEach(el=>{
    el.addEventListener("mousedown",e=>{e.preventDefault();selectResult(f,results[parseInt(el.dataset.idx)]);});
  });
}
function selectResult(f,r) {
  const lat=parseFloat(r.lat),lon=parseFloat(r.lon);
  const main=_mainLabel(r);const sub=_subLabel(r,main);
  const label=main+(sub?", "+sub.split(",")[0]:"");
  placePin(f,lat,lon,label);
  saveRecent(f,{lat,lon,label,sub:sub||""});
  searchState[f].focusIdx=-1;
}
function openDropdown(f,html){const dd=document.getElementById(f+"-dropdown");dd.innerHTML=html;dd.classList.add("open");}
function closeDropdown(f){document.getElementById(f+"-dropdown").classList.remove("open");}
document.addEventListener("mousedown",e=>{
  ["src","dst"].forEach(f=>{const w=document.getElementById(f+"-input").closest(".search-wrap");if(!w.contains(e.target))closeDropdown(f);});
});
function updateClearBtn(f,val){document.getElementById(f+"-clear").classList.toggle("visible",val.length>0);}
function clearField(f){document.getElementById(f+"-input").value="";updateClearBtn(f,"");showConfirmed(f,false);if(f==="src")src=null;else dst=null;searchState[f].results=[];setFindEnabled();closeDropdown(f);document.getElementById(f+"-input").focus();}

// ════════════════════════════════════════════
// ROUTE LABEL
// ════════════════════════════════════════════
function buildLabel() {
  const opts=[...activeOptions];
  if(!opts.length) return {icon:"📏",title:"Shortest Route",color:"#6366f1"};
  if(opts.length===1){const c=OPT[opts[0]];return{icon:c.icon,title:c.label+" Route",color:c.color};}
  return {icon:opts.map(k=>OPT[k].icon).join(" "),title:opts.map(k=>OPT[k].label).join(" + "),color:"#a78bfa"};
}

// ════════════════════════════════════════════
// OPTIONS (guard concurrent fetch)
// ════════════════════════════════════════════
function updateOptionUI() {
  ["safety","road","deadend"].forEach(k=>{document.getElementById("opt-"+k).classList.toggle("active",activeOptions.has(k));});
  const tags=document.getElementById("option-tags");
  if(!activeOptions.size){tags.innerHTML='<span class="tag shortest">📏 Shortest path</span>';}
  else{tags.innerHTML=[...activeOptions].map(k=>`<span class="tag ${k}">${OPT[k].icon} ${OPT[k].label}</span>`).join("");}
}
async function toggleOption(k) {
  if(isFetching) return;
  if(activeOptions.has(k)) activeOptions.delete(k); else activeOptions.add(k);
  updateOptionUI();
  await Promise.all([fetchLearnedWeights(), fetchRoute()]);
}

// ════════════════════════════════════════════
// FIND ROUTES
// ════════════════════════════════════════════
async function findRoutes() {
  if(!src||!dst) return;
  activeOptions.clear(); updateOptionUI();
  Object.values(overlayLayerMap).forEach(l=>{l.clearLayers();map.removeLayer(l);});
  activeOverlays.clear(); updateOverlayButtons(); hideOverlayError();

  const btn=document.getElementById("find-btn");
  btn.innerHTML='<div class="spin"></div> Routing…'; btn.disabled=true;
  setStatus("Finding route…");
  document.getElementById("results-section").style.display="block";
  document.getElementById("empty-state").style.display="none";
  showSkeletonCard();

  // Fetch weights and route in parallel
  await Promise.all([fetchLearnedWeights(), fetchAllTodWeights()]);
  const ok = await fetchRoute();

  if(!ok){document.getElementById("results-section").style.display="none";document.getElementById("empty-state").style.display="block";}
  else{setStatus("Route found","ok");}
  btn.innerHTML="Find Route"; btn.disabled=!(src&&dst);
}

// ════════════════════════════════════════════
// SKELETON / FETCH ROUTE
// ════════════════════════════════════════════
function showSkeletonCard() {
  ["rc-dist","rc-eta","rc-safety"].forEach(id=>{const el=document.getElementById(id);el.textContent="\u00a0\u00a0\u00a0\u00a0\u00a0";el.classList.add("skeleton");el.classList.remove("updating");});
}
function clearSkeletonCard() {
  ["rc-dist","rc-eta","rc-safety"].forEach(id=>document.getElementById(id).classList.remove("skeleton"));
}

async function fetchRoute() {
  if(!src||!dst||isFetching) return false;
  isFetching=true; startRecalcBar();
  if(!document.getElementById("rc-dist").classList.contains("skeleton")) showSkeletonCard();
  const w=computeWeights();
  try{
    const res=await fetch(`${API}/route`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({source:src,destination:dst,hour:new Date().getHours(),...w})});
    if(!res.ok) throw new Error("Server "+res.status);
    const data=await res.json();
    if(data.error) throw new Error(data.error);
    currentRoute=data; clearSkeletonCard(); updateRouteCard(data); drawRoute(data);
    for(const key of activeOverlays) await loadOverlay(key);
    return true;
  }catch(err){
    setStatus("Route failed: "+err.message,"error"); clearSkeletonCard(); return false;
  }finally{
    isFetching=false; finishRecalcBar();
  }
}

function updateRouteCard(geojson) {
  const p=geojson?.features?.[0]?.properties||{}, lbl=buildLabel();
  document.getElementById("rc-icon").textContent=lbl.icon;
  document.getElementById("rc-title").textContent=lbl.title;
  document.getElementById("rc-badge").style.background=lbl.color;
  document.getElementById("route-card").style.borderLeftColor=lbl.color;
  const dist=p.distance_km??null, eta=dist!==null?Math.round((dist/20)*60):null, saf=p.safety_pct??null;
  const dEl=document.getElementById("rc-dist"),eEl=document.getElementById("rc-eta"),sEl=document.getElementById("rc-safety");
  dEl.textContent=dist!==null?dist+" km":"—"; eEl.textContent=eta!==null?eta+" min":"—"; sEl.textContent=saf!==null?saf+"%":"—";
  [dEl,eEl,sEl].forEach(el=>{el.classList.add("updating");setTimeout(()=>el.classList.remove("updating"),700);});
}
function startRecalcBar(){const b=document.getElementById("recalc-bar");b.classList.remove("active");void b.offsetWidth;b.classList.add("active");}
function finishRecalcBar(){setTimeout(()=>document.getElementById("recalc-bar").classList.remove("active"),800);}

function drawRoute(geojson) {
  routeLayer.clearLayers();
  if(!geojson?.features?.[0]) return;
  const lbl=buildLabel();
  const layer=L.geoJSON(geojson,{style:{color:lbl.color,weight:6,opacity:.9}}).addTo(routeLayer);
  try{map.fitBounds(layer.getBounds(),{padding:[60,60]});}catch(_){}
}

// ════════════════════════════════════════════
// OVERLAYS
// ════════════════════════════════════════════
function extractCoords(geojson) {
  const geom=geojson?.features?.[0]?.geometry;if(!geom)return[];
  const raw=geom.type==="LineString"?geom.coordinates:geom.type==="MultiLineString"?geom.coordinates.flat():[];
  return raw.map(([lon,lat])=>[lat,lon]);
}
async function toggleOverlay(key) {
  if(activeOverlays.has(key)){
    activeOverlays.delete(key);overlayLayerMap[key].clearLayers();map.removeLayer(overlayLayerMap[key]);
    document.getElementById("ovl-"+key).classList.remove("active");
    if(key==="roadquality")document.getElementById("rq-legend").style.display="none";
    hideOverlayError();
  }else{
    activeOverlays.add(key);overlayLayerMap[key].addTo(map);
    document.getElementById("ovl-"+key).classList.add("active");
    await loadOverlay(key);
  }
}
async function loadOverlay(key) {
  if(!currentRoute)return;
  const coords=extractCoords(currentRoute);if(!coords.length)return;
  const btn=document.getElementById("ovl-"+key);btn.classList.add("loading");btn.classList.remove("error-state");hideOverlayError();
  const endpoints={crime:`${API}/crime/route`,deadendovl:`${API}/deadends/route`,roadquality:`${API}/roadquality/route`,reportsovl:`${API}/reports/route`,newsovl:`${API}/news/route`};
  try{
    const res=await fetch(endpoints[key],{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({coords})});
    if(!res.ok)throw new Error("HTTP "+res.status);
    renderOverlay(key,await res.json());
  }catch(e){
    console.error("Overlay failed:",e);btn.classList.add("error-state");showOverlayError(esc(key)+" overlay failed to load");
  }finally{btn.classList.remove("loading");}
}
function showOverlayError(msg){const el=document.getElementById("ovl-error-msg");el.textContent=msg;el.classList.add("show");}
function hideOverlayError(){document.getElementById("ovl-error-msg").classList.remove("show");}
function renderOverlay(key,data) {
  overlayLayerMap[key].clearLayers();
  if(key==="crime"){(data.points||[]).forEach(p=>{L.circleMarker([p.lat,p.lon],{radius:9,color:"#ef4444",fillColor:"#ef4444",fillOpacity:.35,weight:1.5}).addTo(overlayLayerMap[key]).bindTooltip("🚨 Crime hotspot",{sticky:true});});}
  if(key==="deadendovl"){const icon=L.divIcon({className:"",html:"<div style='font-size:14px;line-height:1'>⚠️</div>",iconAnchor:[7,7]});(data.points||[]).forEach(p=>{L.marker([p.lat,p.lon],{icon}).addTo(overlayLayerMap[key]).bindTooltip("🚫 Dead end",{sticky:true});});}
  if(key==="roadquality"){(data.segments||[]).forEach(seg=>{const color=RQ_COLOR_MAP[seg.highway]||"#94a3b8";try{L.geoJSON(JSON.parse(seg.geometry),{style:{color,weight:4,opacity:.8}}).addTo(overlayLayerMap[key]).bindTooltip("🛣 "+esc(seg.highway||"unknown"),{sticky:true});}catch(_){}});document.getElementById("rq-legend").style.display="block";}
  if(key==="reportsovl"){
    (data.reports||[]).forEach(r=>{
      const meta=ISSUE_TYPES.find(t=>t.key===r.issue_type)||{icon:"📢",label:r.issue_type};
      const sevColor={low:"#22c55e",medium:"#f59e0b",high:"#ef4444"}[r.severity]||"#818cf8";
      const icon=L.divIcon({className:"",html:`<div style="font-size:16px;line-height:1;filter:drop-shadow(0 0 2px ${sevColor})">${meta.icon}</div>`,iconAnchor:[8,8]});
      const when=new Date(r.reported_at).toLocaleDateString();
      const desc=r.description?`<br/><i>${esc(r.description)}</i>`:"";
      L.marker([r.lat,r.lon],{icon}).addTo(overlayLayerMap[key])
        .bindTooltip(`${meta.icon} ${esc(meta.label)} · ${esc(r.severity)}${desc}<br/><span style="opacity:.6">reported ${when}</span>`,{sticky:true});
    });
  }
  if(key==="newsovl"){
    (data.articles||[]).forEach(a=>{
      if(a.lat==null||a.lon==null)return;
      const sevColor={low:"#f59e0b",medium:"#f97316",high:"#ef4444"}[a.severity]||"#ef4444";
      const icon=L.divIcon({className:"",html:`<div style="font-size:15px;line-height:1;filter:drop-shadow(0 0 3px ${sevColor})">📰</div>`,iconAnchor:[8,8]});
      const when=a.published_at?new Date(a.published_at).toLocaleDateString():"unknown date";
      const src=a.source?` · ${esc(a.source)}`:"";
      const link=a.url?`<br/><a href="${a.url}" target="_blank" rel="noopener" style="color:#93c5fd">read article</a>`:"";
      L.marker([a.lat,a.lon],{icon}).addTo(overlayLayerMap[key])
        .bindTooltip(`📰 ${esc(a.headline)}<br/><span style="opacity:.65">${esc(a.crime_type)} · ${when}${src}</span>${link}`,{sticky:true});
    });
  }
}
function updateOverlayButtons(){["crime","deadendovl","roadquality","reportsovl","newsovl"].forEach(k=>{document.getElementById("ovl-"+k).classList.toggle("active",activeOverlays.has(k));});}

// ════════════════════════════════════════════
// LIVE NEWS FEED STATUS BADGE
// ════════════════════════════════════════════
async function fetchNewsStatus() {
  const el = document.getElementById("news-feed-badge");
  if (!el) return;
  try {
    const res = await fetch(`${API}/news/status`);
    const s = await res.json();
    if (!s.auto_refresh_enabled) {
      el.textContent = "📰 Live crime feed: disabled (no NEWS_API_KEY)";
      el.className = "news-feed-badge off";
      return;
    }
    if (!s.last_fetched_at) {
      el.textContent = "📰 Live crime feed: enabled, first fetch pending…";
      el.className = "news-feed-badge stale";
      return;
    }
    const mins = Math.round((Date.now() - new Date(s.last_fetched_at).getTime()) / 60000);
    const ago = mins < 60 ? `${mins}m ago` : `${Math.round(mins/60)}h ago`;
    el.textContent = `📰 Live crime feed: updated ${ago} · ${s.total_articles} articles`;
    el.className = "news-feed-badge " + (mins < 240 ? "live" : "stale");
  } catch (_) {
    el.textContent = "📰 Live crime feed: unavailable";
    el.className = "news-feed-badge off";
  }
}

// ════════════════════════════════════════════
// RESET
// ════════════════════════════════════════════
function resetAll() {
  src=null;dst=null;clickMode=null;activeOptions.clear();activeOverlays.clear();currentRoute=null;isFetching=false;learnedWeights=null;allTodWeights={};
  ["src","dst"].forEach(f=>{document.getElementById(f+"-input").value="";document.getElementById(f+"-btn").classList.remove("active");closeDropdown(f);showConfirmed(f,false);searchState[f].results=[];searchState[f].focusIdx=-1;});
  document.getElementById("results-section").style.display="none";document.getElementById("empty-state").style.display="block";
  setStatus("");setFindEnabled();routeLayer.clearLayers();
  Object.values(overlayLayerMap).forEach(l=>{l.clearLayers();map.removeLayer(l);});
  if(srcMarker){map.removeLayer(srcMarker);srcMarker=null;}if(dstMarker){map.removeLayer(dstMarker);dstMarker=null;}
  updateOptionUI();updateOverlayButtons();
  document.getElementById("rq-legend").style.display="none";hideOverlayError();
  document.getElementById("weights-bar").classList.remove("loaded");
  document.getElementById("weights-source").textContent="";
  document.getElementById("weight-breakdown").classList.remove("visible");
  document.getElementById("tod-preview").classList.remove("visible");
}

// ════════════════════════════════════════════
// FEEDBACK MODAL
// ════════════════════════════════════════════
function buildStars(gid) {
  const g=document.getElementById(gid), k=g.dataset.key; g.innerHTML="";
  for(let i=1;i<=5;i++){const s=document.createElement("span");s.className="star";s.textContent=i<=fbRatings[k]?"★":"☆";s.onclick=()=>{fbRatings[k]=i;buildStars(gid);};g.appendChild(s);}
}
function setReuse(val) {
  fbWouldUseAgain = val;
  document.getElementById("reuse-yes").classList.toggle("active", val === true);
  document.getElementById("reuse-no") .classList.toggle("active", val === false);
}
function setDuration(val) {
  fbPerceivedDur = val;
  ["faster","as","slower"].forEach(k=>{
    const id="dur-"+k;
    const map2={"faster":"faster_than_expected","as":"as_expected","slower":"slower_than_expected"};
    document.getElementById(id).classList.toggle("active", map2[k]===val);
  });
}

function openFeedback() {
  if(!src||!dst||!currentRoute) return;
  // Reset all state
  fbRatings = {safety_rating:3, road_rating:3, deadend_rating:3, overall_rating:3};
  fbWouldUseAgain = null; fbPerceivedDur = null; fbSessionStart = Date.now();
  buildStars("stars-safety"); buildStars("stars-road"); buildStars("stars-deadend"); buildStars("stars-overall");
  document.getElementById("reuse-yes").classList.remove("active");
  document.getElementById("reuse-no") .classList.remove("active");
  ["dur-faster","dur-as","dur-slower"].forEach(id=>document.getElementById(id).classList.remove("active"));
  document.getElementById("fb-comments").value = "";
  // Show which options were active in subtitle
  const opts = [...activeOptions];
  const label = opts.length ? opts.map(k=>OPT[k].label).join(" + ")+" route" : "shortest route";
  document.getElementById("fb-subtitle").textContent = "Rating your " + label;
  document.getElementById("fb-overlay").style.display="flex";
}
function closeFeedback() {document.getElementById("fb-overlay").style.display="none";}

async function submitFeedback() {
  const props      = currentRoute?.features?.[0]?.properties||{};
  const hour       = new Date().getHours();
  const ratingMs   = Date.now() - fbSessionStart;

  const payload = {
    // Location
    src_lat: src.lat, src_lon: src.lon,
    dst_lat: dst.lat, dst_lon: dst.lon,
    // Route identity
    route_options:  _optionsKey(),
    route_length:   props.distance_km ?? null,
    trip_duration:  props.eta_min     ?? null,
    time_of_day:    _timeOfDayLabel(hour),
    // Ratings
    ...fbRatings,
    would_use_again:   fbWouldUseAgain,
    perceived_duration:fbPerceivedDur,
    // Session metadata
    rating_duration_s: Math.round(ratingMs / 1000),
    device_type:       "web",
    comments:          document.getElementById("fb-comments").value.trim() || null,
  };

  try{
    const res=await fetch(`${API}/feedback`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    if(!res.ok) throw new Error("HTTP "+res.status);
    closeFeedback(); setStatus("Thank you! ✓","ok");
    // Refresh weights — the model just got smarter
    await Promise.all([fetchLearnedWeights(), fetchAllTodWeights()]);
  }catch(e){
    alert("Submission failed: "+e.message);
  }
}

// ════════════════════════════════════════════
// REPORT AN ISSUE
// ════════════════════════════════════════════
function buildIssueTypeGrid() {
  const g = document.getElementById("issue-type-grid");
  g.innerHTML = ISSUE_TYPES.map(t =>
    `<button type="button" class="issue-type-btn${t.key===reportIssueType?" active":""}" data-key="${t.key}" onclick="setIssueType('${t.key}')">${t.icon} ${esc(t.label)}</button>`
  ).join("");
}
function setIssueType(key) {
  reportIssueType = key;
  document.querySelectorAll("#issue-type-grid .issue-type-btn").forEach(el=>{
    el.classList.toggle("active", el.dataset.key===key);
  });
}
function buildSeverityRow() {
  const g = document.getElementById("severity-row");
  g.innerHTML = SEVERITIES.map(s =>
    `<button type="button" class="severity-btn ${s}${s===reportSeverity?" active":""}" data-key="${s}" onclick="setSeverity('${s}')">${s}</button>`
  ).join("");
}
function setSeverity(key) {
  reportSeverity = key;
  document.querySelectorAll("#severity-row .severity-btn").forEach(el=>{
    el.classList.toggle("active", el.dataset.key===key);
  });
}

function toggleReportMode(force) {
  reportMode = (force !== undefined) ? force : !reportMode;
  const fab = document.getElementById("report-fab");
  fab.classList.toggle("active", reportMode);
  document.getElementById("report-fab-label").textContent = reportMode ? "Tap map…" : "Report Issue";
  document.getElementById("report-fab-icon").textContent  = reportMode ? "✕" : "📢";
  document.getElementById("report-hint").classList.toggle("show", reportMode);
  // Reporting a location takes priority — cancel source/destination pin mode.
  if (reportMode) { clickMode = null; document.getElementById("src-btn").classList.remove("active"); document.getElementById("dst-btn").classList.remove("active"); }
}

function openReportModal(lat, lon) {
  reportLatLng = {lat, lon};
  reportIssueType = null;
  reportSeverity = "medium";
  document.getElementById("report-coords").textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  document.getElementById("report-description").value = "";
  buildIssueTypeGrid();
  buildSeverityRow();
  document.getElementById("report-overlay").style.display = "flex";
}
function closeReportModal() {
  document.getElementById("report-overlay").style.display = "none";
}

async function submitReport() {
  if (!reportLatLng) return;
  if (!reportIssueType) { alert("Pick an issue type first."); return; }

  const payload = {
    latitude:    reportLatLng.lat,
    longitude:   reportLatLng.lon,
    issue_type:  reportIssueType,
    severity:    reportSeverity,
    description: document.getElementById("report-description").value.trim() || null,
    device_type: "web",
  };

  try {
    const res = await fetch(`${API}/report`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ("HTTP "+res.status));
    closeReportModal();
    setStatus(data.snapped_to_road ? "Report submitted — linked to nearest road ✓" : "Report submitted ✓ (too far from a mapped road to affect routing)", "ok");
    // If the Reports overlay is on, refresh it so the new pin shows up.
    if (activeOverlays.has("reportsovl")) await loadOverlay("reportsovl");
  } catch(e) {
    alert("Submission failed: " + e.message);
  }
}

// ════════════════════════════════════════════
// INIT (build road legend once)
// ════════════════════════════════════════════
(function init() {
  document.getElementById("legend-grid").innerHTML = RQ.map(r=>`
    <div class="legend-item"><div class="legend-dot" style="background:${r.color}"></div><span>${r.label}</span></div>
  `).join("");
  updateOptionUI();
  updateOverlayButtons();
  fetchLearnedWeights();
  fetchNewsStatus();
  setInterval(fetchNewsStatus, 5 * 60 * 1000); // keep the badge fresh
})();
