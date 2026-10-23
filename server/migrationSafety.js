"use strict";
// Audit-branch only. Does NOT authorize a production schema change or cutover.
const FLEETS=new Set(["pentagon","domain-radar"]);
const TENANTS=new Set(["admin","demo"]);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function resolveAuthenticatedScope(req,settings=process.env){
  if(settings.PENTAGON_FLEET_SAFE_SCHEMA_READY!=="true")throw Error("FLEET_SCHEMA_NOT_VERIFIED");
  const session=req?.session;
  if(session?.isAdmin!==true||!TENANTS.has(session.tenant))throw Error("AUTHENTICATED_TENANT_REQUIRED");
  const fleet=String(settings.PENTAGON_ACTIVE_FLEET||"");
  if(!FLEETS.has(fleet))throw Error("SERVER_FLEET_CONFIGURATION_REQUIRED");
  return Object.freeze({tenant:session.tenant,fleet});
}
function requireAuthenticatedScope(req,res,next){
  try{req.migrationScope=resolveAuthenticatedScope(req);return next();}
  catch(_){return res.status(503).json({error:"Migration-safe tenant/fleet scope is not ready"});}
}
const SQL=Object.freeze({
  domainsList:"SELECT * FROM domains WHERE tenant=$1 AND fleet=$2 ORDER BY id DESC",
  domainCreate:"INSERT INTO domains (domain, project_name, tenant, fleet) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant, fleet, (lower(btrim(domain)))) DO UPDATE SET project_name=EXCLUDED.project_name WHERE domains.tenant=EXCLUDED.tenant AND domains.fleet=EXCLUDED.fleet RETURNING *",
  domainBulk:"INSERT INTO domains (domain, project_name, tenant, fleet) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant, fleet, (lower(btrim(domain)))) DO UPDATE SET project_name=COALESCE(NULLIF(EXCLUDED.project_name,''), domains.project_name) WHERE domains.tenant=EXCLUDED.tenant AND domains.fleet=EXCLUDED.fleet RETURNING *",
  domainPatch:"UPDATE domains SET domain=COALESCE($1,domain), is_active=COALESCE($2,is_active), project_name=COALESCE($3,project_name), label=CASE WHEN $5::text IS NOT NULL THEN $5 ELSE label END WHERE id=$4 AND tenant=$6 AND fleet=$7 RETURNING *",
  domainDelete:"DELETE FROM domains WHERE id=$1 AND tenant=$2 AND fleet=$3 RETURNING id",
  domainCheckLookup:"SELECT * FROM domains WHERE id=$1 AND tenant=$2 AND fleet=$3",
  rankGroupsForDomain:"SELECT id FROM rank_keyword_groups WHERE project_name=$1 AND tenant=$2 AND fleet=$3",
  domainStatusFromTask:"UPDATE domains SET global_status=$1,last_status=$2,last_checked_at=NOW() WHERE id=$3 AND tenant=$4 AND fleet=$5 RETURNING id",
  taskClaim:["UPDATE provider_node_tasks SET status='claimed',claimed_at=NOW()",
    "WHERE id=(SELECT id FROM provider_node_tasks WHERE node_id=$1 AND tenant=$2 AND fleet=$3 AND status='queued'",
    "AND execution_allowed IS TRUE AND dispatch_token IS NOT NULL",
    "ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)",
    "AND tenant=$2 AND fleet=$3 AND status='queued' AND execution_allowed IS TRUE AND dispatch_token IS NOT NULL",
    "RETURNING id,domain,COALESCE(task_type,'domain_check') AS task_type,payload"].join(" "),
  taskLookup:"SELECT status,execution_allowed,dispatch_token,domain_id,tenant,fleet,COALESCE(task_type,'domain_check') AS task_type FROM provider_node_tasks WHERE id=$1 AND node_id=$2 LIMIT 1",
  taskComplete:"UPDATE provider_node_tasks SET status='done',result=$1::jsonb,completed_at=NOW() WHERE id=$2 AND node_id=$3 AND status='claimed' AND execution_allowed IS TRUE AND dispatch_token IS NOT NULL AND tenant=$4 AND fleet=$5 RETURNING id",
  taskNetworkError:"UPDATE provider_node_tasks SET status='error',error=$1,completed_at=NOW() WHERE id=$2 AND node_id=$3 AND status='claimed' AND execution_allowed IS TRUE AND dispatch_token IS NOT NULL AND tenant=$4 AND fleet=$5 RETURNING id",
  taskForDomainStatus:"SELECT domain_id,tenant,fleet FROM provider_node_tasks WHERE id=$1 AND node_id=$2 AND status='done' AND execution_allowed IS TRUE AND dispatch_token IS NOT NULL LIMIT 1"
});
function validNodeScope(node){return !!node&&TENANTS.has(node.tenant)&&FLEETS.has(node.fleet);}
function authorizeNewTask(node,type,options){
  if(!validNodeScope(node))throw Error("NODE_SCOPE_NOT_VERIFIED");
  if(options?.tenant!==node.tenant||options?.fleet!==node.fleet)throw Error("TASK_SCOPE_MISMATCH");
  const id=Number(options.domain_id);
  if(type==="domain_check"&&(!Number.isSafeInteger(id)||id<1))throw Error("SCOPED_DOMAIN_ID_REQUIRED");
  return type==="domain_check"?id:null;
}
function canCompleteTask(task,node){
  return validNodeScope(node)&&!!task&&task.status==="claimed"&&task.execution_allowed===true&&
  typeof task.dispatch_token==="string"&&UUID.test(task.dispatch_token)&&
  task.tenant===node.tenant&&task.fleet===node.fleet;
}
module.exports={resolveAuthenticatedScope,requireAuthenticatedScope,validNodeScope,authorizeNewTask,canCompleteTask,SQL};
