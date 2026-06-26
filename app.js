/* PDF Keyword Scanner — extract-only, evidence-linked, never invents values.
   All processing is client-side. Text comes only from the uploaded PDFs. */
(() => {
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

// ---------- built-in electrical synonym dictionary ----------
// Keyed loosely; if a keyword (or one of its words) matches a key OR a value,
// the whole cluster becomes search terms (typed as "synonym").
const DOMAIN_CLUSTERS = [
  ['low voltage','lv','low voltage distribution','lv distribution','lv distribution system','lv equipment','lv switchgear','lv panel','400v','415v','230v'],
  ['switchboard','switchgear','lv switchboard','main switchboard','msb','distribution board','panel board'],
  ['panelboard','panelboards','distribution board','distribution boards','db','sub-distribution board','sub db','panels','consumer unit'],
  ['ats','automatic transfer switch','transfer switch','changeover switch','change-over switch','generator transfer','normal supply','essential supply','standby supply','source transfer'],
  ['surge arrestor','surge arrester','surge protection device','spd','surge protection','transient protection'],
  ['metering','meter','meters','kwh meter','energy meter','ct metering','sub-metering','sub metering','check meter'],
  ['life safety','life-safety','emergency','emergency supply','fire alarm','essential services','life safety systems'],
  ['generator','genset','standby generator','diesel generator','emergency generator','backup generator'],
  ['mccb','mcb','acb','circuit breaker','moulded case circuit breaker','air circuit breaker','protective device'],
  ['busbar','bus bar','busway','busduct','rising main'],
  ['earthing','grounding','earth','bonding','earth bar'],
  ['ups','uninterruptible power supply','battery backup'],
  ['cable','cabling','wiring','swa','xlpe','feeder','sub-main','submain'],
];

// ---------- state ----------
const state = {
  pdfs: [],          // {id,name,size,numPages,doc,pages:[{n,text,lines:[]}]}
  matchesByKw: [],   // [{kw, matches:[...]}]
  view: { fileId:null, page:1, scale:1.2, terms:[] },
};
let pdfSeq = 0;

// ---------- dom ----------
const $ = s => document.querySelector(s);
const el = (tag, cls, html) => { const n=document.createElement(tag); if(cls)n.className=cls; if(html!=null)n.innerHTML=html; return n; };
const esc = s => (s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function toast(msg, type){
  const t=$('#toast'); t.className='toast'+(type?(' '+type):''); t.textContent=msg; t.hidden=false;
  clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true,3600);
}

// ================= PDF loading & extraction =================
async function addFiles(fileList){
  let autoOpen=true;   // open the first uploaded PDF in the viewer as soon as it's ready
  for(const file of fileList){
    if(!/\.pdf$/i.test(file.name) && file.type!=='application/pdf'){ toast(`Skipped ${file.name} (not a PDF)`,'warn'); continue; }
    const id = 'pdf'+(++pdfSeq);
    const rec = { id, name:file.name, file, size:file.size, numPages:0, doc:null, pages:[], status:'loading' };
    state.pdfs.push(rec);
    renderLibrary();
    try{
      const buf = await file.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data:buf }).promise;
      rec.doc = doc; rec.numPages = doc.numPages;
      for(let p=1; p<=doc.numPages; p++){
        const page = await doc.getPage(p);
        const lines = await extractLines(page);
        rec.pages.push({ n:p, lines, text:lines.join('\n') });
      }
      rec.status='ready';
    }catch(e){
      rec.status='error'; console.error(e);
      toast(`Could not read ${file.name}`,'err');
    }
    renderLibrary();
    if(autoOpen && rec.status==='ready'){ autoOpen=false; openViewer(rec.id, 1, []); }
  }
  refreshScanButton();
  // auto-scan the moment uploads finish extracting (if keywords are set)
  if(state.pdfs.some(p=>p.status==='ready') && parseKeywordSpecs().length) scan();
}

// Reconstruct visual lines from PDF text items (group by y, order by x).
async function extractLines(page){
  const tc = await page.getTextContent();
  const rows = new Map(); // yKey -> [{x,str}]
  for(const it of tc.items){
    if(!it.str) continue;
    const y = Math.round(it.transform[5]);
    const x = it.transform[4];
    // merge near-equal y into buckets of 2px
    let key = y; if(!rows.has(key)){ for(const k of rows.keys()){ if(Math.abs(k-y)<=2){ key=k; break; } } }
    if(!rows.has(key)) rows.set(key,[]);
    rows.get(key).push({x, str:it.str});
  }
  const ys=[...rows.keys()].sort((a,b)=>b-a); // top→bottom (PDF y grows upward)
  const lines=[];
  for(const y of ys){
    const parts=rows.get(y).sort((a,b)=>a.x-b.x);
    // join, inserting a gap marker where x jumps a lot (column gap → likely table)
    let line=''; let prevEnd=null;
    for(const part of parts){
      if(prevEnd!=null && part.x-prevEnd>18) line+='   '; // wide gap = column separator
      else if(line && !line.endsWith(' ') && !part.str.startsWith(' ')) line+=' ';
      line+=part.str; prevEnd=part.x;
    }
    line=line.replace(/[ \t]{4,}/g,'   ').trim();
    if(line) lines.push(line);
  }
  return lines;
}

// ================= keyword / alias / synonym resolution =================
function parseKeywords(){
  return $('#keywords').value.split('\n').map(s=>s.trim()).filter(Boolean);
}
// A keyword line may be a fallback chain: "Preferred > Fallback > …".
// Tiers are searched in order; only the first tier that finds anything is used.
function parseKeywordSpecs(){
  return parseKeywords().map(line=>{
    const tiers=line.split(/\s*>+\s*/).map(s=>s.trim()).filter(Boolean);
    return { raw:line, tiers, primary:tiers[0] };
  });
}
// alias lines: "A = B / C / D"  -> cluster [A,B,C,D]
function parseAliasClusters(){
  return $('#aliases').value.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{
    const [lhs,rhs] = l.split('=');
    const members=[lhs, ...(rhs?rhs.split(/[\/,]/):[])].map(s=>(s||'').trim()).filter(Boolean);
    return members;
  }).filter(c=>c.length>=2);
}

// Build the list of search terms for a keyword: {term, type}
function expandKeyword(kw, aliasClusters, useDomain){
  const seen=new Map(); // lower -> type (keep strongest)
  const rank={exact:3,alias:2,syn:1};
  const add=(t,type)=>{ t=t.trim(); if(!t) return; const k=t.toLowerCase();
    if(!seen.has(k) || rank[type]>rank[seen.get(k).type]) seen.set(k,{term:t,type}); };
  add(kw,'exact');
  const kl=kw.toLowerCase();
  // user aliases
  for(const cl of aliasClusters){
    if(cl.some(m=>m.toLowerCase()===kl || m.toLowerCase().includes(kl) || kl.includes(m.toLowerCase())))
      cl.forEach(m=>add(m, m.toLowerCase()===kl?'exact':'alias'));
  }
  // built-in domain synonyms
  if(useDomain){
    for(const cl of DOMAIN_CLUSTERS){
      if(cl.some(m=> kl===m || kl.includes(m) || m.includes(kl)))
        cl.forEach(m=>add(m,'syn'));
    }
  }
  return [...seen.values()];
}

