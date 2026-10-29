import {useEffect,useState} from "react";
export default function useRankCheckers(audience) {
  const [state,setState]=useState({nodes:[],domains:[],loading:true,error:""});
  useEffect(()=>{
    let live=true,controller=null;
    const load=async()=>{
      controller?.abort();controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),15000);
      try {
        const path=audience==="admin"?"/api/rank/checker-evidence":"/api/"+audience+"/rank-checkers";
        const response=await fetch(path,{credentials:"include",cache:"no-store",signal:controller.signal});
        if(!response.ok)throw new Error("unavailable");
        const data=await response.json();
        if(live)setState({...data,loading:false,error:""});
      } catch(_) {if(live)setState(old=>({...old,loading:false,error:"Hasil checker belum dapat dimuat; pembacaan tersimpan mungkin sudah lama."}));}
      finally{clearTimeout(timeout);}
    };
    load();const timer=setInterval(load,60000);
    return()=>{live=false;clearInterval(timer);controller?.abort();};
  },[audience]);
  return state;
}
