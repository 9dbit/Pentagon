#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const get=p=>fs.readFileSync(path.join(root,p),"utf8");
let passed=0;
function check(name,fn){fn();++passed;console.log("PASS "+name);}
const prefix="android-node-app/app/src/main/java/id/domainradar/node/";
const auto=get(prefix+"AutoProvisioner.java");
const service=get(prefix+"NodeService.java");
const ui=get(prefix+"MainActivity.java");
const prefs=get(prefix+"Prefs.java");
const build=get("android-node-app/app/build.gradle");
const docker=get("android-node-app/Dockerfile");
const manifest=get("android-node-app/app/src/main/AndroidManifest.xml");
check("Provisioned identities survive unavailable temporary SIM operator names",()=>{
  assert.match(auto,/alreadyProvisioned && \(detectedProvider\.isEmpty\(\)/);
  assert.match(auto,/return new Result\(operator, existingProvider, existingNode, false\)/);
  assert.match(auto,/detectedProvider\.equalsIgnoreCase\(existingProvider\)/);
});
check("SIM mismatch is never reported as healthy cellular network",()=>{
  assert.match(service,/correctSim = !mobile \|\|/);
  assert.match(service,/cell\.available && correctSim/);
  assert.match(service,/PROVIDER_IDENTITY_NOT_VERIFIED/);
});
check("Server ACK required for online and missing ACK has diagnostics",()=>{
  assert.match(service,/response\.optBoolean\("ok", false\)/);
  assert.match(service,/last_poll_ok_ms/);
  assert.match(service,/last_poll_error/);
  assert.match(ui,/serverAcknowledgedRecently/);
  assert.match(ui,/enabled && provisioned && cellular && serverAcknowledgedRecently/);
  assert.match(ui,/last_poll_network_ok/);
  assert.match(service,/last_poll_network_ok/);
  assert.match(ui,/Polling Error/);
  assert.match(ui,/No confirmed Railway heartbeat yet/);
  assert.doesNotMatch(ui,/statusSubtitle\.setText\("Running and connected"\)/);
});
check("Prior Replit base URLs safely move to Railway",()=>{
  assert.match(prefs,/lower\.endsWith\("\.replit\.app"\)/);
  assert.match(prefs,/lower\.endsWith\("\.repl\.co"\)/);
  assert.match(prefs,/https:\/\/pentagon-web-production\.up\.railway\.app/);
});
check("Android APK version increments without replacing node app ID",()=>{
  assert.match(build,/versionCode 176/);
  assert.match(build,/versionName '1\.7\.6'/);
  assert.match(build,/applicationId 'com\.pentagon\.providernode'/);
  assert.match(docker,/ENV VERSION_CODE=176/);
  assert.match(docker,/ENV VERSION_NAME=1\.7\.6/);
  assert.match(docker,/1\.7\.6: Android 15 background service compatibility/);
});
check("Android 15 continuous monitoring is not declared as six-hour dataSync FGS",()=>{
  assert.match(manifest,/android\.permission\.FOREGROUND_SERVICE_SPECIAL_USE/);
  assert.match(manifest,/android:foregroundServiceType="specialUse"/);
  assert.match(manifest,/android\.app\.PROPERTY_SPECIAL_USE_FGS_SUBTYPE/);
  assert.doesNotMatch(manifest,/android:foregroundServiceType="dataSync"/);
});
console.log("PENTAGON_ANDROID_HEARTBEAT_RECOVERY_PASS="+passed);
