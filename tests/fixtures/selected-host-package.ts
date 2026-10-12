import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Ordinary self-contained fixture package; all SDK/runtime behavior is production code. */
export function writeSelectedHostPackage(root: string, key: "a" | "b", version = "1.0.0"): string {
  const source = join(root, "source");
  mkdirSync(join(source, "dist"), { recursive: true }); mkdirSync(join(source, "schemas"), { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: `remote-only-notes-${key}`, version, wolfpack: { manifestVersion: 1, apiVersion: 1, id: "notes", ui: "dist/ui.js", skills: [], documents: [{ id: "context", schemaVersion: 1, schema: "schemas/context.json" }] } }));
  writeFileSync(join(source, "schemas/context.json"), JSON.stringify({ type: "string" }));
  writeFileSync(join(source, "dist/ui.js"), `
    globalThis.remoteBundleEvaluations=(globalThis.remoteBundleEvaluations||0)+1;
    export default host=>{
      host.registerTerminalLayout({id:'recipe',title:'Peer ${key} recipe',arrange(context){return{version:1,rows:context.panes.map(()=>({size:1})),columns:[{size:1}],placements:context.panes.map((pane,row)=>({paneId:pane.id,row,column:0}))}}});
      host.registerContextView({id:'scope',title:'Selected notes',mount(root,context){
        const code=document.createElement('p'),doc=document.createElement('p'),git=document.createElement('p'),draft=document.createElement('textarea');
        code.textContent='code ${key} ${version}';code.dataset.peerCode='${key}';doc.dataset.peerDocument='${key}';git.dataset.peerGit='${key}';
        draft.setAttribute('aria-label','Selected widget draft');draft.value=context.storage.get('draft')||'';
        draft.oninput=()=>context.storage.set('draft',draft.value);root.append(code,doc,git,draft);
        (globalThis.remoteContexts||(globalThis.remoteContexts=[])).push(context);
        context.documents.subscribe('context',value=>doc.textContent=value||'empty');
        context.project.gitStatus().then(value=>git.textContent=value.state==='ready'?value.branch+':'+value.untracked.map(file=>file.path).join(','):value.state).catch(()=>{if(!context.signal.aborted)git.textContent='git unavailable'});
        return{dispose(){globalThis.remoteViewDisposals=(globalThis.remoteViewDisposals||0)+1}};
      }});
    };\n`);
  return source;
}
