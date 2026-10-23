#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { signalReading, networkLabel, serializeMerchantNodes } = require("../server/merchantNodeTelemetry");
let passed=0;
function test(name,fn){fn();passed++;console.log("PASS "+name);}
const NOW=Date.parse("2026-10-23T01:00:00.000Z");
const mins=m=>new Date(NOW-m*60*1000);
const base={
  provider_name:"Telkomsel",network_type:"mobile",network_type_label:"NR",
  is_active:true,last_health_status:"online",signal_level:3,signal_percent:null,
  signal_dbm:-82,battery_percent:84,is_charging:true,telemetry_last_seen_at:mins(1),
  secret_key:"NEVER_OUTPUT",endpoint_url:"https://secret.example",ip:"203.0.113.15",
  subscription_id:99,name:"SENSITIVE-JKT-SIM"
};
test("historical 0..4 signal produces five correct bars",()=>{
  assert.deepEqual([0,1,2,3,4].map(signal_level=>signalReading({...base,signal_level}).signal_bars),[0,1,3,4,5]);
  assert.equal(signalReading({...base,signal_level:0}).signal_label,"No Signal");
});
test("percent fallback, dBm fallback and absent telemetry distinct",()=>{
  const q=signalReading({...base,signal_level:null,signal_percent:60,signal_dbm:null});
  assert.equal(q.signal_bars,3);assert.equal(q.signal_label,"Good");
  const low=signalReading({...base,signal_level:null,signal_percent:null,signal_dbm:-120});
  assert.equal(low.signal_bars,0);
  const unknown=signalReading({...base,signal_level:null,signal_percent:null,signal_dbm:null});
  assert.equal(unknown.signal_bars,null);assert.equal(unknown.signal_label,"Unknown");
  assert.equal(signalReading({...base,signal_level:-1,signal_percent:105,signal_dbm:"private"}).signal_bars,null);
});
test("only approved network labels escape serializer",()=>{
  assert.equal(networkLabel("LTE","mobile"),"4G LTE");
  assert.equal(networkLabel("nsa","mobile"),"5G");
  assert.equal(networkLabel("ssid-myprivatehome","mobile"),"Mobile");
  assert.equal(networkLabel("HSPA+","mobile"),"3G");
});
test("recent heartbeat and battery report are valid",()=>{
  const result=serializeMerchantNodes([base],NOW)[0];
  assert.equal(result.public_alias,"TELKOMSEL NODE 01");
  assert.equal(result.network_type,"5G");
  assert.equal(result.signal_bars,4);
  assert.equal(result.connectivity,"online");
  assert.equal(result.is_active,true);
  assert.equal(result.telemetry_fresh,true);
  assert.equal(result.battery_percent,84);
  assert.equal(result.is_charging,true);
});
test("stale heartbeat and disabled flag cannot be online",()=>{
  const rows=[{...base,telemetry_last_seen_at:mins(6)},
    {...base,telemetry_last_seen_at:mins(20)},
    {...base,is_active:false,telemetry_last_seen_at:mins(1)},
    {...base,telemetry_last_seen_at:new Date(NOW+60*1000)}];
  const a=serializeMerchantNodes(rows,NOW);
  assert.deepEqual(a.map(row=>row.connectivity),["waiting","offline","inactive","unknown"]);
  assert.deepEqual(a.map(row=>row.telemetry_fresh),[false,false,true,false]);
  assert.equal(a[3].last_seen_at,null);
});
test("unknown measurements stay N/A and true zero percent stays 0",()=>{
  const [nil,zero]=serializeMerchantNodes([
    {...base,signal_level:null,signal_percent:null,signal_dbm:null,battery_percent:null,is_charging:null,telemetry_last_seen_at:null},
    {...base,signal_level:0,signal_percent:null,signal_dbm:null,battery_percent:0,is_charging:false}
  ],NOW);
  assert.equal(nil.signal_bars,null);
  assert.equal(nil.battery_percent,null);
  assert.equal(nil.is_charging,null);
  assert.equal(nil.connectivity,"unknown");
  assert.equal(zero.signal_bars,0);
  assert.equal(zero.battery_percent,0);
  assert.equal(zero.is_charging,false);
});
test("degraded network is not presented as healthy even with heartbeat",()=>{
  const x=serializeMerchantNodes([{...base,last_health_status:"wrong_network"}],NOW)[0];
  assert.equal(x.connectivity,"degraded");
  assert.equal(x.telemetry_fresh,true);
});
test("IDs, raw node names, SIM, IP and secret never returned",()=>{
  const rows=serializeMerchantNodes([base],NOW);
  const text=JSON.stringify(rows);
  for(const forbidden of ["NEVER_OUTPUT","secret.example","203.0.113.15","SENSITIVE","subscription_id","endpoint_url","secret_key","\"id\"","\"tenant\"","\"ip\"","\"name\""])
    assert.equal(text.includes(forbidden),false,forbidden);
});
console.log("PENTAGON_NODE_HEALTH_V2_UNIT_PASS="+passed);
