#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const {createServer} = require("../server/marketingPreviewServer");
async function run() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:"+server.address().port;
  let count=0;
  async function check(p, expectedStatus, expectedMime, validator, options={}) {
    const res=await fetch(url+p,{redirect:"manual", ...options});
    assert.equal(res.status,expectedStatus,p+" status");
    assert.equal(res.headers.get("x-robots-tag"),"noindex, nofollow, noarchive",p+" noindex");
    assert.match(res.headers.get("content-type")||"",expectedMime,p+" mime");
    if(validator) await validator(res);
    count++;
  }
  try {
    await check("/",302,/text\/plain/,r=>assert.equal(r.headers.get("location"),"/learn/"));
    await check("/learn",302,/text\/plain/,r=>assert.equal(r.headers.get("location"),"/learn/"));
    await check("/learn/",200,/text\/html/,async r=>{
      const body=await r.text();
      assert.match(body,/<main\b/);
      assert.match(body,/<h1\b/);
      assert.match(body,/<meta name="robots" content="noindex,nofollow/);
      assert.match(body,/<link rel="canonical" href="https:\/\/pentagon\.quest\//);
      assert.match(body,/<meta property="og:image"/);
      assert.match(body,/href="https:\/\/pentagon\.quest\/"/);
      assert.match(body,/id="wl-form"/); assert.match(body,/name="consent" required/);
    });
    await check("/robots.txt",200,/text\/plain/,async r=>{
      const b=await r.text();assert.match(b,/Disallow: \//);assert.doesNotMatch(b,/<html/i)
    });
    await check("/sitemap.xml",200,/application\/xml/,async r=>{
      const b=await r.text();assert.match(b,/<urlset/);assert.match(b,/pentagon\.quest\/learn/);
    });
    await check("/privacy/",200,/text\/html/,async r=>assert.match(await r.text(),/Whitelist Privacy Notice/));
    await check("/logo-icon.png",200,/image\/png/);
    await check("/pentagon-icon.svg",200,/image\/svg\+xml/,async r=>assert.match(await r.text(),/<svg/));
    await check("/og-image.png",200,/image\/png/,async r=>assert.ok((await r.arrayBuffer()).byteLength>1000));
    await check("/health",200,/application\/json/,async r=>{
      assert.deepEqual(await r.json(),{ok:true,service:"pentagon-marketing-rc1",database:"not-connected",scheduler:"disabled"})
    });
    await check("/api/whitelist",503,/application\/json/,null,{method:"POST"});
    await check("/api/health",404,/text\/plain/);
    await check("/api/domains",404,/text\/plain/);
    await check("/../../server/index.js",404,/text\/plain/);
    await check("/learn/",200,/text\/html/,async r=>assert.equal((await r.text()).length,0),{method:"HEAD"});
    await check("/learn/",405,/application\/json/,null,{method:"POST"});
    console.log("PENTAGON_PREVIEW_HTTP_TESTS_PASS="+count);
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
}
run().catch(e=>{console.error("PENTAGON_PREVIEW_TEST_FAILED="+e.message);process.exitCode=1});
