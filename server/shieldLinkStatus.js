"use strict";
const crypto=require("crypto");
const states={
  unavailable:{title:"Tujuan belum tersedia",message:"Link ini belum memiliki tujuan yang lolos pemeriksaan. Hubungi pemilik link untuk memperbarui tujuan, atau coba kembali nanti."},
  paused:{title:"Link sedang dijeda",message:"Pemilik link belum mengaktifkan atau sedang menjeda link ini. Hubungi pemilik link untuk informasi lebih lanjut."},
  missing:{title:"Link tidak ditemukan",message:"Periksa kembali alamat link yang Anda terima, atau minta link terbaru kepada pengirim."},
  service:{title:"Layanan sementara tidak tersedia",message:"Kami belum dapat memeriksa tujuan link. Silakan coba kembali beberapa saat lagi."}
};
function sendShieldStatus(res,state,slug){
  const view=states[state]||states.service,nonce=crypto.randomBytes(18).toString("base64");
  const retry=state!=="missing"&&/^[a-zA-Z0-9_-]{8,40}$/.test(slug||"");
  res.set({"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Robots-Tag":"noindex, nofollow",
    "Content-Security-Policy":`default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    "X-Content-Type-Options":"nosniff"});
  if(state!=="missing")res.set("Retry-After","60");
  return res.status(state==="missing"?404:503).type("html").send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${view.title} · Pentagon Shieldlink</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;min-height:100svh;background:#101216;color:#f1f3f7;font:16px/1.7 system-ui,sans-serif;display:grid;place-items:center;padding:28px}main{width:100%;max-width:520px}.brand{color:#f97316;font-weight:800;letter-spacing:.16em;font-size:14px}.tag{color:#9aa7ba;font-size:12px;letter-spacing:.12em;margin:42px 0 12px}h1{font-size:clamp(28px,6vw,38px);line-height:1.2;margin:0 0 18px;letter-spacing:-.025em}p{color:#abb7c8;margin:0 0 26px}a{display:inline-block;background:#f97316;color:#171717;border-radius:100px;padding:11px 24px;font-weight:700;text-decoration:none}a:focus-visible{outline:3px solid #fff;outline-offset:5px}footer{border-top:1px solid #ffffff19;margin-top:42px;padding-top:18px;color:#8391a4;font-size:12px}</style></head>
<body><main><div class="brand">PENTAGON</div><div class="tag">SHIELDLINK</div><h1>${view.title}</h1><p>${view.message}</p>${retry?`<a href="/s/${slug}">Coba lagi</a>`:""}<footer>Pengalihan akan tersedia setelah link aktif dan tujuan memenuhi pemeriksaan.</footer></main></body></html>`);
}
module.exports={sendShieldStatus};
