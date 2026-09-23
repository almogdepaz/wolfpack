import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start, skipIfNoBroker, type BrokerTestServer } from './broker-helpers.ts';
import { createOwnedTestServerHome, removeOwnedTestServerHome, type OwnedTestServerHome } from './test-server-home.ts';

test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
let server: BrokerTestServer, home: OwnedTestServerHome, root: string;
test.beforeAll(async()=>{
 if(skipIfNoBroker.condition)return;
 root=realpathSync(mkdtempSync(join(tmpdir(),'wp-desktop-tools-')));mkdirSync(join(root,'project'));
 home=createOwnedTestServerHome();
 server=await start({envOverrides:{HOME:home.path,WOLFPACK_DEV_DIR:root,WOLFPACK_MACHINE_ID_PATH:join(home.path,'machine-id')}});
 for(const name of ['tools-one','tools-two']){
  const response=await fetch(server.baseUrl+'/api/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:'project',cmd:'shell',sessionName:name})});
  expect(response.ok).toBe(true);
 }
});
test.afterAll(async()=>{await server?.teardown();if(home)removeOwnedTestServerHome(home);if(root)rmSync(root,{recursive:true,force:true})});

test('desktop Workspace tools removes terminal chrome without replacing live terminals',async({page},info)=>{
 test.skip(info.project.name!=='desktop','Desktop-only navigation; mobile toolbar unchanged');
 const sockets:string[]=[];page.on('websocket',socket=>{if(socket.url().includes('/ws/pty'))sockets.push(socket.url())});
 await page.goto(server.baseUrl);await page.locator('.card',{hasText:'tools-one'}).first().click();
 const canvas=page.locator('#desktop-terminal-container canvas');await expect(canvas).toBeVisible();
 // Identifier minification must not leak internals or rename explicit public hooks.
 expect(await page.evaluate(()=>({privateView:typeof (window as any).showView,hooks:Object.keys((window as any).__wolfpackTest)}))).toEqual({privateView:'undefined',hooks:['serializeTerminalTail']});
 await expect(page.getByRole('region',{name:'Workspace tools',exact:true})).toBeVisible();
 await expect(page.locator('.workspace-terminal-toolbar')).toBeHidden();
 const tools=page.locator('#workspace-tools');
 await canvas.evaluate(node=>{(window as any).__toolsCanvas=node});
 const attached=sockets.length;
 const terminal=page.locator('#desktop-terminal-container');
 await terminal.click();await page.keyboard.type("printf 'WP%s\\n' DESKTOP_TOOLS");await page.keyboard.press('Enter');
 const tail=()=>terminal.evaluate(node=>(window as any).__wolfpackTest.serializeTerminalTail(node,100));
 await expect.poll(tail).toContain('WPDESKTOP_TOOLS');
 const collapse=tools.locator('#workspace-context-collapse');const box=await collapse.boundingBox();
 await expect(collapse).toHaveAccessibleName('Hide widgets');
 await collapse.click();await expect(tools.locator('#workspace-restore')).toBeFocused();
 expect(await tools.locator('#workspace-restore').boundingBox()).toEqual(box);
 await tools.locator('#workspace-restore').press('Enter');await expect(collapse).toBeFocused();
 await tools.getByRole('button',{name:'Workspace settings',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Workspace settings',exact:true});await expect(dialog).toBeVisible();
 await expect(dialog.getByRole('combobox',{name:'Terminal layout',exact:true})).toHaveCSS('appearance','auto');
 await dialog.getByRole('combobox',{name:'Terminal layout',exact:true}).selectOption('lead-stack');
 await page.keyboard.press('Escape');await expect(dialog).toBeHidden();
 await expect(tools.getByRole('button',{name:'Workspace settings',exact:true})).toBeFocused();
 await page.locator('#workspace-context-full').click();await expect(page.locator('#workspace-terminal-region')).toBeHidden();
 await tools.locator('summary').click();
 await tools.getByRole('button',{name:'Read session transcript',exact:true}).click();
 await expect(page.locator('#terminal-transcript-output')).toContainText('WPDESKTOP_TOOLS');
 await page.getByRole('button',{name:'Close transcript',exact:true}).click();
 await expect(tools.getByRole('button',{name:'Read session transcript',exact:true})).toBeFocused();
 await page.keyboard.press('Escape');await expect(tools.locator('details')).not.toHaveAttribute('open','');
 await page.getByRole('button',{name:'Restore workspace',exact:true}).click();
 expect(await canvas.evaluate(node=>node===(window as any).__toolsCanvas)).toBe(true);
 expect(sockets).toHaveLength(attached);await expect.poll(tail).toContain('WPDESKTOP_TOOLS');
 expect((await page.locator('#workspace-shell').boundingBox())!.y).toBe((await page.locator('#terminal-view').boundingBox())!.y);
 await page.screenshot({path:info.outputPath('desktop-workspace-tools.png')});
});

test('unpinned workspace tools remain reachable while a settings dialog owns focus',async({page},info)=>{
 test.skip(info.project.name!=='desktop','Desktop sidebar hover and keyboard recovery');
 await page.addInitScript(()=>localStorage.setItem('wolfpack-sidebar-pinned','0'));
 await page.goto(server.baseUrl);
 await page.locator('.card',{hasText:'tools-one'}).filter({visible:true}).first().click();
 await expect(page.locator('#desktop-terminal-container canvas')).toBeVisible();
 await page.keyboard.press('Meta+b');
 await expect(page.locator('#workspace-tools')).toBeVisible();
 await page.mouse.move(700,300);
 await page.keyboard.press('Meta+b');
 await expect(page.locator('#desktop-sidebar')).toHaveClass(/collapsed/);
 const edge=(await page.locator('#sidebar-hover-edge').boundingBox())!;
 // Hovering opens the sidebar and immediately hides this edge, so move the
 // pointer to its measured bounds rather than retrying a disappearing locator.
 await page.mouse.move(edge.x+edge.width/2,edge.y+100);
 await expect(page.locator('#workspace-tools')).toBeVisible();
 await page.locator('#workspace-settings-btn').click();
 await page.mouse.move(700,300);
 // Exercise the actual 300ms auto-collapse deadline while the modal is open.
 await page.waitForTimeout(350);
 await expect(page.locator('#desktop-sidebar')).not.toHaveClass(/collapsed/);
 await page.keyboard.press('Escape');
 await expect(page.locator('#workspace-settings-btn')).toBeFocused();
});

test('desktop controls return to the unchanged mobile toolbar across the breakpoint',async({page},info)=>{
 test.skip(info.project.name!=='desktop','Start desktop and exercise responsive control ownership');
 await page.goto(server.baseUrl);await page.locator('.card',{hasText:'tools-two'}).first().click();
 await expect(page.locator('#desktop-terminal-container canvas')).toBeVisible();
 await expect(page.locator('#workspace-tools')).toBeVisible();
 await page.locator('#workspace-settings-btn').click();
 await page.setViewportSize({width:390,height:844});
 await expect(page.locator('#workspace-settings-dialog')).toBeHidden();
 const toolbar=page.locator('.workspace-terminal-toolbar');await expect(toolbar).toBeVisible();
 await expect(toolbar.locator('#workspace-terminal-layout')).toBeVisible();
 await expect(toolbar.locator('#terminal-transcript-btn')).toBeVisible();
 expect((await toolbar.boundingBox())!.height).toBe(51);
 await expect(page.locator('#workspace-terminal-layout')).toHaveCount(1);
 await expect(toolbar.locator('#workspace-context-collapse')).toHaveAccessibleName('Collapse context panel');
 await toolbar.locator('#workspace-context-collapse').click();
 await toolbar.locator('#workspace-restore').click();
 await page.setViewportSize({width:1280,height:720});
 await expect(toolbar).toBeHidden();await expect(page.locator('#workspace-tools #workspace-context-collapse')).toBeVisible();
 await page.locator('#workspace-settings-btn').click();
 await expect(page.locator('#workspace-settings-dialog #workspace-terminal-layout')).toBeVisible();
});
