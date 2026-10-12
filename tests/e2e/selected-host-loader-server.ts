#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSelectedHostFixture, SELECTED_HOST_SESSION } from "../fixtures/selected-host-extensions.ts";

const entry = process.env.WOLFPACK_TEST_EXTENSION_GATE_BUNDLE;
if (!entry || !process.env.HOME) throw new Error("owned loader gate configuration missing");
const fixture = await createSelectedHostFixture({ handleLocalRequest: (_req, res, url) => {
  if (url.pathname !== "/api/extensions/fixture/measurements") return false;
  const peers = Object.fromEntries(fixture.peers.map(peer => {
    const paths = peer.trace.map(value => value.path), assetRequests = paths.filter(path => path.startsWith("/api/extensions/assets/"));
    return [peer.key, { paths, rpcCounts: {
      publicHandshake: paths.filter(path => path === "/api/machine").length,
      catalogPolicy: paths.filter(path => path === "/api/extensions").length,
      assets: assetRequests.length,
      documents: paths.filter(path => path.startsWith("/api/extensions/documents/")).length,
      git: paths.filter(path => path.startsWith("/api/extensions/project/")).length,
    }, inferredAssetPayloadBytes: assetRequests.length * readFileSync(join(fixture.root, peer.key, "source/dist/ui.js")).byteLength }];
  }));
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ peers })); return true;
} });
const { assets } = await import("../../src/public-assets.ts");
assets.set("extension-gate.js", { content: readFileSync(entry), mime: "text/javascript" });
const readyPeers = Object.fromEntries(fixture.peers.map(peer => [peer.identity, { identity: peer.identity, status: "ready", origin: peer.origin, displayName: `Peer ${peer.key}` }]));
assets.set("index.html", { mime: "text/html", content: `<body><input aria-label="Ordinary input"><button id="a">Select A</button><button id="b">Select B</button><button id="local">Select local</button><output id="ready">loading</output><div id="widgets"></div>
<dialog id="app-dialog"><form id="app-dialog-form"><h2 id="app-dialog-title"></h2><p id="app-dialog-message"></p><div id="app-dialog-fields"></div><button id="app-dialog-cancel" type="button"></button><button id="app-dialog-confirm" type="submit"></button></form></dialog>
<script type="module">import { ExtensionHost, SelectedHostExtensionTransport, loadAuthenticatedExtensionBundle, EXTENSION_BUNDLE_MAX_BYTES } from '/extension-gate.js';
const peers=${JSON.stringify(readyPeers)}, ids=${JSON.stringify(Object.fromEntries(fixture.peers.map(peer => [peer.key, peer.identity])))};
let scope={sessionId:${JSON.stringify(SELECTED_HOST_SESSION)}}; window.nativeProvenance=[];window.loaderTargets=[];window.switchMeasurements=[];
const resolvePeer=machine=>peers[machine]; const transport=new SelectedHostExtensionTransport({resolvePeer});
const host=new ExtensionHost({container:document.querySelector('#widgets'),scope:()=>scope,resolvePeer,
 selectedHostFetch:async(scope,input,init)=>{const response=await transport.request(scope,input,init);let observedAssetPayloadBytes;
 // The real transport already bounded and fully acquired a native clone before resolving.
 if(response.ok&&input.startsWith('/api/extensions/assets/')){observedAssetPayloadBytes=(await response.clone().arrayBuffer()).byteLength;if(observedAssetPayloadBytes>EXTENSION_BUNDLE_MAX_BYTES)throw new Error('owned native asset observer exceeded production ceiling')}
 window.nativeProvenance.push({input,url:response.url,redirected:response.redirected,observedAssetPayloadBytes,originalBodyUnused:!response.bodyUsed});return response},
 consentRemoteCode:(scope,catalog,signal)=>transport.consentRemoteCode(scope,catalog,signal),
 bundleLoader:(url,digest,options)=>{window.loaderTargets.push(url);return loadAuthenticatedExtensionBundle(url,digest,options)}});
for(const key of ['a','b','local'])document.querySelector('#'+key).onclick=async()=>{const start=performance.now();scope={sessionId:scope.sessionId,...(key==='local'?{}:{machine:ids[key]})};document.querySelector('#ready').textContent='loading';await host.refresh();host.select();window.switchMeasurements.push({target:key,milliseconds:performance.now()-start,phase:'registration including user consent/scheduling, not complete data latency'});document.querySelector('#ready').textContent=key};
await host.refresh();document.querySelector('#ready').textContent='local';</script></body>` });
console.log(`READY:${new URL(fixture.base).port}`);
let stopping = false;
async function stop(): Promise<void> { if (stopping) return; stopping = true; await fixture.close(); process.exit(0); }
process.stdin.resume(); process.stdin.on("end", () => { void stop(); }); process.on("SIGTERM", () => { void stop(); });
