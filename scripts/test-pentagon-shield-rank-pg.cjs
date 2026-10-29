"use strict";
const assert=require("node:assert/strict"),express=require("express"),{Pool}=require("pg");
const url=process.env.DATABASE_URL||"";
if(process.env.CI!=="true"||!/^postgres(?:ql)?:\/\/[^@]*@(?:127\.0\.0\.1|localhost):5432\//.test(url))throw Error("LOCAL_CI_POSTGRES_REQUIRED");
const db=new Pool({connectionString:url,ssl:false,options:"-c search_path=pentagon_shield_ci,public"});
const {initializeShieldSchema,createShieldLinkRouter,createShieldRedirectRouter}=require("../server/shieldLinkRoutes");
const {rankCheckerEvidence,keyFor}=require("../server/rankCheckerEvidence");
const {createMerchantAdminRouter}=require("../server/merchantAdminRoutes");
const {createCustomerViewerRouter}=require("../server/customerViewerRoutes");
const {customerViewerFirewall}=require("../server/customerViewerAuth");
process.env.PENTAGON_CUSTOMER_VIEWERS_JSON=JSON.stringify([
  {email:"a@example.com",tenant:"merchant_a",role:"merchant_admin"},
  {email:"b@example.com",tenant:"merchant_b",role:"merchant_admin"},
  {email:"viewer@example.com",tenant:"merchant_a",role:"customer_viewer"}
]);
let server,base,passed=0;
async function test(label,fn){await fn();passed++;console.log("PASS "+label);}
async function req(path,{method="GET",body,who="a",origin}={}){
  const r=await fetch(base+path,{method,redirect:"manual",headers:{"x-fixture":who,...(body?{"content-type":"application/json"}:{}),...(origin?{origin}:{})},body:body?JSON.stringify(body):undefined});
  const raw=await r.text();let data;try{data=JSON.parse(raw);}catch(_){data=raw;}
  return {status:r.status,data,headers:r.headers};
}
async function main(){try{
  await db.query("CREATE SCHEMA pentagon_shield_ci");
  await db.query("CREATE TABLE domains(id SERIAL PRIMARY KEY,tenant TEXT,domain TEXT UNIQUE,project_name TEXT,is_active BOOLEAN DEFAULT TRUE,global_status TEXT DEFAULT 'working',last_checked_at TIMESTAMPTZ DEFAULT NOW())");
  await db.query("CREATE TABLE provider_nodes(id SERIAL PRIMARY KEY,tenant TEXT,provider_name TEXT,is_active BOOLEAN DEFAULT TRUE,secret_key TEXT)");
  await db.query("CREATE TABLE check_results(id SERIAL PRIMARY KEY,domain_id INT,checker_type TEXT,provider_name TEXT,status TEXT,checked_at TIMESTAMPTZ DEFAULT NOW())");
  await db.query("CREATE TABLE trustpositif_domain_monitor(tenant TEXT,domain TEXT,registry_listed BOOLEAN,registry_checked_at TIMESTAMPTZ)");
  await db.query("CREATE TABLE rank_keyword_groups(id SERIAL PRIMARY KEY,tenant TEXT)");
  await db.query("CREATE TABLE rank_keyword_domains(group_id INT,domain TEXT,is_whitelisted BOOLEAN)");
  await initializeShieldSchema(db);await initializeShieldSchema(db);
  await db.query("INSERT INTO domains(tenant,domain,project_name) VALUES ('merchant_a','primary.example','A'),('merchant_a','first.example','A'),('merchant_a','second.example','A'),('merchant_b','foreign.example','B')");
  await db.query("INSERT INTO provider_nodes(tenant,provider_name,secret_key) VALUES ('admin','Telkomsel','NEVER_SHOW_SECRET'),('admin','XL','NEVER_SHOW_SECRET'),('admin','XL','NEVER_SHOW_SECRET'),('merchant_b','PrivateNode','FOREIGN_SECRET')");
  await db.query("UPDATE provider_nodes SET is_active=FALSE WHERE id=3");
  await db.query("INSERT INTO rank_keyword_groups(tenant) VALUES ('merchant_a'),('merchant_b')");
  await db.query("INSERT INTO rank_keyword_domains VALUES (1,'primary.example',TRUE),(1,'first.example',TRUE),(1,'foreign.example',TRUE),(2,'foreign.example',TRUE)");
  await db.query("INSERT INTO trustpositif_domain_monitor VALUES ('merchant_a','primary.example',TRUE,NOW()),('merchant_b','foreign.example',TRUE,NOW())");
  await db.query("INSERT INTO check_results(domain_id,checker_type,provider_name,status,node_id) VALUES (1,'node:mobile','Telkomsel','warning',1),(1,'node:mobile','XL','working',NULL),(4,'node:mobile','Telkomsel','blocked',1)");
  const app=express();app.use(express.json());app.use((req,res,next)=>{
    const who=req.headers['x-fixture'];
    req.session=who==='admin'?{isAdmin:true,isDemo:false,tenant:'admin'}:
      ['a','b','viewer'].includes(who)?{isCustomerViewer:true,isAdmin:false,isDemo:false,tenant:who==='b'?'merchant_b':'merchant_a',adminEmail:who==='viewer'?'viewer@example.com':who+'@example.com'}:null;next();
  });
  app.use('/api',customerViewerFirewall);app.use('/api/merchant',createMerchantAdminRouter(db));
  app.use('/api/customer',createCustomerViewerRouter(db));app.use('/api/shield-link',createShieldLinkRouter(db));app.use('/s',createShieldRedirectRouter(db));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
  await test('Evidence endpoints isolate tenant, include inactive nodes and never attribute ambiguous provider history',async()=>{
    const r=await req('/api/merchant/rank-checkers?tenant=merchant_b');assert.equal(r.status,200);
    assert.deepEqual(r.data.domains.map(d=>d.domain),['primary.example','first.example']);assert.equal(r.data.nodes.length,3);
    assert.ok(!JSON.stringify(r.data).includes('SECRET'));assert.ok(!JSON.stringify(r.data).includes('foreign.example'));
    const d=r.data.domains[0];assert.equal(d.ai.text,'Tercatat registry');assert.equal(d.node_results[keyFor(1)].state,'warning');
    assert.equal(d.node_results[keyFor(2)].state,'unknown');assert.equal(d.node_results[keyFor(3)].state,'unknown');
    assert.equal(r.data.nodes[2].is_active,false);
    assert.equal((await req('/api/customer/rank-checkers?tenant=merchant_b',{who:'viewer'})).status,200);
    assert.equal((await req('/api/merchant/shield-link',{who:'viewer'})).status,403);
  });
  await test('Two same-provider nodes keep separate results; unique historic provider results are explicitly labelled',async()=>{
    await db.query("INSERT INTO check_results(domain_id,checker_type,provider_name,status,node_id) VALUES (1,'node:mobile','XL','warning',2),(1,'node:mobile','XL','working',3),(2,'node:mobile','Telkomsel','working',NULL)");
    const e=await rankCheckerEvidence('merchant_a',db),d=e.domains[0];
    assert.equal(d.node_results[keyFor(2)].state,'warning');assert.equal(d.node_results[keyFor(3)].state,'working');
    assert.equal(e.domains[1].node_results[keyFor(1)].attribution,'provider_history');
  });
  let link,other;
  await test('Merchant creates a stable shortlink for only its own active project domain',async()=>{
    const r=await req('/api/merchant/shield-link',{method:'POST',body:{label:'Fixture',project_name:'A',primary_url:'https://primary.example/main'}});
    assert.equal(r.status,201);link=r.data;assert.match(link.shortlink,/^https:\/\/pentagon\.quest\/s\//);
    const f=await req('/api/merchant/shield-link',{method:'POST',body:{project_name:'B',primary_url:'https://foreign.example'}});assert.equal(f.status,400);
    other=(await req('/api/merchant/shield-link',{who:'b',method:'POST',body:{project_name:'B',primary_url:'https://foreign.example'}})).data;
    assert.ok(other.id);
  });
  await test('Foreign links cannot be read, edited, deleted, reordered or extended',async()=>{
    const r=await req('/api/merchant/shield-link?tenant=merchant_b');assert.equal(r.data.links.length,1);assert.equal(r.data.links[0].id,link.id);
    for(const [suffix,method,body] of [['','PATCH',{label:'intrusion'}],['','DELETE',null],['/domains','POST',{domain_url:'https://first.example'}],['/order','PUT',{ids:[]}]])
      assert.equal((await req('/api/merchant/shield-link/'+other.id+suffix,{method,body})).status,404);
    assert.equal((await req('/api/merchant/shield-link/'+link.id,{method:'PATCH',body:{label:'x'},origin:'https://evil.example'})).status,403);
    assert.equal((await req('/api/shield-link',{who:'a'})).status,403);
  });
  await test('Fallback order selects only fresh eligible owned destinations, with non-caching public redirect and exact count',async()=>{
    for(const domain of ['first.example','second.example'])assert.equal((await req('/api/merchant/shield-link/'+link.id+'/domains',{method:'POST',body:{domain_url:'https://'+domain+'/landing'}})).status,201);
    const listing=(await req('/api/merchant/shield-link')).data.links[0];assert.equal(listing.target.reason,'fallback');
    assert.equal(listing.target.url,'https://first.example/landing');
    const ids=listing.domains.map(d=>d.id).reverse();assert.equal((await req('/api/merchant/shield-link/'+link.id+'/order',{method:'PUT',body:{ids}})).status,200);
    let r=await req('/s/'+link.slug+'?url=https://foreign.example',{who:'anon',method:'HEAD'});assert.equal(r.status,302);assert.equal(r.headers.get('location'),'https://second.example/landing');
    assert.equal(Number((await db.query('SELECT redirect_count FROM shield_links WHERE id=$1',[link.id])).rows[0].redirect_count),0);
    r=await req('/s/'+link.slug,{who:'anon'});assert.equal(r.status,302);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('referrer-policy'),'no-referrer');
    assert.equal(Number((await db.query('SELECT redirect_count FROM shield_links WHERE id=$1',[link.id])).rows[0].redirect_count),1);
    await db.query("UPDATE domains SET last_checked_at=NOW()-INTERVAL '2 days' WHERE domain='second.example'");
    assert.equal((await req('/s/'+link.slug,{who:'anon'})).headers.get('location'),'https://first.example/landing');
    await db.query("UPDATE domains SET is_active=FALSE WHERE domain='first.example'");
    assert.equal((await req('/s/'+link.slug,{who:'anon'})).status,503);
  });
  await test('Primary recovery, pause, deletion and no-destination response preserve failover integrity',async()=>{
    await db.query("UPDATE trustpositif_domain_monitor SET registry_listed=FALSE WHERE tenant='merchant_a'");
    assert.equal((await req('/s/'+link.slug,{who:'anon'})).headers.get('location'),'https://primary.example/main');
    await req('/api/merchant/shield-link/'+link.id,{method:'PATCH',body:{is_active:false}});
    assert.equal((await req('/s/'+link.slug,{who:'anon'})).status,503);
    assert.equal((await req('/api/merchant/shield-link/'+link.id,{method:'DELETE'})).status,200);
    assert.equal((await req('/s/'+link.slug,{who:'anon'})).status,404);
    assert.equal((await db.query('SELECT COUNT(*)::int n FROM shield_link_domains WHERE link_id=$1',[link.id])).rows[0].n,0);
    const rls=await db.query("SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pentagon_shield_ci' AND c.relname IN ('shield_links','shield_link_domains')");
    assert.equal(rls.rows.length,2);assert.ok(rls.rows.every(r=>r.relrowsecurity));
  });
  console.log('SHIELD_RANK_POSTGRES_PASS='+passed);
}finally{if(server)await new Promise(resolve=>server.close(resolve));await db.query('DROP SCHEMA IF EXISTS pentagon_shield_ci CASCADE');await db.end();}}
main().catch(e=>{console.error(e);process.exitCode=1;});