function termRegex(term){
  const esc=term.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+');
  const sB=/\w/.test(term[0])?'\\b':'';
  const eB=/\w/.test(term[term.length-1])?'\\b':'';
  return new RegExp(sB+esc+eB,'gi');
}

// ================= scanning =================
const RANK={exact:3,alias:2,syn:1};
const TAG_RE=/\b[A-Z]{2,5}[- ]?\d{1,3}(?:[-/.]\d{1,3})?\b/g;
function isTabular(line){
  const cols=line.split(/ {3,}|\t/).filter(Boolean);
  const nums=(line.match(/\d/g)||[]).length;
  return cols.length>=3 || (cols.length>=2 && nums>=3) || /\b[A-Z]{2,5}-?\d/.test(line);
}

// Produce spelling variants of a term by substituting alias equivalents in place
// (e.g. "Low Voltage Distribution" + {LV=Low Voltage} -> also "LV Distribution").
function aliasVariants(term, clusters){
  const variants=new Map([[term.toLowerCase(),{term,type:'exact'}]]);
  for(const cl of clusters){
    for(const member of cl){
      let re; try{ re=termRegex(member); }catch{ continue; }
      for(const {term:v} of [...variants.values()]){
        re.lastIndex=0;
        if(re.test(v)){
          for(const other of cl){ if(other.toLowerCase()===member.toLowerCase()) continue;
            const nv=v.replace(termRegex(member), other);
            if(!variants.has(nv.toLowerCase())) variants.set(nv.toLowerCase(),{term:nv,type:'alias'}); }
        }
      }
    }
    if(variants.size>14) break;
  }
  return [...variants.values()];
}

// Run a set of {term,type,re} matchers over every ready PDF -> raw matches.
function searchWithRegexes(regexes, ready){
  const out=[];
  for(const pdf of ready){
    for(const page of pdf.pages){
      const lines=page.lines;
      for(let i=0;i<lines.length;i++){
        let quote=lines[i];
        if(quote.length<55 && lines[i+1]) quote=quote+' '+lines[i+1];
        const hitTerms=[]; let bestType='syn';
        for(const r of regexes){ r.re.lastIndex=0; if(r.re.test(quote)){ hitTerms.push(r.term); if(RANK[r.type]>RANK[bestType])bestType=r.type; } }
        if(!hitTerms.length) continue;
        // richer context for AI extraction: this clause + following lines (standard/bullet lists
        // often follow "…shall be provided to the following:"), stop at the next sub-clause heading
        let ctx=lines[i], k=i+1;
        while(k<lines.length && ctx.length<700){ const nx=lines[k]||''; if(/^\d+(?:\.\d+){2,}\s/.test(nx) && ctx.length>150) break; ctx+=' '+nx; k++; }
        ctx=ctx.replace(/\s+/g,' ').trim().slice(0,800);
        const tags=[...new Set((quote.match(TAG_RE)||[]))].slice(0,6);
        const tabular=isTabular(lines[i]);
        let conf={exact:.95,alias:.8,syn:.65}[bestType]; if(tabular)conf=Math.min(.98,conf+.03);
        out.push({ fileId:pdf.id, file:pdf.name, page:page.n, quote:quote.trim(), context:ctx,
          terms:[...new Set(hitTerms)], type:bestType, tabular, tags, conf });
      }
    }
  }
  return out;
}

// Tidy a raw line into a readable finding sentence.
function cleanQuote(q){
  let t=q.replace(/\.{3,}/g,' ').replace(/[ \t]{2,}/g,' ').trim();
  const stripped=t.replace(/^[•·•\-\*–—\)\(\.\d\s]{1,14}/,'').trim();
  if(stripped.length>=8) t=stripped;
  return t;
}
const normKey = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const isTocLine = q => /\.{4,}/.test(q);

// Best-effort extraction of switchgear spec values from a matched clause.
// Every field returns '' when not present — never invents a value.
function extractSpecs(t){
  t=t||''; const first=re=>{ const m=t.match(re); return m?(m[1]||m[0]).trim():''; };
  let qty=first(/\b(\d{1,4})\s*(?:no\.?|nr\.?|off|sets?|units?)\b/i);
  if(!qty) qty=first(/\b(\d{1,4})\s*[x×]\b/i);
  const amps=first(/\b(\d{2,5})\s?A\b/);                 // amps (the 'k' in 50kA blocks a false hit)
  const kA=first(/\b(\d{1,3})\s?kA\b/i);
  let voltage=''; const vm=t.match(/\b(\d{1,4})\s?(kV|V)\b/i); if(vm) voltage=vm[1]+(vm[2].toLowerCase()==='kv'?'kV':'V');
  const ip=first(/\bIP\s?\d{2}[A-Zx]?\b/i);
  let form=''; const fm=t.match(/\bForm\s?(\d[a-z]?)\b(?:\s*Type\s*(\d[a-z]?))?/i); if(fm) form='Form '+fm[1]+(fm[2]?' Type '+fm[2]:'');
  const phase=first(/\b(?:TP\s?&?\s?N|TPN|SP\s?&?\s?N|SPN|(?:3|three)\s?-?\s?phase|(?:1|single)\s?-?\s?phase|3ph|1ph)\b/i);
  return { qty, amps, kA, voltage, ip, form, phase };
}

// Detect standards / codes verbatim (BS EN 61439-1:2021, IEC 60947-6-1, ISO 9001,
// CIBSE TM39:2009, MID, …). Deterministic — only what's actually written.
function extractStandards(t){
  t=t||''; const out=new Set();
  const add=s=>{ s=s.replace(/\s+/g,' ').trim().replace(/[.,;:]$/,''); if(s.length>=4) out.add(s); };
  // BS / EN / IEC / ISO / IEEE / NFPA designations, incl. BS EN IEC and BS ISO, with part + year (+ amendment)
  const re=/\b(?:BS\s?EN\s?IEC|BS\s?EN|BS\s?ISO|BS|EN|IEC|ISO|IEEE|NFPA)\s?\d{2,5}(?:[-‑]\d+){0,3}(?::\d{4})?(?:\s*\((?:Amendment|Amd|Am)[^)]*\))?(?:\s*Category\s*\d+[A-Za-z]?)?/gi;
  let m; while((m=re.exec(t))!==null){ add(m[0]); }
  // CIBSE codes (TM39:2009, LG7 (2023), SLL Code for Lighting (2022))
  const re2=/\bCIBSE(?:\s+(?:TM|LG|SLL|AM)[\s\w]*?\d{2,4}|\s+(?:SLL\s+)?Code[\s\w]*?\(\d{4}\))/gi;
  while((m=re2.exec(t))!==null){ add(m[0]); }
  // BS 7671 18th Edition phrasing
  const re3=/\bBS\s?7671:?\s?\d{4}(?:\s*\d{1,2}(?:st|nd|rd|th)\s*Edition)?(?:\s*\((?:Amendment|Amd)[^)]*\))?/gi;
  while((m=re3.exec(t))!==null){ add(m[0]); }
  // utilisation category (AC33A etc.), insulation class, MID
  (t.match(/\b(?:AC|DC)\d{2}[A-Z]?\b/g)||[]).forEach(add);
  if(/\bMID\b/.test(t)||/Measuring Instruments Directive/i.test(t)) add('MID (Measuring Instruments Directive)');
  return [...out].slice(0,14);
}

