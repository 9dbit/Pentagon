"use strict";
(()=>{
const $=id=>document.getElementById(id);
const state={csrf:"",offset:0,total:0,search:"",status:"all",busy:false,authenticated:false};
const login=$("signin"),dash=$("dashboard"),logout=$("logout"),tbody=$("request-rows"),loginStatus=$("login-status"),reviewStatus=$("review-status");
const caption=$("pagination-label"),prev=$("previous"),next=$("next");
function message(target,text,success=false){target.textContent=text||"";target.classList.toggle("success",!!success);}
function loggedIn(auth){state.authenticated=auth;login.hidden=auth;dash.hidden=!auth;logout.hidden=!auth;message(loginStatus,"");}
async function api(url,opts={}){
 const headers={"Accept":"application/json",...(opts.body?{"Content-Type":"application/json"}:{}),...(opts.method&&opts.method!=="GET"&&state.csrf?{"X-CSRF-Token":state.csrf}:{})};
 const res=await fetch(url,{credentials:"same-origin",cache:"no-store",...opts,headers:{...headers,...opts.headers}});
 if(!res.ok){
   let error="Request failed. Try again.";
   try{error=(await res.json()).error||error}catch{}
   if(res.status===401&&url!=="/api/whitelist-review/login"){state.csrf="";loggedIn(false);}
   throw Error(error);
 }
 return res;
}
function button(text,cls,cb,disabled=false){
 const b=document.createElement("button");b.type="button";b.className="action "+cls;b.textContent=text;b.disabled=disabled;b.addEventListener("click",cb);return b;
}
const fmt=raw=>{const d=new Date(raw);return Number.isFinite(d.getTime())?d.toLocaleString("en-GB",{dateStyle:"medium",timeStyle:"short"}):"—";};
function row(item){
 const tr=document.createElement("tr");
 const email=document.createElement("td");email.className="email";email.textContent=item.email;tr.append(email);
 const submitted=document.createElement("td");submitted.className="date";submitted.textContent=fmt(item.requestedAt);tr.append(submitted);
 const statusTd=document.createElement("td");const badge=document.createElement("span");badge.className="status "+item.status;badge.textContent=item.status==="approved"?"Approved for contact":item.status==="rejected"?"Rejected":"Pending";statusTd.append(badge);tr.append(statusTd);
 const reviewed=document.createElement("td");reviewed.className="date";reviewed.textContent=fmt(item.reviewedAt);tr.append(reviewed);
 const actions=document.createElement("td");const buttons=document.createElement("div");buttons.className="action-row";
 buttons.append(button("Approve","approve",()=>decide(item,"approved"),item.status==="approved"),
  button("Reject","reject",()=>decide(item,"rejected"),item.status==="rejected"),
  button("Reopen","",()=>decide(item,"pending"),item.status==="pending"),
  button("Delete","delete",()=>remove(item)));
 actions.append(buttons);tr.append(actions);return tr;
}
async function refresh(){
 if(!state.authenticated||state.busy)return;
 message(reviewStatus,"Loading...");
 const qs=new URLSearchParams({status:state.status,q:state.search,offset:String(state.offset)});
 try{
  const res=await api("/api/whitelist-review/requests?"+qs.toString());
  const data=await res.json();tbody.replaceChildren(...data.items.map(row));
  if(!data.items.length){const tr=document.createElement("tr");const td=document.createElement("td");td.colSpan=5;td.textContent="No applications match this filter.";tr.append(td);tbody.append(tr);}
  state.total=data.total;
  for(const key of ["all","pending","approved","rejected"])$("count-"+key).textContent=String(data.counts[key]||0);
  caption.textContent=state.total?(state.offset+1)+"–"+Math.min(state.offset+data.limit,state.total)+" of "+state.total+" matching requests":"No matching requests";
  prev.disabled=state.offset===0;next.disabled=state.offset+data.limit>=state.total;
  message(reviewStatus,"");
 }catch(e){message(reviewStatus,e.message);}
}
async function action(url,data,success){
 if(state.busy)return;state.busy=true;message(reviewStatus,"Saving...");
 try{await api(url,{method:"POST",body:JSON.stringify(data)});state.offset=0;message(reviewStatus,success,true);}
 catch(e){message(reviewStatus,e.message);state.busy=false;return;}
 state.busy=false;await refresh();message(reviewStatus,success,true);
}
async function decide(item,status){
 if(status==="approved"&&!confirm("Approve "+item.email+" for outreach review only? This does not activate a Pentagon account."))return;
 if(status==="rejected"&&!confirm("Reject this whitelist request?"))return;
 await action("/api/whitelist-review/decision",{email:item.email,status},"Review status saved. No dashboard access was changed.");
}
async function remove(item){
 if(!confirm("Permanently delete the stored email "+item.email+" from this staging whitelist?"))return;
 await action("/api/whitelist-review/delete",{email:item.email,confirm:"DELETE"},"Request email deleted from staging.");
}
$("login-form").addEventListener("submit",async e=>{
 e.preventDefault();
 const secret=$("review-password").value;const submit=e.target.querySelector("button[type=submit]");
 submit.disabled=true;message(loginStatus,"Checking access...");
 try{
  const res=await api("/api/whitelist-review/login",{method:"POST",body:JSON.stringify({password:secret})});
  const data=await res.json();state.csrf=data.csrf;$("review-password").value="";loggedIn(true);await refresh();
 }catch(err){message(loginStatus,err.message);}
 finally{submit.disabled=false;}
});
logout.addEventListener("click",async()=>{try{await api("/api/whitelist-review/logout",{method:"POST",body:"{}"});}catch{}state.csrf="";loggedIn(false);});
$("refresh").addEventListener("click",refresh);
$("filter-status").addEventListener("change",e=>{state.status=e.target.value;state.offset=0;refresh();});
let debounce=null;
$("search").addEventListener("input",e=>{state.search=e.target.value.trim().slice(0,80);state.offset=0;clearTimeout(debounce);debounce=setTimeout(refresh,260);});
prev.addEventListener("click",()=>{state.offset=Math.max(0,state.offset-100);refresh();});
next.addEventListener("click",()=>{state.offset+=100;refresh();});
$("prune").addEventListener("click",async()=>{if(!confirm("Remove requests older than 365 days from private staging storage?"))return;await action("/api/whitelist-review/prune",{},"Retention cleanup complete.");});
(async()=>{try{const res=await api("/api/whitelist-review/session");const data=await res.json();
 if(data.authenticated){state.csrf=data.csrf;loggedIn(true);await refresh();}
 else{loggedIn(false);if(!data.configured)message(loginStatus,"Review access is not configured on staging yet. Ask the project owner to enable it.");}
}catch(e){loggedIn(false);message(loginStatus,"Review service unavailable.");}})();
})();