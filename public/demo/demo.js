"use strict";
// Pentagon RC1 demo: intentionally no network calls, storage, accounts or live telemetry.
// Every domain uses the reserved .example suffix and every provider is fictional.
(()=>{
const $=id=>document.getElementById(id);
const scenarios=[
 {label:"Healthy baseline",checks:128,activity:"A sample view of recent domain availability checks. No production monitoring occurs.",bars:[60,73,77,85,72,89,92,74,83,95,87,98,81,90,78,97],domains:[["atlas.example","healthy","Sample check 00:01","Example project A"],["vector.example","healthy","Sample check 00:02","Example project B"],["nexus.example","healthy","Sample check 00:03","Example project C"],["orbit.example","healthy","Sample check 00:04","Example project D"]],providers:[["Example Provider A","healthy","24 ms","Test mobile"],["Example Provider B","healthy","38 ms","Test broadband"],["Example Provider C","healthy","29 ms","Test alternate"]],search:[["sample industry overview",5,"+0","healthy"],["example product guide",11,"+1","healthy"],["mock brand query",3,"+0","healthy"]],alerts:[]},
 {label:"Domain degradation",checks:136,activity:"Example scenario: one fictional domain returns a simulated warning; a review task is queued locally.",bars:[91,80,93,72,90,84,45,68,54,72,35,42,63,38,64,74],domains:[["atlas.example","healthy","Sample check 00:01","Example project A"],["vector.example","warning","Sample check 00:02","Simulated availability warning"],["nexus.example","healthy","Sample check 00:03","Example project C"],["orbit.example","healthy","Sample check 00:04","Example project D"]],providers:[["Example Provider A","healthy","24 ms","Test mobile"],["Example Provider B","warning","79 ms","Simulated latency warning"],["Example Provider C","healthy","29 ms","Test alternate"]],search:[["sample industry overview",5,"+0","healthy"],["example product guide",11,"+1","healthy"],["mock brand query",3,"+0","healthy"]],alerts:[{id:"domain",title:"Domain availability warning",description:"vector.example returned a simulated degraded signal.",level:"warning"},{id:"node",title:"Provider signal elevated",description:"Example Provider B experienced simulated latency.",level:"warning"}]},
 {label:"Search visibility shift",checks:144,activity:"Example scenario: fictional keyword rank changes and one mock search alert are displayed; these are not Google results.",bars:[65,79,84,81,83,87,89,75,92,94,69,91,79,98,92,95],domains:[["atlas.example","healthy","Sample check 00:01","Example project A"],["vector.example","healthy","Sample check 00:02","Example project B"],["nexus.example","healthy","Sample check 00:03","Example project C"],["orbit.example","healthy","Sample check 00:04","Example project D"]],providers:[["Example Provider A","healthy","24 ms","Test mobile"],["Example Provider B","healthy","38 ms","Test broadband"],["Example Provider C","healthy","29 ms","Test alternate"]],search:[["sample industry overview",16,"-11","warning"],["example product guide",8,"+3","healthy"],["mock brand query",3,"+0","healthy"]],alerts:[{id:"rank",title:"Search visibility change",description:"Sample keyword slipped 11 positions in the fictional rank snapshot.",level:"warning"}]}
];
let active=0,ack=new Set();
const tabs=[...document.querySelectorAll('[role="tab"][data-tab]')];
const panels=[...document.querySelectorAll('[role="tabpanel"][data-panel]')];
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;}
function append(target,children){target.replaceChildren(...children);}
function statusName(s){return s==="healthy"?"Healthy":s==="warning"?"Warning":"Critical";}
function statusPill(s){const node=el("span","pill "+(s==="healthy"?"":s),statusName(s));return node;}
function signalRow(name,level,subtitle,display=statusName(level)){
 const row=el("div","signal-row");
 const left=el("div","signal-left");
 const dot=el("span","signal-dot "+(level==="healthy"?"":level));dot.setAttribute("aria-hidden","true");
 const title=el("div","signal-name",name);title.append(el("small","signal-meta",subtitle));
 left.append(dot,title);row.append(left,el("span","signal-state "+(level==="healthy"?"":level),display));
 return row;
}
function renderRows(id,rows){
 const target=$(id);append(target,rows);
}
function td(text,cls=""){return el("td",cls,text);}
function renderTable(id,data,mapper){
 renderRows(id,data.map(entry=>{const row=el("tr");for(const cell of mapper(entry)){row.append(cell);}return row;}));
}
function filterDomains(){const q=$("domain-search").value.trim().toLowerCase();const s=scenarios[active];const records=s.domains.filter(x=>!q||x[0].toLowerCase().includes(q));renderTable("domain-table",records,x=>[td(x[0]),(()=>{const n=el("td");n.append(statusPill(x[1]));return n;})(),td(x[2],"cell-muted"),td(x[3],"cell-muted")]);if(!records.length){const tr=el("tr"),cell=el("td","cell-muted","No matching synthetic domains.");cell.colSpan=4;tr.append(cell);$("domain-table").append(tr);}}
function alertsPanel(s){
 const rows=s.alerts.map(x=>{
  const row=el("div","demo-alert");const text=el("div");text.append(el("strong","",x.title),el("p","",x.description));const btn=el("button","",ack.has(x.id)?"Acknowledged":"Acknowledge sample");
  btn.disabled=ack.has(x.id);btn.addEventListener("click",()=>{ack.add(x.id);render();});
  row.append(text,btn);return row;
 });
 if(!rows.length)rows.push(el("div","empty-state","No simulated alerts in this scenario."));
 renderRows("alerts-table",rows);
 const preview=s.alerts.length?s.alerts.map(x=>signalRow(x.title,ack.has(x.id)?"healthy":x.level,ack.has(x.id)?"Sample acknowledged":x.description,ack.has(x.id)?"Acknowledged":"Needs review")):[signalRow("No sample alerts","healthy","Select another scenario to replay a fictional incident.","Clear")];
 renderRows("alert-preview",preview);
}
function render(){
 const s=scenarios[active];$("snapshot").value=String(active);
 $("metric-checks").textContent=String(s.checks);
 $("metric-domains").textContent=String(s.domains.length).padStart(2,"0");
 $("metric-providers").textContent=String(s.providers.length).padStart(2,"0");
 const unack=s.alerts.filter(x=>!ack.has(x.id));
 $("metric-alerts").textContent=String(unack.length).padStart(2,"0");
 $("tab-alert-count").textContent=String(unack.length);
 $("scenario-status").textContent=unack.length?unack.length+" sample event(s) need review":"All sample signals normal";
 $("scenario-status").classList.toggle("attention",unack.length>0);
 $("activity-copy").textContent=s.activity;
 renderRows("domain-preview",s.domains.map(x=>signalRow(x[0],x[1],x[3])));
 renderRows("node-preview",s.providers.map(x=>signalRow(x[0],x[1],"Fictional test node",x[2])));
 const chart=s.bars.map(h=>{const bar=el("span");bar.style.height=h+"%";return bar;});renderRows("trend-bars",chart);
 filterDomains();
 renderTable("provider-table",s.providers,x=>[td(x[0]),(()=>{const n=el("td");n.append(statusPill(x[1]));return n;})(),td(x[2],"cell-muted"),td(x[3],"cell-muted")]);
 renderTable("search-table",s.search,x=>[td(x[0]),td("#"+x[1]),td(x[2]),(()=>{const n=el("td");n.append(statusPill(x[3]));return n;})()]);
 alertsPanel(s);
}
function switchTab(name,focus=false){
 for(const t of tabs){const on=t.dataset.tab===name;t.setAttribute("aria-selected",String(on));t.tabIndex=on?0:-1;if(on&&focus)t.focus();}
 for(const p of panels)p.hidden=p.dataset.panel!==name;
}
tabs.forEach((t,i)=>{
 t.addEventListener("click",()=>switchTab(t.dataset.tab));
 t.addEventListener("keydown",event=>{
  const jump=event.key==="ArrowRight"?1:event.key==="ArrowLeft"?-1:null;
  if(jump===null&&event.key!=="Home"&&event.key!=="End")return;
  event.preventDefault();
  const next=event.key==="Home"?0:event.key==="End"?tabs.length-1:(i+jump+tabs.length)%tabs.length;
  switchTab(tabs[next].dataset.tab,true);
 });
});
$("snapshot").addEventListener("change",event=>{active=Number(event.target.value)||0;ack=new Set();render();});
$("replay").addEventListener("click",()=>{active=(active+1)%scenarios.length;ack=new Set();render();});
$("domain-search").addEventListener("input",filterDomains);
switchTab("overview");render();
})();