// Group raw matches into DISTINCT findings: dedupe identical text, merge
// near-duplicates (one contained in another), and combine their source refs.
function buildFindings(matches){
  const byKey=new Map();
  for(const m of matches){
    const clean=cleanQuote(m.quote); const key=normKey(clean); if(!key) continue;
    if(!byKey.has(key)) byKey.set(key,{ text:clean, key, context:m.context||clean, terms:new Set(), type:m.type, tabular:m.tabular,
      toc:isTocLine(m.quote), tags:new Set(), conf:m.conf, sources:new Map() });
    const f=byKey.get(key);
    m.terms.forEach(t=>f.terms.add(t)); m.tags.forEach(t=>f.tags.add(t));
    if(RANK[m.type]>RANK[f.type]) f.type=m.type;
    if(m.tabular) f.tabular=true; f.conf=Math.max(f.conf,m.conf);
    if(clean.length>f.text.length) f.text=clean;
    if((m.context||'').length>(f.context||'').length) f.context=m.context;
    const sk=m.fileId+'|'+m.page; if(!f.sources.has(sk)) f.sources.set(sk,{fileId:m.fileId,file:m.file,page:m.page});
  }
  // merge a finding whose normalised text is contained in a longer one
  let findings=[...byKey.values()].sort((a,b)=>b.key.length-a.key.length);
  const kept=[];
  for(const f of findings){
    const host=kept.find(k=>k.key.includes(f.key) && f.key.length>=10);
    if(host){ f.terms.forEach(t=>host.terms.add(t)); f.tags.forEach(t=>host.tags.add(t));
      for(const [sk,v] of f.sources) host.sources.set(sk,v);
      if((f.context||'').length>(host.context||'').length) host.context=f.context;
      if(RANK[f.type]>RANK[host.type]) host.type=f.type; if(f.tabular)host.tabular=true; continue; }
    kept.push(f);
  }
  // drop contents-page (TOC) entries if real content findings exist
  const hasContent=kept.some(f=>!f.toc);
  let out=hasContent?kept.filter(f=>!f.toc):kept;
  out.forEach(f=>{ f.terms=[...f.terms]; f.tags=[...f.tags].slice(0,6);
    f.specs=extractSpecs(f.text); f.standards=extractStandards(f.context||f.text);
    f.sourceList=[...f.sources.values()].sort((a,b)=>a.file.localeCompare(b.file)||a.page-b.page); delete f.sources; delete f.key; });
  // chronological: order findings by the earliest page they appear on (TOC entries last)
  const pg=f=> f.sourceList.length ? Math.min(...f.sourceList.map(s=>s.page)) : Infinity;
  out.sort((a,b)=> (a.toc-b.toc) || pg(a)-pg(b) || b.conf-a.conf);
  return out;
}

function scan(){
  const ready=state.pdfs.filter(p=>p.status==='ready');
  if(!ready.length){ toast('Add at least one readable PDF first','warn'); return; }
  const specs=parseKeywordSpecs();
  if(!specs.length){ toast('Enter at least one keyword','warn'); return; }
  const aliasClusters=parseAliasClusters();
  const useDomain=$('#useDomain').checked;

  state.matchesByKw = specs.map(spec=>{
    let matches=[], usedTier=spec.tiers[0];
    if(spec.tiers.length>1){
      // FALLBACK CHAIN: try each tier in order; stop at the first that finds anything.
      for(const tier of spec.tiers){
        const rxs=aliasVariants(tier,aliasClusters).map(e=>({...e, re:termRegex(e.term)}));
        const m=searchWithRegexes(rxs,ready);
        if(m.length){ usedTier=tier; matches=m; break; }
      }
    }else{
      const exp=expandKeyword(spec.tiers[0],aliasClusters,useDomain);
      matches=searchWithRegexes(exp.map(e=>({...e, re:termRegex(e.term)})),ready);
    }
    const findings=buildFindings(matches);
    const kw = (spec.tiers.length>1 && findings.length) ? usedTier : spec.primary;
    const fellBack = spec.tiers.length>1 && findings.length && usedTier!==spec.primary;
    return { kw, primary:spec.primary, tiers:spec.tiers, usedTier, isChain:spec.tiers.length>1, fellBack, findings, rawCount:matches.length };
  });
  // chronological: keyword groups in the order they first appear in the document (none-found last)
  const firstPage=g=>{ let m=Infinity; g.findings.forEach(f=>f.sourceList.forEach(s=>{ if(s.page<m)m=s.page; })); return m; };
  state.matchesByKw.sort((a,b)=>firstPage(a)-firstPage(b));

  aiState='idle'; aiError='';
  renderResults();
  updateReportBtn();
  const totalF=state.matchesByKw.reduce((n,g)=>n+g.findings.length,0);
  toast(`Scan complete — ${totalF} distinct finding${totalF===1?'':'s'} across ${state.matchesByKw.length} keyword${state.matchesByKw.length===1?'':'s'}`, totalF?'ok':'warn');
  // auto-prepare the AI report when a key is present
  if(getKey() && totalF) generateAiSummary();
}

// ================= rendering: library =================
function renderLibrary(){
  const list=$('#pdfList'); list.innerHTML='';
  for(const pdf of state.pdfs){
    const li=el('li','pdf-item'+(state.view.fileId===pdf.id?' active':''));
    const meta = pdf.status==='loading' ? '<span class="pi-spin">extracting…</span>'
               : pdf.status==='error' ? '<span style="color:var(--err)">failed</span>'
               : `${pdf.numPages} pp · ${(pdf.size/1024).toFixed(0)} KB`;
    li.innerHTML=`<span class="pi-icon">📄</span>
      <span style="min-width:0;flex:1">
        <div class="pi-name" title="${esc(pdf.name)}">${esc(pdf.name)}</div>
        <div class="pi-meta">${meta}</div>
      </span>
      <button class="pi-x" title="Remove">✕</button>`;
    li.onclick=e=>{ if(e.target.classList.contains('pi-x')){ removePdf(pdf.id); return; } if(pdf.status==='ready') openViewer(pdf.id,1,[]); };
    list.appendChild(li);
  }
  $('#libCount').textContent=`${state.pdfs.length} file${state.pdfs.length===1?'':'s'}`;
}
function removePdf(id){
  state.pdfs=state.pdfs.filter(p=>p.id!==id);
  if(state.view.fileId===id){ state.view.fileId=null; $('#canvasHolder').hidden=true; $('#viewerEmpty').hidden=false; $('#viewerTitle').textContent='PDF Viewer'; }
  renderLibrary(); refreshScanButton();
  if(state.matchesByKw.length){ state.matchesByKw=[]; renderResults(); aiState='idle'; updateReportBtn(); }
}
function refreshScanButton(){ $('#btnScan').disabled = !state.pdfs.some(p=>p.status==='ready'); }
// Debounced re-scan after keyword/alias edits (waits until typing pauses).
let rescanTimer=null;
function scheduleRescan(){
  clearTimeout(rescanTimer);
  rescanTimer=setTimeout(()=>{ if(state.pdfs.some(p=>p.status==='ready') && parseKeywordSpecs().length) scan(); }, 700);
}

