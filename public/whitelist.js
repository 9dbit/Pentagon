"use strict";
(() => {
  function ready(){
    const modal=document.querySelector("#wl-modal");
    const form=document.querySelector("#wl-form");
    const status=document.querySelector("#wl-status");
    const email=document.querySelector("#wl-email");
    if(!modal||!form||!status||!email)return;
    let previous=null;
    const btn=form.querySelector(".wl-submit");
    const menu=document.querySelector(".lp-nav-links");
    const hamburger=document.querySelector(".lp-hamburger");
    function closeMenu(){
      menu?.classList.remove("open");
      hamburger?.setAttribute("aria-expanded","false");
    }
    hamburger?.addEventListener("click",()=>{
      const opened=menu?.classList.toggle("open");
      hamburger.setAttribute("aria-expanded",String(Boolean(opened)));
    });
    document.querySelectorAll("[data-scroll-to]").forEach(button=>{
      button.addEventListener("click",()=>{
        const target=document.getElementById(button.getAttribute("data-scroll-to"));
        closeMenu();
        target?.scrollIntoView({behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth"});
      });
    });
    function openModal(){
      previous=document.activeElement;
      closeMenu();
      modal.hidden=false;
      modal.setAttribute("aria-hidden","false");
      document.body.classList.add("wl-open");
      status.textContent="";
      status.className="wl-message";
      setTimeout(()=>email.focus(),0);
    }
    function closeModal(){
      modal.hidden=true;
      modal.setAttribute("aria-hidden","true");
      document.body.classList.remove("wl-open");
      if(previous&&typeof previous.focus==="function")previous.focus();
    }
    document.querySelectorAll("[data-wl-open]").forEach(button=>button.addEventListener("click",openModal));
    modal.querySelectorAll("[data-wl-close]").forEach(button=>button.addEventListener("click",closeModal));
    document.addEventListener("keydown",event=>{
      if(modal.hidden)return;
      if(event.key==="Escape")closeModal();
      if(event.key==="Tab"){
        const focusable=[...modal.querySelectorAll("button:not(:disabled),input:not([tabindex='-1']),a[href]")].filter(x=>x.getClientRects().length);
        if(!focusable.length)return;
        if(event.shiftKey&&document.activeElement===focusable[0]){event.preventDefault();focusable.at(-1).focus();}
        else if(!event.shiftKey&&document.activeElement===focusable.at(-1)){event.preventDefault();focusable[0].focus();}
      }
    });
    form.addEventListener("submit",async(event)=>{
      event.preventDefault();
      if(!form.reportValidity())return;
      const address=email.value.trim();
      const consent=form.elements.namedItem("consent")?.checked===true;
      if(!address||!consent)return;
      btn.disabled=true;
      const oldText=btn.textContent;
      btn.textContent="Submitting…";
      status.textContent="";status.className="wl-message";
      try{
        const res=await fetch("/api/whitelist",{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify({
          email:address, consent, companyWebsite:form.elements.namedItem("companyWebsite")?.value||""
        })});
        let result={};try{result=await res.json()}catch{}
        if(!res.ok)throw Error(result.error||"The request could not be saved. Please try later.");
        status.className="wl-message is-success";
        status.textContent="Request received. Your email is pending review; access is not activated automatically.";
        form.reset();
      } catch(err){
        status.className="wl-message is-error";
        status.textContent=err.message||"The request could not be saved. Please try later.";
      } finally{
        btn.disabled=false;
        btn.textContent=oldText;
      }
    });
    document.querySelectorAll("a[href^='#']").forEach(a=>a.addEventListener("click",()=>closeMenu()));
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ready,{once:true});
  else ready();
})();
