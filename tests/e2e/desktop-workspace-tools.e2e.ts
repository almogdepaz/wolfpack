import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start, skipIfNoBroker, type BrokerTestServer } from './broker-helpers.ts';
import { createOwnedTestServerHome, removeOwnedTestServerHome, type OwnedTestServerHome } from './test-server-home.ts';
import { openSettingsFromUi } from './helpers.ts';

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

test('widget controls belong to their panel without global toggles or terminal remount',async({page},info)=>{
 test.skip(info.project.name!=='desktop','Desktop session controls');
 const sockets:string[]=[];page.on('websocket',socket=>{if(socket.url().includes('/ws/pty'))sockets.push(socket.url())});
 await page.goto(server.baseUrl);await page.locator('.card',{hasText:'tools-one'}).first().click();
 const terminal=page.locator('#desktop-terminal-container'), canvas=terminal.locator('canvas');
 await expect(terminal).toHaveAttribute('data-terminal-load-state','live');
 expect(await page.evaluate(()=>({privateView:typeof (window as any).showView,hooks:Object.keys((window as any).__wolfpackTest)}))).toEqual({privateView:'undefined',hooks:['serializeTerminalTail']});
 await expect(page.locator('#workspace-tools, #workspace-settings-dialog, #workspace-session-actions, #terminal-transcript-btn, #workspace-context-collapse, .workspace-terminal-toolbar')).toHaveCount(0);
 await expect(page.locator('#workspace-terminal-region .workspace-context-header:visible')).toHaveCount(0);
 const filter=page.locator('#sidebar-session-controls').getByRole('group',{name:'Session view'});
 const collapse=page.getByRole('button',{name:'Collapse Widgets',exact:true});
 await expect(collapse).toBeVisible();
 await canvas.evaluate(node=>{(window as any).__toolsCanvas=node});
 await collapse.evaluate(node=>{(window as any).__widgetCollapse=node});
 const attached=sockets.length;
 await collapse.click();const restore=page.getByRole('tab',{name:'Widgets',exact:true});
 await expect(restore).toBeVisible();await restore.click();
 await expect(collapse).toBeVisible();
 await filter.getByRole('button',{name:'Idle sessions'}).click();
 await filter.getByRole('button',{name:'All sessions'}).click();
 expect(await collapse.evaluate(node=>node===(window as any).__widgetCollapse)).toBe(true);
 await page.locator('[data-widget-full]:visible').click();await collapse.click();
 await expect(terminal).toBeVisible();await restore.click();
 expect(await canvas.evaluate(node=>node===(window as any).__toolsCanvas)).toBe(true);expect(sockets).toHaveLength(attached);
 await page.getByRole('button',{name:'Expand sessions',exact:true}).click();
 await expect(page.locator('#session-dashboard-controls')).toBeVisible();
 await expect(page.getByRole('button',{name:'Hide widgets',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Collapse sessions',exact:true}).click();
 await expect(collapse).toBeVisible();
 await expect(terminal).toHaveAttribute('data-terminal-load-state','live');
 await page.screenshot({path:info.outputPath('session-controls.png')});
});

test('terminal layout lives in Settings and survives return and reload without a Transcript button',async({page},info)=>{
 await page.goto(server.baseUrl);
 await openSettingsFromUi(page);
 await expect(page.getByRole('region',{name:'Settings',exact:true})).toBeVisible();
 await page.getByRole('link',{name:'Terminal',exact:true}).click();
 const picker=page.locator('#settings-terminal').getByRole('combobox',{name:'Terminal layout',exact:true});
 await expect(picker).toHaveCSS('appearance','auto');await picker.selectOption('lead-stack');
 await page.locator(info.project.name==='desktop'?'#settings-back-btn':'#back-btn').click();
 await page.locator('.card',{hasText:'tools-one'}).filter({visible:true}).first().click();
 await expect(page.locator('#desktop-terminal-container canvas')).toBeVisible();
 await expect(page.locator('#terminal-transcript-btn')).toHaveCount(0);
 await expect(page.locator('.workspace-terminal-toolbar')).toHaveCount(0);
 expect(await page.evaluate(()=>localStorage.getItem('wolfpack-terminal-layout'))).toBe('lead-stack');
 await page.reload();await expect(page.locator('#settings-view')).toBeVisible();
 await expect(picker).toHaveValue('lead-stack');
 await expect(page.locator('.view.visible')).toHaveCount(1);
 await expect(page.locator('#settings-view')).not.toHaveClass(/swiping/);
 await expect(picker).toBeInViewport();
 await page.screenshot({path:info.outputPath('terminal-settings.png')});
});

test('unpinned sidebar retains keyboard Settings access while widgets recover locally',async({page},info)=>{
 test.skip(info.project.name!=='desktop','Desktop hover sidebar');
 await page.addInitScript(()=>localStorage.setItem('wolfpack-sidebar-pinned','0'));
 await page.goto(server.baseUrl);await page.locator('.card',{hasText:'tools-one'}).filter({visible:true}).first().click();
 await expect(page.locator('#desktop-terminal-container')).toHaveAttribute('data-terminal-load-state','live');
 await page.keyboard.press('Meta+b');await expect(page.locator('#sidebar-session-controls')).toBeVisible();
 await page.mouse.move(700,300);await page.keyboard.press('Meta+b');
 await expect(page.locator('#desktop-sidebar')).toHaveClass(/collapsed/);
 const edge=(await page.locator('#sidebar-hover-edge').boundingBox())!;
 await page.mouse.move(edge.x+edge.width/2,edge.y+100);
 const settings=page.locator('#sidebar-settings-btn');await expect(settings).toBeVisible();
 await settings.focus();await page.mouse.move(700,300);
 await expect(page.locator('#desktop-sidebar')).not.toHaveClass(/collapsed/);
 await settings.press('Enter');await expect(page.locator('#settings-view')).toBeVisible();
 await page.locator('#settings-back-btn').click();
 await expect(page.locator('#desktop-terminal-container')).toHaveAttribute('data-terminal-load-state','live');
 const collapse=page.getByRole('button',{name:'Collapse Widgets',exact:true});
 await collapse.focus();await collapse.press('Enter');
 const restore=page.getByRole('tab',{name:'Widgets',exact:true});await expect(restore).toBeVisible();
 await restore.focus();await restore.press('Enter');await expect(collapse).toBeVisible();
});

test('mobile Widgets entry lives in the app header without a terminal toolbar',async({page},info)=>{
 test.skip(info.project.name!=='desktop','Desktop to mobile responsive ownership');
 await page.goto(server.baseUrl);await page.locator('.card',{hasText:'tools-two'}).first().click();
 await expect(page.getByRole('button',{name:'Collapse Widgets',exact:true})).toBeVisible();
 await page.setViewportSize({width:390,height:844});
 const open=page.locator('body > header #workspace-restore');await expect(open).toBeVisible();
 await expect(open).toHaveAccessibleName('Widgets');await open.click();
 await page.getByRole('button',{name:'Back to terminal',exact:true}).click();
 await expect(page.locator('.workspace-terminal-toolbar, #workspace-context-collapse, #terminal-transcript-btn')).toHaveCount(0);
 await page.setViewportSize({width:1280,height:720});
 await expect(open).toBeHidden();await expect(page.getByRole('button',{name:'Collapse Widgets',exact:true})).toBeVisible();
 await expect(page.locator('#workspace-restore')).toHaveCount(1);
});