// ================= rendering: results =================
// Clickable source links: "File.pdf p.4, p.9" where each page jumps the viewer.
function srcLinks(i,j,f){
  const byFile=new Map();
  f.sourceList.forEach((s,k)=>{ if(!byFile.has(s.file))byFile.set(s.file,[]); byFile.get(s.file).push({s,k}); });
  return [...byFile.entries()].map(([file,arr])=>
    `<span class="src-file">${esc(file)}</span> `+
    arr.map(({s,k})=>`<a class="src" href="#" data-i="${i}" data-j="${j}" data-k="${k}" title="Open ${esc(file)} at page ${s.page}">p.${s.page}</a>`).join(', ')
  ).join(' · ');
}
function jumpTo(i,j,k){
  const f=state.matchesByKw[i]?.findings[j]; const s=f?.sourceList[k]; if(!s) return;
  $('#reportModal').hidden=true;
  openViewer(s.fileId, s.page, f.terms);
}
function wireJumps(container){
  container.addEventListener('click',e=>{ const a=e.target.closest('a.src,[data-jump]'); if(!a)return;
    e.preventDefault(); jumpTo(+a.dataset.i,+a.dataset.j,+a.dataset.k); });
}

// chips for the extracted spec values (blank fields are omitted)
function specChips(specs){
  if(!specs) return '';
  const order=[['qty','Qty'],['amps','A'],['kA','kA'],['voltage','V'],['ip','IP'],['form','Form'],['phase','Phase']];
  const parts=order.filter(([k])=>specs[k]).map(([k,lbl])=>`<span class="spec-chip"><b>${lbl}</b> ${esc(specs[k])}</span>`);
  return parts.length?`<div class="spec-row">${parts.join('')}</div>`:'';
}
// chips for detected standards/codes (verbatim)
function stdChips(stds){
  if(!stds||!stds.length) return '';
  return `<div class="spec-row">${stds.map(s=>`<span class="std-chip">${esc(s)}</span>`).join('')}</div>`;
}

function renderResults(){
  const box=$('#results'); box.innerHTML='';
  const dlW=$('#dlResultsWord'), dlP=$('#dlPages');
  if(!state.matchesByKw.length){ box.innerHTML='<div class="empty">Add PDFs and keywords, then press <b>Scan PDFs</b>.</div>'; $('#resCount').textContent='–'; if(dlW)dlW.disabled=true; if(dlP)dlP.disabled=true; return; }
  let total=0;
  state.matchesByKw.forEach((g,i)=>{
    total+=g.findings.length;
    const grp=el('div','kw-group');
    const head=el('div','kw-head');
    head.innerHTML=`<span class="kw-name">${esc(g.kw)}</span>`+
      (g.findings.length?`<span class="kw-count">${g.findings.length} finding${g.findings.length===1?'':'s'}</span>`
                        :`<span class="kw-none">none found</span>`);
    grp.appendChild(head);
    const body=el('div','kw-body');
    if(g.isChain) body.appendChild(el('div','chain-note', g.findings.length
        ? (g.fellBack?`Preferred “${esc(g.primary)}” not found — showing fallback “${esc(g.usedTier)}”.`
                     :`Matched preferred term “${esc(g.usedTier)}”.`)
        : `Searched ${g.tiers.map(esc).join(' → ')} — none found.`));
    if(!g.findings.length){
      body.appendChild(el('div','none-line','No project-specific information found in uploaded documents.'));
    }else{
      g.findings.slice(0,25).forEach((f,j)=>{
        const item=el('div','match');
        const badge = f.type==='exact'?'<span class="m-badge exact">exact</span>'
                    : f.type==='alias'?'<span class="m-badge alias">alias</span>'
                    : '<span class="m-badge syn">synonym</span>';
        const tbadge = f.tabular?'<span class="m-badge table">table/row</span>':'';
        item.innerHTML=`<div class="m-quote">${highlightQuote(f.text,f.terms)}</div>
          ${specChips(f.specs)}${stdChips(f.standards)}
          <div class="m-top">${badge}${tbadge}<span class="m-cite">${srcLinks(i,j,f)}</span></div>
          ${f.tags.length?`<div class="m-tags">${f.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div>`:''}`;
        body.appendChild(item);
      });
      if(g.findings.length>25) body.appendChild(el('div','none-line',`+ ${g.findings.length-25} more (see report)`));
    }
    grp.appendChild(body);
    head.onclick=()=>{ body.style.display = body.style.display==='none'?'':'none'; };
    box.appendChild(grp);
  });
  $('#resCount').textContent=`${total} finding${total===1?'':'s'}`;
  if(dlW)dlW.disabled = !total; if(dlP)dlP.disabled = !total;
}
function highlightQuote(quote, terms){
  let out=esc(quote);
  const sorted=[...terms].sort((a,b)=>b.length-a.length);
  for(const t of sorted){
    try{ out=out.replace(new RegExp('('+t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+')+')','gi'),'<mark>$1</mark>'); }catch{}
  }
  return out;
}

// ================= viewer =================
async function openViewer(fileId, pageNum, terms){
  const pdf=state.pdfs.find(p=>p.id===fileId); if(!pdf||!pdf.doc) return;
  state.view={ fileId, page:Math.max(1,Math.min(pageNum,pdf.numPages)), scale:state.view.scale||1.2, terms:terms||[] };
  $('#viewerTitle').textContent=pdf.name;
  $('#viewerEmpty').hidden=true; $('#canvasHolder').hidden=false;
  $('#pgTotal').textContent=pdf.numPages;
  $('#pgInput').disabled=false; $('#pgInput').max=pdf.numPages;
  ['pgPrev','pgNext','zoomIn','zoomOut'].forEach(id=>$('#'+id).disabled=false);
  renderLibrary();
  await renderPage();
}
async function renderPage(){
  const v=state.view; const pdf=state.pdfs.find(p=>p.id===v.fileId); if(!pdf) return;
  $('#pgInput').value=v.page;
  const page=await pdf.doc.getPage(v.page);
  // fit-to-width on first render
  const wrap=$('#viewerWrap');
  if(!v._fit){ const base=page.getViewport({scale:1}); v.scale=Math.min(2.2,(wrap.clientWidth-48)/base.width); v._fit=true; }
  const viewport=page.getViewport({scale:v.scale});
  const canvas=$('#pdfCanvas'); const ctx=canvas.getContext('2d');
  const dpr=window.devicePixelRatio||1;
  canvas.width=viewport.width*dpr; canvas.height=viewport.height*dpr;
  canvas.style.width=viewport.width+'px'; canvas.style.height=viewport.height+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
  await page.render({canvasContext:ctx, viewport}).promise;
  // highlight layer
  const layer=$('#hlLayer'); layer.innerHTML=''; layer.style.width=viewport.width+'px'; layer.style.height=viewport.height+'px';
  if(v.terms&&v.terms.length){
    const res=buildHlMatchers(v.terms);
    const tc=await page.getTextContent();
    let first=null;
    for(const it of tc.items){
      if(!it.str||!res.some(r=>{r.lastIndex=0;return r.test(it.str);})) continue;
      const tx=pdfjsLib.Util.transform(viewport.transform, it.transform);
      const fontH=Math.hypot(tx[2],tx[3]); const w=it.width*viewport.scale;
      const box=el('div','hl-box'); box.style.left=tx[4]+'px'; box.style.top=(tx[5]-fontH)+'px';
      box.style.width=Math.max(w,6)+'px'; box.style.height=(fontH*1.1)+'px';
      if(!first){ first=box; box.classList.add('focus'); }
      layer.appendChild(box);
    }
    if(first) first.scrollIntoView({block:'center',behavior:'smooth'});
  }
}
// matchers for highlight: full terms + significant words of multiword terms
function buildHlMatchers(terms){
  const set=new Set();
  for(const t of terms){ set.add(t); t.split(/\s+/).forEach(w=>{ if(w.length>=3) set.add(w); }); }
  return [...set].map(t=>{try{return termRegex(t);}catch{return /$^/;}});
}
function step(d){ const pdf=state.pdfs.find(p=>p.id===state.view.fileId); if(!pdf)return; const n=state.view.page+d; if(n<1||n>pdf.numPages)return; state.view.page=n; renderPage(); }
function zoom(f){ state.view.scale=Math.max(.4,Math.min(4,state.view.scale*f)); renderPage(); }

// ================= report =================
const VALUE_CHECKS=[
  ['Voltage', /\b\d+(?:\.\d+)?\s?k?V\b/i],
  ['Current rating (A)', /\b\d+(?:\.\d+)?\s?A\b/],
  ['Fault level (kA)', /\b\d+(?:\.\d+)?\s?kA\b/i],
  ['IP rating', /\bIP\s?\d{2}\b/i],
  ['Cable size (mm²)', /\b\d+(?:\.\d+)?\s?mm(?:²|2|\^2)\b/i],
  ['Standard reference', /\b(?:BS\s?EN|BS|IEC|EN|ISO|NFPA|IEEE)\s?\d+/i],
  ['Switching / transfer time', /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds)\b/i],
  ['Generator rating', /\b\d+(?:\.\d+)?\s?(?:kVA|kW|MVA|MW)\b/i],
];
function currentMode(){ return $('.mode.active').dataset.mode; }

// ---- AI summary (Anthropic API, called directly from the browser) ----
const AI_MODEL='claude-sonnet-4-6';
const KEY_LS='pdfscan.anthropicKey';
let aiState='idle', aiError='';   // idle | loading | done | error
let aiController=null, aiSeq=0;   // supersede in-flight prep when a newer scan/edit lands
const getKey=()=>localStorage.getItem(KEY_LS)||'';
const setKey=k=>localStorage.setItem(KEY_LS,k.trim());
function setAiState(s,err){ aiState=s; aiError=err||''; renderReport(); updateReportBtn(); }
function updateReportBtn(){
  const b=$('#btnReport'); if(!b) return;
  b.disabled = !state.matchesByKw.length || aiState==='loading';   // not clickable while preparing
  b.textContent = aiState==='loading' ? '⏳ Preparing report…'
                : aiState==='done'    ? '✓ Report prepared'
                : '📄 Generate Report';
}
function refreshKeyStatus(){ const el=$('#keyStatus'); if(!el) return; const k=getKey();
  el.textContent = k ? `saved ✓ (ends …${k.slice(-4)})` : 'no key saved yet';
  el.style.color = k ? '#7CFFB2' : '#aebfdc'; }

const AI_SYSTEM=`You are a chartered electrical engineer extracting requirements from project specifications for an expert audience (engineers with 20+ years' experience). For each keyword you receive NUMBERED evidence excerpts taken verbatim from the documents, each tied to a file and page.

Produce a precise, de-duplicated requirements summary for each keyword. The output is pasted into Excel, stored in a database, and discussed with clients across different countries and industries — it must be specific, professional, and free of filler.

EXTRACT, whenever present in the evidence:
- Standards / codes with their FULL designation: number, part, year and amendment — verbatim. e.g. "BS EN 61439-1:2021", "BS EN IEC 61439-2:2021", "BS 7671:2018 18th Edition (Amendment 3:2024)", "IEC 60947-6-1", "ISO 9001", "BS ISO 8528", "CIBSE TM39:2009", "BS 5266-1:2016", "BS 8519:2020 Category 3". Never abbreviate or drop the part/year/amendment. State which requirement maps to which standard.
- Ratings & parameters: voltage, current (A), fault level (kA), IP rating, form of separation, phase, utilisation category (e.g. "AC33A"), insulation class (e.g. "Class 0, 1kV"), spare capacity (%), comms/protocol (e.g. "Modbus/RS485", "TCP/IP").
- Concrete requirements: what shall be provided / installed / tested / labelled / configured, with quantities and to which standard.

RULES — follow exactly:
- Output ONLY facts contained in the evidence. NEVER invent or generalise a standard, rating, requirement or value. If it is not in the evidence, it does not appear.
- NO FILLER / NO AI SLOP. Forbidden: introductions, restating the keyword, "the document describes/outlines/specifies…", "it appears", "as part of the scope", "is mentioned", and any sentence carrying no concrete standard/rating/requirement. If a bullet would not carry a specific fact, delete it.
- ONE requirement per bullet, written as a terse technical line an engineer would accept straight into a schedule. Quote standards, categories and values exactly as written.
- NO REPETITION: state each requirement once, under the single most relevant keyword. Do not repeat it (or a paraphrase) under another keyword. A keyword may legitimately have few or zero unique bullets — return an empty bullets array rather than padding.
- Cite the evidence index/indices ([n]) each bullet draws from.
- The reader is an expert: do not explain basics or what a standard is.

Return one group per keyword, in the order given, using the exact keyword string.`;

const AI_SCHEMA={ type:'object', additionalProperties:false, required:['groups'], properties:{
  groups:{ type:'array', items:{ type:'object', additionalProperties:false, required:['keyword','bullets'], properties:{
    keyword:{type:'string'},
    bullets:{ type:'array', items:{ type:'object', additionalProperties:false, required:['text','cites'], properties:{
      text:{type:'string'}, cites:{ type:'array', items:{type:'integer'} } } } } } } } } };

const AI_MAX_EVIDENCE=40;   // cap snippets sent per keyword (big specs produce hundreds)
const AI_TIMEOUT_MS=120000;
async function generateAiSummary(){
  const key=getKey(); if(!key){ toast('Add your Anthropic API key first','warn'); return; }
  const groups=state.matchesByKw.filter(g=>g.findings.length);
  if(!groups.length){ toast('No findings to summarise','warn'); return; }
  const seen=new Set();   // a given evidence line is fed to only the FIRST keyword that has it
  const blocks=groups.map(g=>{
    const picked=[];      // [originalIndex, finding] — keep original index so citations resolve
    for(let idx=0; idx<g.findings.length && picked.length<AI_MAX_EVIDENCE; idx++){
      const f=g.findings[idx], k=normKey(f.text);
      if(seen.has(k)) continue;
      seen.add(k); picked.push([idx,f]);
    }
    if(!picked.length) return `### Keyword: ${g.kw}\n  (no unique snippets — every match is already listed under an earlier keyword; return an empty bullets array for this keyword)`;
    const ev=picked.map(([idx,f])=>`  [${idx}] "${f.context||f.text}" (${f.sourceList.map(s=>s.file+' p.'+s.page).join('; ')})`).join('\n');
    const omitted=g.findings.length-picked.length;
    const more=omitted>0?`\n  (note: ${omitted} further snippets omitted as duplicates or lower-ranked)`:'';
    return `### Keyword: ${g.kw}\n${ev}${more}`;
  }).join('\n\n');
  const user=`Summarise what the uploaded documents say about each keyword below. Cite snippet indices (the [n] numbers) within each keyword.\n\n${blocks}`;
  if(aiController){ try{ aiController.abort(); }catch{} }
  const mySeq=++aiSeq; const ctrl=new AbortController(); aiController=ctrl;
  setAiState('loading');
  const timer=setTimeout(()=>ctrl.abort(), AI_TIMEOUT_MS);
  try{
    const res=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST', signal:ctrl.signal,
      headers:{ 'content-type':'application/json','x-api-key':key,
        'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true' },
      body:JSON.stringify({ model:AI_MODEL, max_tokens:16000, system:AI_SYSTEM,
        messages:[{role:'user',content:user}], output_config:{format:{type:'json_schema',schema:AI_SCHEMA}} })
    });
    clearTimeout(timer);
    if(!res.ok){ const t=await res.text(); throw new Error('API '+res.status+' — '+t.slice(0,220)); }
    const data=await res.json();
    if(data.stop_reason==='max_tokens') throw new Error('Response hit the length limit — fewer keywords or PDFs will help.');
    const txt=(data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    let parsed; try{ parsed=JSON.parse(txt); }catch{ throw new Error('Could not parse the model response (it may have been cut off).'); }
    if(mySeq!==aiSeq) return;   // a newer scan/edit superseded this run — discard
    state.matchesByKw.forEach(g=>{ delete g.aiBullets; });
    for(const grp of (parsed.groups||[])){ const g=state.matchesByKw.find(x=>x.kw===grp.keyword); if(g) g.aiBullets=grp.bullets||[]; }
    setAiState('done'); toast('AI summary ready','ok');
  }catch(e){ clearTimeout(timer);
    if(mySeq!==aiSeq) return;   // superseded (incl. the abort we triggered) — stay silent
    console.error(e);
    const msg = e.name==='AbortError' ? `Timed out after ${AI_TIMEOUT_MS/1000}s — the document is large; try fewer keywords or split the PDF.` : (e.message||'request failed');
    setAiState('error', msg); toast('AI summary failed','err'); }
}

// ---- shared report pieces ----
function headerHtml(label){
  const project=esc($('#projectName').value||'Untitled project');
  const files=[...new Set(state.matchesByKw.flatMap(g=>g.findings.flatMap(f=>f.sourceList.map(s=>s.file))))];
  const totalF=state.matchesByKw.reduce((n,g)=>n+g.findings.length,0);
  return `<h1>${project} — Keyword Findings</h1>
    <div class="rep-meta"><b>${label}</b> · ${state.matchesByKw.length} keywords · ${totalF} distinct finding${totalF===1?'':'s'} · ${files.length} document${files.length===1?'':'s'}<br>
    <i>${label==='Summary'
      ? 'Summary written by Claude using only the extracted evidence — every point links to its source page; no values are inferred.'
      : 'Findings are grouped and de-duplicated, quoted verbatim from the uploaded PDFs.'}</i></div>`;
}
function chainNoteHtml(g){
  return `<div class="chain-note">${ g.findings.length
      ? (g.fellBack?`Preferred “${esc(g.primary)}” not found — showing fallback “${esc(g.usedTier)}”.`
                   :`Matched preferred term “${esc(g.usedTier)}”.`)
      : `Searched ${g.tiers.map(esc).join(' → ')} — none found.` }</div>`;
}
// citations for an AI bullet: snippet indices -> grouped, clickable, de-duplicated page links
function aiCites(i, cites){
  const g=state.matchesByKw[i]; const byFile=new Map();
  (cites||[]).forEach(j=>{ const f=g.findings[j]; if(!f) return;
    f.sourceList.forEach((s,k)=>{ if(!byFile.has(s.file)) byFile.set(s.file,new Map());
      if(!byFile.get(s.file).has(s.page)) byFile.get(s.file).set(s.page,{j,k,page:s.page}); }); });
  if(!byFile.size) return 'source not cited';
  return [...byFile.entries()].map(([file,pages])=>
    `<span class="src-file">${esc(file)}</span> `+
    [...pages.values()].sort((a,b)=>a.page-b.page).map(p=>`<a class="src" href="#" data-i="${i}" data-j="${p.j}" data-k="${p.k}">p.${p.page}</a>`).join(', ')
  ).join(' · ');
}

// ---- Evidence mode: deduped verbatim findings (no highlighting) ----
function buildEvidenceHtml(){
  let h=headerHtml('Evidence');
  state.matchesByKw.forEach((g,i)=>{
    h+=`<div class="rep-kw"><h2>${esc(g.kw)}</h2>`;
    if(g.isChain) h+=chainNoteHtml(g);
    if(!g.findings.length){ h+=`<p class="rep-none">No project-specific information found in uploaded documents.</p></div>`; return; }
    h+=`<ul class="rep-bul">`;
    g.findings.forEach((f,j)=>{ h+=`<li>${esc(f.text)} <span class="rep-cite">(${srcLinks(i,j,f)})</span>${f.tabular?' <span class="m-badge table">table/row</span>':''}${specChips(f.specs)}${stdChips(f.standards)}</li>`; });
    h+=`</ul>`;
    const blob=g.findings.map(f=>f.text).join('  ');
    const absent=VALUE_CHECKS.filter(([,re])=>!re.test(blob)).map(([n])=>n);
    if(absent.length) h+=`<div class="rep-warn"><b>Not found in uploaded documents:</b> ${absent.join(', ')}. Not stated in the extracted evidence and <b>not</b> assumed.</div>`;
    h+=`</div>`;
  });
  return h;
}

// ---- Summary mode: AI bullets ----
function buildSummaryHtml(){
  let h=headerHtml('Summary');
  if(!getKey()){
    return h+`<div class="ai-bar"><b>AI summary needs your Anthropic API key</b> (stored only in this browser).
      <div class="key-row"><input id="aiKeyInput" type="password" placeholder="sk-ant-..." spellcheck="false">
      <button id="aiKeySave" class="btn sm primary">Save key</button></div>
      <span class="muted">Get one at console.anthropic.com → API keys. It is sent only to Anthropic, never stored anywhere but this browser. Prefer no AI? Use the <b>Evidence</b> tab — it needs no key.</span></div>`;
  }
  if(aiState==='loading') h+=`<div class="ai-bar">⏳ Generating summary… <span class="muted">contacting Claude — large documents can take 30–60s; this panel will fill in when it returns.</span></div>`;
  else if(aiState==='done') h+=`<div class="ai-bar"><button id="aiGenBtn" class="btn sm">↻ Regenerate</button>
      <button id="aiKeyClear" class="btn sm ghost">change key</button>
      <span class="muted">Written by Claude from the extracted evidence only — click any page link to verify.</span></div>`;
  else h+=`<div class="ai-bar"><button id="aiGenBtn" class="btn sm primary">✨ Generate AI summary</button>
      <button id="aiKeyClear" class="btn sm ghost">change key</button>
      ${aiState==='error'?`<div class="ai-err">${esc(aiError)}</div>`:''}</div>`;

  state.matchesByKw.forEach((g,i)=>{
    h+=`<div class="rep-kw"><h2>${esc(g.kw)}</h2>`;
    if(g.isChain) h+=chainNoteHtml(g);
    if(!g.findings.length){ h+=`<p class="rep-none">No project-specific information found in uploaded documents.</p></div>`; return; }
    if(aiState!=='done' || !g.aiBullets){ h+=`<p class="muted">— generate the summary to populate —</p></div>`; return; }
    if(!g.aiBullets.length){ h+=`<p class="muted">Covered under a related keyword above — no separate findings to avoid repetition.</p></div>`; return; }
    h+=`<ul class="rep-bul">`;
    g.aiBullets.forEach(b=>{ h+=`<li>${esc(b.text)} <span class="rep-cite">(${aiCites(i,b.cites)})</span></li>`; });
    h+=`</ul></div>`;
  });
  return h;
}

function renderReport(){
  $('#reportBody').innerHTML = currentMode()==='evidence' ? buildEvidenceHtml() : buildSummaryHtml();
  const save=$('#aiKeySave'); if(save) save.onclick=()=>{ const v=$('#aiKeyInput').value.trim(); if(!v){ toast('Paste a key first','warn'); return; } setKey(v); refreshKeyStatus(); aiState='idle'; toast('API key saved','ok'); generateAiSummary(); };
  const clr=$('#aiKeyClear'); if(clr) clr.onclick=()=>{ localStorage.removeItem(KEY_LS); aiState='idle'; refreshKeyStatus(); renderReport(); };
  const gen=$('#aiGenBtn'); if(gen) gen.onclick=generateAiSummary;
}
function openReport(){
  if(!state.matchesByKw.length){ toast('Run a scan first','warn'); return; }
  $('#reportModal').hidden=false; renderReport();
  // publish instantly: if a key is saved, generate the summary without a second click
  if(getKey() && aiState!=='done' && aiState!=='loading' && state.matchesByKw.some(g=>g.findings.length)) generateAiSummary();
}

// ================= exports =================
function download(name, mime, content){
  const blob = content instanceof Blob ? content : new Blob([content],{type:mime});
  const a=el('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
function wordDoc(inner){
  return `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head><meta charset='utf-8'><style>
    body{font-family:Calibri,Arial,sans-serif;color:#13243f}
    h1{font-size:18pt;color:#0A1F44} h2{font-size:13pt;color:#0A1F44;text-decoration:underline}
    .rep-meta{color:#5C6B82;font-size:9.5pt;margin-bottom:10pt}
    .chain-note{color:#1976D2;font-size:9.5pt;margin:4pt 0}
    .rep-label{font-weight:bold;color:#0A1F44;margin-top:8pt}
    ul.rep-bul{margin:4pt 0} ul.rep-bul li{margin-bottom:5pt}
    .rep-cite{color:#5C6B82;font-size:9pt} a.src{color:#1E90FF;text-decoration:none} .src-file{color:#5C6B82}
    .spec-row{margin:3pt 0} .spec-chip{font-size:8.5pt;background:#eef4ff;border:1pt solid #cfe0fb;color:#1976D2;border-radius:3pt;padding:1pt 4pt;margin-right:3pt} .spec-chip b{color:#0A1F44}
    .std-chip{font-size:8.5pt;background:#eef7ee;border:1pt solid #cfe6cf;color:#1f7a3d;border-radius:3pt;padding:1pt 4pt;margin-right:3pt;font-family:Consolas,monospace}
    .rep-warn{background:#fff7e6;border:1pt solid #f0dcab;padding:6pt;color:#8a6418}
    .rep-none{color:#b9851f;font-style:italic} .rep-sum{background:#f3f6fb;padding:6pt} code{font-family:Consolas}
    </style></head><body>${inner}</body></html>`;
}
function exportWord(){ download(reportName('doc','report'),'application/msword','﻿'+wordDoc($('#reportBody').innerHTML)); }
function downloadResultsWord(){
  if(!state.matchesByKw.length){ toast('Run a scan first','warn'); return; }
  download(reportName('doc','keyword_results'),'application/msword','﻿'+wordDoc(buildEvidenceHtml()));
}
// Extract ONLY the source pages that matched into a new PDF — full original
// detail (clauses, tables, standards), like the offline tool's matched-pages PDF.
async function downloadMatchedPages(){
  if(!window.PDFLib){ toast('PDF library not loaded','err'); return; }
  const byPdf=new Map();   // fileId -> Set(pageNumbers)
  state.matchesByKw.forEach(g=>g.findings.forEach(f=>f.sourceList.forEach(s=>{
    if(!byPdf.has(s.fileId)) byPdf.set(s.fileId,new Set());
    byPdf.get(s.fileId).add(s.page);
  })));
  if(!byPdf.size){ toast('No matched pages to extract','warn'); return; }
  const btn=$('#dlPages'), orig=btn.textContent; btn.disabled=true; btn.textContent='Building PDF…';
  try{
    const { PDFDocument }=window.PDFLib;
    const out=await PDFDocument.create();
    let firstName='', usedFiles=0;
    for(const rec of state.pdfs){          // source-file order
      if(rec.status!=='ready' || !rec.file || !byPdf.has(rec.id)) continue;
      const src=await PDFDocument.load(await rec.file.arrayBuffer(), { ignoreEncryption:true });
      const total=src.getPageCount();
      const idxs=[...byPdf.get(rec.id)].sort((a,b)=>a-b).map(p=>p-1).filter(i=>i>=0 && i<total);
      if(!idxs.length) continue;
      if(!firstName) firstName=rec.name; usedFiles++;
      (await out.copyPages(src, idxs)).forEach(p=>out.addPage(p));
    }
    if(out.getPageCount()===0) throw new Error('no pages');
    const bytes=await out.save();
    const base = usedFiles===1 ? firstName.replace(/\.pdf$/i,'') : ($('#projectName').value||'documents');
    download(base+' — matched pages.pdf','application/pdf', new Blob([bytes],{type:'application/pdf'}));
    toast(`Matched pages PDF ready (${out.getPageCount()} pages)`,'ok');
  }catch(e){ console.error(e); toast('Could not build matched-pages PDF','err'); }
  finally{ btn.textContent=orig; btn.disabled = !state.matchesByKw.some(g=>g.findings.length); }
}
function exportPrint(){ window.print(); }
function reportName(ext, base){ return ($('#projectName').value||'pdf-scan').replace(/[^\w-]+/g,'_')+'_'+(base||'findings')+'.'+ext; }

// ================= keyword groups (localStorage) =================
const LS='pdfscan.groups.v1';
const DEFAULT_GROUPS={
  'Electrical Distribution (default)':{
    keywords:['LV Distribution Equipment > Low Voltage Distribution','LV Distribution System','LV Equipment','Life Safety','Switchboard','Panelboards','Metering','Surge Arrestor','Automatic Transfer Switch > ATS'],
    aliases:['LV = Low Voltage','Surge Arrestor = Surge Protection Device / SPD','Panelboards = Distribution Boards / Panels'],
  },
};
function loadGroups(){ try{ return {...DEFAULT_GROUPS, ...(JSON.parse(localStorage.getItem(LS))||{})}; }catch{ return {...DEFAULT_GROUPS}; } }
function saveGroups(g){ const custom={...g}; delete custom['Electrical Distribution (default)']; localStorage.setItem(LS,JSON.stringify(custom)); }
function refreshGroupSelect(sel){
  const groups=loadGroups(); const s=$('#groupSelect'); s.innerHTML='';
  Object.keys(groups).forEach(name=>{ const o=el('option'); o.value=name; o.textContent=name; s.appendChild(o); });
  if(sel) s.value=sel;
}
function applyGroup(name){ const g=loadGroups()[name]; if(!g)return; $('#keywords').value=g.keywords.join('\n'); $('#aliases').value=(g.aliases||[]).join('\n'); }

// ================= wiring =================
function init(){
  // groups
  refreshGroupSelect('Electrical Distribution (default)');
  applyGroup('Electrical Distribution (default)');
  $('#groupSelect').onchange=e=>{ applyGroup(e.target.value); scheduleRescan(); };
  $('#keywords').addEventListener('input', scheduleRescan);
  $('#aliases').addEventListener('input', scheduleRescan);
  $('#useDomain').addEventListener('change', scheduleRescan);
  $('#btnSaveGroup').onclick=()=>{
    const name=prompt('Save keyword group as:'); if(!name)return;
    const g=loadGroups(); g[name]={keywords:parseKeywords(), aliases:$('#aliases').value.split('\n').map(s=>s.trim()).filter(Boolean)};
    saveGroups(g); refreshGroupSelect(name); toast(`Saved group "${name}"`,'ok');
  };
  $('#btnDeleteGroup').onclick=()=>{
    const name=$('#groupSelect').value;
    if(name.includes('(default)')){ toast('The default group cannot be deleted','warn'); return; }
    const g=loadGroups(); delete g[name]; saveGroups(g); refreshGroupSelect(); applyGroup($('#groupSelect').value);
    toast('Group deleted','ok');
  };

  // upload
  const dz=$('#dropzone'), fi=$('#fileInput');
  $('#btnBrowse').onclick=e=>{e.stopPropagation(); fi.click();};
  dz.onclick=()=>fi.click();
  fi.onchange=()=>{ if(fi.files.length) addFiles(fi.files); fi.value=''; };
  ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drag');}));
  ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('drag');}));
  dz.addEventListener('drop',e=>{ if(e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  // actions
  $('#btnScan').onclick=scan;
  $('#btnReport').onclick=openReport;
  $('#dlResultsWord').onclick=downloadResultsWord;
  $('#dlPages').onclick=downloadMatchedPages;
  updateReportBtn();

  // viewer nav
  $('#pgPrev').onclick=()=>step(-1); $('#pgNext').onclick=()=>step(1);
  $('#zoomIn').onclick=()=>zoom(1.2); $('#zoomOut').onclick=()=>zoom(1/1.2);
  $('#pgInput').onchange=e=>{ const n=parseInt(e.target.value,10); if(n){ state.view.page=n; renderPage(); } };

  // top-bar API key panel
  const kp=$('#keyPanel'), keyField=$('#keyField');
  function saveTopKey(){ const v=keyField.value.trim(); if(!v){ toast('Paste a key first','warn'); return; }
    setKey(v); keyField.value=''; refreshKeyStatus(); aiState='idle'; toast('API key saved','ok');
    if(!$('#reportModal').hidden && currentMode()==='summary') generateAiSummary(); }
  $('#btnKey').onclick=()=>{ kp.hidden=!kp.hidden; if(!kp.hidden){ refreshKeyStatus(); keyField.focus(); } };
  $('#keySave').onclick=saveTopKey;
  keyField.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); saveTopKey(); } });
  $('#keyHide').onclick=()=>{ kp.hidden=true; };
  refreshKeyStatus();

  // clickable source citations (results pane + report) jump the viewer to file/page
  wireJumps($('#results')); wireJumps($('#reportBody'));

  // report modal
  document.querySelectorAll('.mode').forEach(b=>b.onclick=()=>{ document.querySelectorAll('.mode').forEach(x=>x.classList.remove('active')); b.classList.add('active'); renderReport(); });
  $('#closeReport').onclick=()=>$('#reportModal').hidden=true;
  $('#reportModal').onclick=e=>{ if(e.target.id==='reportModal') $('#reportModal').hidden=true; };
  $('#expWord').onclick=exportWord; $('#expPdf').onclick=exportPrint;

  document.addEventListener('keydown',e=>{
    if(e.key==='Escape') $('#reportModal').hidden=true;
    if(!$('#reportModal').hidden) return;
    if(state.view.fileId && document.activeElement.tagName!=='TEXTAREA' && document.activeElement.tagName!=='INPUT'){
      if(e.key==='ArrowRight') step(1); if(e.key==='ArrowLeft') step(-1);
    }
  });
}
document.addEventListener('DOMContentLoaded',init);

// Debug handle — drive the app from the console (e.g. __scanner.scan()).
window.__scanner = { addFiles, scan, openViewer, openReport, generateAiSummary, renderReport, state };
})();
